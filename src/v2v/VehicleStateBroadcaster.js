import { BSMProtocol } from './BSMProtocol.js';

/**
 * VehicleStateBroadcaster — produces per-vehicle broadcast payloads.
 *
 * broadcastBSM(vehicle, dt, timestampSec): a BSM for ANY vehicle (pure
 * math, no sensors) — the V2VManager calls this for EVERY vehicle each
 * tick; this is the message neighbors receive. Finite-difference dynamics
 * (acceleration, yawRate) come from a per-vehicle previous-state WeakMap.
 *
 * broadcastFrame(vehicle, sensorStack, bsm, timestampSec): the full sensor
 * frame for ACTIVE vehicles — the BSM embedded plus local sensor readings
 * (proximity + lane) plus the V2V-managed lists (v2vNeighbors/v2vLinks/
 * v2vAlerts, attached by V2VManager after delivery).
 */
export class VehicleStateBroadcaster {
  constructor() {
    /** @type {WeakMap<any, { speedMps: number, headingRad: number }>} */
    this._previousStates = new WeakMap();
  }

  /**
   * @param {import('../vehicles/Vehicle.js').Vehicle} vehicle
   * @param {number} dt
   * @param {number} timestampSec
   * @returns {object} BSM
   */
  broadcastBSM(vehicle, dt, timestampSec) {
    const state = vehicle.motionModel.getState();
    const bsm = BSMProtocol.encode(vehicle, state, {
      timestampSec,
      dt,
      lastControlInput: vehicle.lastControlInput,
      previousState: this._previousStates.get(vehicle),
    });
    this._previousStates.set(vehicle, { speedMps: state.speedMps, headingRad: state.headingRad });
    return bsm;
  }

  /**
   * @param {import('../vehicles/Vehicle.js').Vehicle} vehicle
   * @param {import('../sensors/SensorStack.js').SensorStack} sensorStack
   * @param {object} bsm the vehicle's freshly broadcast BSM
   * @param {number} timestampSec
   */
  broadcastFrame(vehicle, sensorStack, bsm, timestampSec) {
    const state = vehicle.motionModel.getState();
    const proximity = sensorStack.proximity.readings;
    const lane = sensorStack.laneCentering.readings;
    return {
      vehicleId: vehicle.id,
      timestampSec,
      pose: {
        x: state.position.x,
        y: state.position.y,
        z: state.position.z,
        headingRad: state.headingRad,
        speedMps: state.speedMps,
      },
      bsm,
      proximityM: { ...proximity.proximityM },
      hitKind: { ...proximity.hitKind },
      lane: { ...lane },
      v2vNeighbors: [], // delivered subset — attached by V2VManager
      v2vLinks: null, // all evaluated candidates — attached by V2VManager
      v2vAlerts: [], // safety alerts — attached by V2VManager
    };
  }
}