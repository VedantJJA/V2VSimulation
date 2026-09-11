import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { SpatialGrid } from '../buildings/SpatialGrid.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

// Install three-mesh-bvh globally (standard usage). Meshes whose geometry
// has a boundsTree raycast through the BVH; everything else falls back to
// the original Mesh.raycast, so editor picks/gizmos are unaffected.
THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

const VEHICLE_PROXY_HALF = ConfigDefaults.vehicle.vehicleProxyHalf;

/**
 * RaycastEngine — CPU raycasting with a static/dynamic split.
 *
 * STATIC (roads, buildings, obstructions): BVH-accelerated mesh raycasts;
 * beginFrame() self-heals the registry (removed meshes dropped, swapped
 * geometries re-BVH'd).
 *
 * DYNAMIC vehicles: never mesh-raycast — cheap analytic OBB proxies
 * (half-extents from ConfigDefaults.vehicle.vehicleProxyHalf) broadphased
 * by the Phase-3 SpatialGrid, then a 3-axis slab test. The ego is excluded
 * per cast via ignoreVehicle.
 *
 * castRay returns { distanceM, point, kind: 'static'|'vehicle', object }
 * or null.
 */
export class RaycastEngine {
  constructor({ dynamicCellSizeM = ConfigDefaults.sensor.dynamicGridCellSizeM } = {}) {
    this._raycaster = new THREE.Raycaster();
    this._raycaster.near = 0;
    this._raycaster.firstHitOnly = true; // three-mesh-bvh: nearest hit only

    /** @type {Set<THREE.Mesh>} */
    this._staticMeshes = new Set();
    this._staticGeometry = new Map(); // mesh -> geometry the BVH was built for
    this._staticArray = null; // cached array for intersectObjects

    /** @type {import('../vehicles/Vehicle.js').Vehicle[]} */
    this._dynamicVehicles = [];
    this._proxies = new Map(); // vehicle -> proxy (stable objects, mutated in place)
    this._dynamicGrid = new SpatialGrid({
      cellSize: dynamicCellSizeM,
      getBounds: (proxy) => proxy.aabb,
    });
  }

  /** Register a static mesh (idempotent); computes its bounds tree. */
  registerStatic(mesh) {
    if (!mesh || !mesh.isMesh || this._staticMeshes.has(mesh)) return;
    if (mesh.geometry && !mesh.geometry.boundsTree) mesh.geometry.computeBoundsTree();
    this._staticMeshes.add(mesh);
    this._staticGeometry.set(mesh, mesh.geometry);
    this._staticArray = null;
  }

  /** Unregister a static mesh (its geometry's BVH is freed with it). */
  unregisterStatic(mesh) {
    if (this._staticMeshes.delete(mesh)) {
      mesh.geometry?.disposeBoundsTree?.();
      this._staticGeometry.delete(mesh);
      this._staticArray = null;
    }
  }

  /**
   * Vehicles sensed as dynamic obstacles. Pass the live vehicle list; poses
   * are re-read every beginFrame().
   */
  setDynamicVehicles(vehicles) {
    this._dynamicVehicles = vehicles ?? [];
  }

  /**
   * Once per frame, BEFORE casting: heal the static registry and refresh the
   * dynamic proxies + broadphase. Idempotent and cheap.
   */
  beginFrame() {
    for (const mesh of [...this._staticMeshes]) {
      if (!mesh.parent) {
        this.unregisterStatic(mesh); // removed from the scene since last frame
        continue;
      }
      if (this._staticGeometry.get(mesh) !== mesh.geometry) {
        if (!mesh.geometry.boundsTree) mesh.geometry.computeBoundsTree();
        this._staticGeometry.set(mesh, mesh.geometry); // rebuilt (lane change)
      }
    }

    for (const vehicle of this._dynamicVehicles) {
      if (!vehicle || !vehicle.motionModel) continue;
      this._updateProxy(vehicle, vehicle.motionModel.getState());
    }
  }

  /**
   * Cast one ray.
   * @param {object} options
   * @param {THREE.Vector3} options.origin
   * @param {THREE.Vector3} options.direction unit vector
   * @param {number} options.maxRangeM
   * @param {import('../vehicles/Vehicle.js').Vehicle} [options.ignoreVehicle]
   * @returns {{ distanceM: number, point: THREE.Vector3, kind: 'static' | 'vehicle', object: any } | null}
   */
  castRay({ origin, direction, maxRangeM, ignoreVehicle = null }) {
    let best = null;

    // ---- Static: BVH-accelerated mesh raycast --------------------------------
    if (this._staticMeshes.size > 0) {
      this._raycaster.far = maxRangeM;
      this._raycaster.set(origin, direction);
      const hits = this._raycaster.intersectObjects(this._getStaticArray(), false);
      const hit = hits[0]; // firstHitOnly per mesh + sorted by distance
      if (hit && hit.distance <= maxRangeM) {
        best = { distanceM: hit.distance, point: hit.point.clone(), kind: 'static', object: hit.object };
      }
    }

    // ---- Dynamic: grid broadphase + analytic ray-vs-OBB -----------------------
    const dynamic = this._castDynamic(origin, direction, maxRangeM, ignoreVehicle);
    if (dynamic && (!best || dynamic.distanceM < best.distanceM)) {
      best = dynamic;
    }

    return best;
  }

