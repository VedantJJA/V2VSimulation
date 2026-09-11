import { SpatialGrid } from '../buildings/SpatialGrid.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const V2V = ConfigDefaults.v2v;
const VEHICLE_PROXY_HALF = ConfigDefaults.vehicle.vehicleProxyHalf;

/**
 * NeighborIndex — V2V radius queries over all vehicles, built on the
 * Phase-3 SpatialGrid. queryRadius uses closest-point-on-AABB distance (≤
 * center distance — a valid conservative broadphase); exact center
 * distance filters after. Geometry is independent of RaycastEngine's
 * proxies (different cell size/lifecycle).
 */
export class NeighborIndex {
  /**
   * @param {object} [options]
   * @param {number} [options.radiusM] default: ConfigDefaults.v2v.radiusM
   * @param {number} [options.cellSizeM] default: ConfigDefaults.v2v.neighborCellSizeM
   */
  constructor({ radiusM = V2V.radiusM, cellSizeM = V2V.neighborCellSizeM } = {}) {
    this.radiusM = radiusM;
    /** @type {import('../vehicles/Vehicle.js').Vehicle[]} */
    this._vehicles = [];
    /** @type {Map<any, { vehicle, aabb }>} */
    this._proxies = new Map();
    this._grid = new SpatialGrid({ cellSize: cellSizeM, getBounds: (proxy) => proxy.aabb });
  }

  /** Point the index at the live vehicle list (mutations are picked up). */
  setVehicles(vehicles) {
    this._vehicles = vehicles ?? [];
  }

  setRadius(radiusM) {
    this.radiusM = radiusM;
  }

  /** Refresh proxy AABBs — once per frame, after motion updates. */
  update() {
    for (const vehicle of this._vehicles) {
      if (!vehicle?.motionModel) continue;
      this._updateProxy(vehicle, vehicle.motionModel.getState());
    }
  }

  /**
   * Neighbors within `radiusM` of `vehicle` (center-to-center, self
   * excluded), sorted nearest-first: [{ vehicle, distanceM }].
   */
  query(vehicle, radiusM = this.radiusM) {
    const state = vehicle.motionModel.getState();
    const candidates = this._grid.queryRadius(state.position, radiusM);

    const result = [];
    for (const proxy of candidates) {
      const other = proxy.vehicle;
      if (other === vehicle) continue;
      const otherState = other.motionModel.getState();
      const dx = otherState.position.x - state.position.x;
      const dz = otherState.position.z - state.position.z;
      const distanceM = Math.hypot(dx, dz);
      if (distanceM <= radiusM) result.push({ vehicle: other, distanceM });
    }
    result.sort((a, b) => a.distanceM - b.distanceM);
    return result;
  }

  dispose() {
    this._grid.clear();
    this._proxies.clear();
    this._vehicles = [];
  }

  _updateProxy(vehicle, state) {
    let proxy = this._proxies.get(vehicle);
    if (!proxy) {
      proxy = { vehicle, aabb: { minX: 0, minZ: 0, maxX: 0, maxZ: 0 } };
      this._proxies.set(vehicle, proxy);
      this._grid.insert(proxy);
    }

    // right = (cos h, 0, sin h), forward = (sin h, 0, −cos h).
    const h = state.headingRad;
    const cos = Math.cos(h);
    const sin = Math.sin(h);
    const extentX = VEHICLE_PROXY_HALF.width * Math.abs(cos) + VEHICLE_PROXY_HALF.length * Math.abs(sin);
    const extentZ = VEHICLE_PROXY_HALF.width * Math.abs(sin) + VEHICLE_PROXY_HALF.length * Math.abs(cos);
    proxy.aabb.minX = state.position.x - extentX;
    proxy.aabb.maxX = state.position.x + extentX;
    proxy.aabb.minZ = state.position.z - extentZ;
    proxy.aabb.maxZ = state.position.z + extentZ;

    this._grid.update(proxy);
  }
}