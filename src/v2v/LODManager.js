import { clamp } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

export const LOD_TIERS = ['active', 'passive', 'culled'];
const LOD = ConfigDefaults.lod;

/**
 * LODManager — per-tick tier assignment AND tier-driven vehicle stepping.
 *
 * Tiers: 'active' (full motion + sensor stack + V2V; ego always, plus the N
 * NPCs nearest the ego when promoteNearestN > 0), 'passive' (full motion,
 * rendered, no sensors), 'culled' (stepped only every
 * coarseUpdateIntervalSec with the accumulated dt). Hysteresis around
 * cullRadiusM prevents boundary thrashing; sensor stacks are created once
 * and toggled, so tier flips never allocate.
 */
export class LODManager {
  /**
   * @param {object} options
   * @param {import('../vehicles/Vehicle.js').Vehicle[]} options.vehicles live list (may grow)
   * @param {import('../vehicles/Vehicle.js').Vehicle} [options.ego]
   * @param {number} [options.promoteNearestN]
   * @param {number} [options.cullRadiusM]
   * @param {number} [options.hysteresisMarginM]
   * @param {number} [options.coarseUpdateIntervalSec]
   */
  constructor({
    vehicles,
    ego = null,
    promoteNearestN = 0,
    cullRadiusM = LOD.cullRadiusM,
    hysteresisMarginM = LOD.hysteresisMarginM,
    coarseUpdateIntervalSec = LOD.coarseUpdateIntervalSec,
  } = {}) {
    this._vehicles = vehicles ?? [];
    this._ego = ego ?? null;
    this._promoteNearestN = clamp(Math.round(promoteNearestN), 0, LOD.promoteNearestNMax);
    this.cullRadiusM = cullRadiusM;
    this.hysteresisMarginM = hysteresisMarginM;
    this.coarseUpdateIntervalSec = coarseUpdateIntervalSec;

    /** @type {Map<import('../vehicles/Vehicle.js').Vehicle, string>} */
    this._tiers = new Map();
    /** @type {Map<import('../vehicles/Vehicle.js').Vehicle, number>} */
    this._coarseAccumulators = new Map();
    /** @type {import('../vehicles/Vehicle.js').Vehicle[]} */
    this.activeVehicles = [];
    this.tierCounts = { active: 0, passive: 0, culled: 0 };
  }

  get promoteNearestN() {
    return this._promoteNearestN;
  }

  /** The spec's promotion flag — N nearest NPCs to the ego become active. */
  setPromoteNearestN(n) {
    this._promoteNearestN = clamp(Math.round(n), 0, LOD.promoteNearestNMax);
    return this._promoteNearestN;
  }

  getTier(vehicle) {
    return this._tiers.get(vehicle) ?? 'passive';
  }

  /** Assign tiers, then step every vehicle according to its tier. */
  update(dt) {
    this._assignTiers();
    this._stepVehicles(dt);
    return this.tierCounts;
  }

  _assignTiers() {
    const vehicles = this._vehicles;

    // Active set: ego + the N nearest NPCs to the ego (when promoted).
    const promoted = new Set();
    if (this._promoteNearestN > 0 && this._ego) {
      const egoPosition = this._ego.motionModel.getState().position;
      const npcs = vehicles.filter((v) => v !== this._ego && v?.motionModel);
      npcs.sort((a, b) => {
        const pa = a.motionModel.getState().position;
        const pb = b.motionModel.getState().position;
        return (
          (pa.x - egoPosition.x) ** 2 + (pa.z - egoPosition.z) ** 2 -
          ((pb.x - egoPosition.x) ** 2 + (pb.z - egoPosition.z) ** 2)
        );
      });
      for (let i = 0; i < Math.min(this._promoteNearestN, npcs.length); i++) {
        promoted.add(npcs[i]);
      }
    }

    const activeSet = new Set(promoted);
    if (this._ego) activeSet.add(this._ego);
    this.activeVehicles = vehicles.filter((v) => activeSet.has(v));
    const hasActive = this.activeVehicles.length > 0;
    const activePositions = this.activeVehicles.map((v) => v.motionModel.getState().position);

    const counts = { active: 0, passive: 0, culled: 0 };
    for (const vehicle of vehicles) {
      let tier;
      if (activeSet.has(vehicle)) {
        tier = 'active';
      } else if (!hasActive) {
        tier = 'passive'; // no anchor: keep the world alive
      } else {
        const p = vehicle.motionModel.getState().position;
        let nearestDistSq = Infinity;
        for (const ap of activePositions) {
          const dx = p.x - ap.x;
          const dz = p.z - ap.z;
          const distSq = dx * dx + dz * dz;
          if (distSq < nearestDistSq) nearestDistSq = distSq;
        }
        // Hysteresis: culled re-enters at cullRadiusM; passive demotes only
        // past cullRadiusM + margin.
        const current = this._tiers.get(vehicle);
        const threshold =
          current === 'culled' ? this.cullRadiusM : this.cullRadiusM + this.hysteresisMarginM;
        tier = Math.sqrt(nearestDistSq) <= threshold ? 'passive' : 'culled';
      }
      this._tiers.set(vehicle, tier);
      counts[tier] += 1;
    }
    this.tierCounts = counts;
  }

  _stepVehicles(dt) {
    for (const vehicle of this._vehicles) {
      const tier = this._tiers.get(vehicle) ?? 'passive';
      if (tier === 'culled') {
        const acc = (this._coarseAccumulators.get(vehicle) ?? 0) + dt;
        if (acc >= this.coarseUpdateIntervalSec) {
          vehicle.update(acc); // one coarse step with the accumulated time
          this._coarseAccumulators.set(vehicle, 0);
        } else {
          this._coarseAccumulators.set(vehicle, acc);
        }
      } else {
        this._coarseAccumulators.set(vehicle, 0);
        vehicle.update(dt); // active + passive: full per-frame update
      }
    }
  }
}