import { ProximitySensorArray } from './ProximitySensorArray.js';
import { LaneCenteringSensor } from './LaneCenteringSensor.js';

/**
 * SensorStack — one vehicle's local sensor suite: the proximity ray ring +
 * lane centering, updated together from the vehicle's motion state.
 *
 * Lifecycle: created lazily by V2VManager the first time a vehicle enters
 * the 'active' LOD tier, KEPT, and toggled via setEnabled on demotion —
 * tier flips never allocate. Ego-specific debug extras (ray visualizer,
 * front camera) live outside the stack; main.js wires them to
 * `stack.proximity` / the vehicle.
 *
 * autoBeginFrame defaults to FALSE here: with many stacks, the shared
 * RaycastEngine must be begun exactly once per tick by the V2VManager, not
 * once per sensor. Standalone use can pass true (Phase 6 behavior).
 */
export class SensorStack {
  /**
   * @param {object} options
   * @param {import('./RaycastEngine.js').RaycastEngine} options.raycastEngine
   * @param {import('../road/RoadNetwork.js').RoadNetwork} options.network
   * @param {import('../vehicles/Vehicle.js').Vehicle} options.vehicle
   * @param {(vehicle: any) => ({ segmentId: string, lane: number } | null)} [options.getKnownLane]
   *        NPC lane authority (follower); null → nearest-lane lookup (ego).
   * @param {boolean} [options.autoBeginFrame]
   * @param {object} [options.proximityOptions] forwarded to ProximitySensorArray
   */
  constructor({
    raycastEngine,
    network,
    vehicle,
    getKnownLane = null,
    autoBeginFrame = false,
    proximityOptions = {},
  } = {}) {
    if (!raycastEngine || !network || !vehicle) {
      throw new TypeError('SensorStack: requires { raycastEngine, network, vehicle }');
    }
    this.vehicle = vehicle;
    this.enabled = true;
    this._getKnownLane = getKnownLane;

    this.proximity = new ProximitySensorArray({
      raycastEngine,
      vehicle,
      autoBeginFrame,
      ...proximityOptions,
    });
    this.laneCentering = new LaneCenteringSensor({ network });
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
  }

  /**
   * Update both sensors from the vehicle's current motion state.
   * @returns {{ state, proximity, lane } | null} null while disabled
   */
  update(dt) {
    if (!this.enabled) return null;
    const state = this.vehicle.motionModel.getState();
    this.proximity.update(state);
    const knownLane = this._getKnownLane ? this._getKnownLane(this.vehicle) : null;
    this.laneCentering.update(state, knownLane);
    return { state, proximity: this.proximity.readings, lane: this.laneCentering.readings };
  }

  dispose() {
    // Neither sensor owns GPU resources — nothing to free, just drop refs.
    this.vehicle = null;
    this._getKnownLane = null;
  }
}