  dispose() {
    this._staticMeshes.clear();
    this._staticGeometry.clear();
    this._staticArray = null;
    this._dynamicVehicles = [];
    this._proxies.clear();
    this._dynamicGrid.clear();
  }

  _castDynamic(origin, direction, maxRangeM, ignoreVehicle) {
    if (this._dynamicVehicles.length === 0) return null;

    // Broadphase: only proxies whose AABB touches the ray segment's box.
    const endX = origin.x + direction.x * maxRangeM;
    const endZ = origin.z + direction.z * maxRangeM;
    const candidates = this._dynamicGrid.queryAABB({
      minX: Math.min(origin.x, endX),
      maxX: Math.max(origin.x, endX),
      minZ: Math.min(origin.z, endZ),
      maxZ: Math.max(origin.z, endZ),
    });

    let best = null;
    for (const proxy of candidates) {
      if (proxy.vehicle === ignoreVehicle) continue;
      const t = this._rayOBB(origin, direction, proxy);
      if (t === null || t > maxRangeM) continue;
      if (!best || t < best.distanceM) {
        best = {
          distanceM: t,
          point: origin.clone().addScaledVector(direction, t),
          kind: 'vehicle',
          object: proxy.vehicle,
        };
      }
    }
    return best;
  }

  /** Analytic ray-vs-OBB (slab test on the proxy's right/up/forward axes). */
  _rayOBB(origin, direction, proxy) {
    const px = origin.x - proxy.cx;
    const py = origin.y - proxy.cy;
    const pz = origin.z - proxy.cz;

    const axes = [
      [proxy.axisX.x, 0, proxy.axisX.z, proxy.halfW], // right
      [0, 1, 0, proxy.halfH], // up
      [proxy.axisZ.x, 0, proxy.axisZ.z, proxy.halfL], // forward
    ];

    let tMin = 0;
    let tMax = Infinity;
    for (const [ax, ay, az, half] of axes) {
      const denom = direction.x * ax + direction.y * ay + direction.z * az;
      const dist = px * ax + py * ay + pz * az;
      if (Math.abs(denom) < 1e-9) {
        if (Math.abs(dist) > half) return null; // parallel, outside this slab
        continue;
      }
      let t1 = (half - dist) / denom;
      let t2 = (-half - dist) / denom;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return null;
    }
    return tMin; // 0 when the origin is inside the proxy
  }

  /** Refresh (or create) a vehicle proxy from its current motion state. */
  _updateProxy(vehicle, state) {
    let proxy = this._proxies.get(vehicle);
    if (!proxy) {
      proxy = {
        vehicle,
        cx: 0, cy: 0, cz: 0,
        axisX: { x: 1, z: 0 }, // right
        axisZ: { x: 0, z: -1 }, // forward
        halfW: VEHICLE_PROXY_HALF.width,
        halfH: VEHICLE_PROXY_HALF.height,
        halfL: VEHICLE_PROXY_HALF.length,
        aabb: { minX: 0, minZ: 0, maxX: 0, maxZ: 0 },
      };
      this._proxies.set(vehicle, proxy);
      this._dynamicGrid.insert(proxy);
    }

    const heading = state.headingRad;
    const sin = Math.sin(heading);
    const cos = Math.cos(heading);
    proxy.cx = state.position.x;
    proxy.cy = state.position.y;
    proxy.cz = state.position.z;
    proxy.axisX.x = cos;
    proxy.axisX.z = sin; // right = (cos h, 0, sin h)
    proxy.axisZ.x = sin;
    proxy.axisZ.z = -cos; // forward = (sin h, 0, −cos h)

    const extentX = proxy.halfW * Math.abs(proxy.axisX.x) + proxy.halfL * Math.abs(proxy.axisZ.x);
    const extentZ = proxy.halfW * Math.abs(proxy.axisX.z) + proxy.halfL * Math.abs(proxy.axisZ.z);
    proxy.aabb.minX = proxy.cx - extentX;
    proxy.aabb.maxX = proxy.cx + extentX;
    proxy.aabb.minZ = proxy.cz - extentZ;
    proxy.aabb.maxZ = proxy.cz + extentZ;

    this._dynamicGrid.update(proxy);
  }

  _getStaticArray() {
    if (!this._staticArray) this._staticArray = [...this._staticMeshes];
    return this._staticArray;
  }
}