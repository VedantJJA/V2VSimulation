import * as THREE from 'three';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const SENSOR = ConfigDefaults.sensor;
const DEG2RAD = Math.PI / 180;

/**
 * ProximitySensorArray — configurable ring of rays around a vehicle.
 *
 * Each ray starts on a ring of `originRadiusM` in ITS OWN direction at a
 * fixed absolute height `originHeightM` (strictly horizontal — flat roads
 * can never false-trigger; cones, barriers, vehicles, and buildings all
 * intersect the bumper-height plane).
 *
 * update() fills `readings` ({ proximityM, hitKind }) and `raySegments`
 * (consumed by SensorVisualizer and the front camera).
 *
 * BACKENDS (Phase 8): identical public API on both. No GPU engine → per-ray
 * RaycastEngine.castRay. GPU engine set (and healthy) → the array only
 * stages geometry via gpuEngine.submitRays(this); V2VManager batches one
 * dispatch and results land ~1 frame later.
 *
 * autoBeginFrame (default true): call raycastEngine.beginFrame() before
 * casting. Set to false when MANY arrays share one engine — then exactly
 * one caller (V2VManager) must beginFrame once per tick.
 */
export class ProximitySensorArray {
  /**
   * @param {object} options
   * @param {import('./RaycastEngine.js').RaycastEngine} options.raycastEngine CPU backend (always required)
   * @param {import('../vehicles/Vehicle.js').Vehicle} options.vehicle the sensed vehicle (ignored by its own rays)
   * @param {number} [options.maxRangeM] default: ConfigDefaults.sensor.proximityMaxRangeM
   * @param {number} [options.originRadiusM]
   * @param {number} [options.originHeightM]
   * @param {Array<{ name: string, angleDeg: number }>} [options.rays] default: ConfigDefaults.sensor.proximityRays
   * @param {boolean} [options.autoBeginFrame] default true
   */
  constructor({
    raycastEngine,
    vehicle,
    maxRangeM = SENSOR.proximityMaxRangeM,
    originRadiusM = SENSOR.proximityOriginRadiusM,
    originHeightM = SENSOR.proximityOriginHeightM,
    rays = SENSOR.proximityRays,
    autoBeginFrame = true,
  } = {}) {
    if (!raycastEngine) throw new TypeError('ProximitySensorArray: raycastEngine is required');
    if (!vehicle) throw new TypeError('ProximitySensorArray: vehicle is required');

    this.raycastEngine = raycastEngine;
    this.vehicle = vehicle;
    this.maxRangeM = maxRangeM;
    this.originRadiusM = originRadiusM;
    this.originHeightM = originHeightM;
    this.autoBeginFrame = autoBeginFrame;
    this.rays = rays.map((ray) => ({ name: ray.name, angleRad: ray.angleDeg * DEG2RAD }));

    /** @type {import('./GPUCastEngine.js').GPUCastEngine | null} */
    this._gpuEngine = null;

    this.readings = { proximityM: {}, hitKind: {} };
    for (const ray of this.rays) {
      this.readings.proximityM[ray.name] = maxRangeM;
      this.readings.hitKind[ray.name] = 'none';
    }

    /** Last-cast ray geometry — consumed by SensorVisualizer. */
    this.raySegments = this.rays.map((ray) => ({
      name: ray.name,
      angleRad: ray.angleRad,
      origin: new THREE.Vector3(),
      direction: new THREE.Vector3(0, 0, -1),
      hit: null, // { distanceM, point, kind } | null
    }));
  }

  /**
   * Swap the intersection backend (Phase 8). Passing a healthy GPUCastEngine
   * routes casts through the batched GPU pipeline; null restores the
   * per-ray CPU path.
   */
  setGpuEngine(gpuEngine) {
    this._gpuEngine = gpuEngine ?? null;
  }

  /**
   * Cast the full ring.
   * @param {import('../vehicles/IVehicleMotionModel.js').VehicleMotionState} [vehicleState]
   */
  update(vehicleState = this.vehicle.motionModel.getState()) {
    if (this.autoBeginFrame) {
      this.raycastEngine.beginFrame(); // idempotent; safe per-frame
    }

    // Ray geometry (identical on both backends).
    const heading = vehicleState.headingRad;
    for (let i = 0; i < this.rays.length; i++) {
      const ray = this.rays[i];
      const angle = heading + ray.angleRad;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);

      const segment = this.raySegments[i];
      segment.angleRad = angle;
      segment.direction.set(sin, 0, -cos);
      // Ring origin: start the ray at the car's perimeter in its own direction.
      segment.origin.set(
        vehicleState.position.x + sin * this.originRadiusM,
        this.originHeightM,
        vehicleState.position.z - cos * this.originRadiusM
      );
    }

    // GPU backend: stage the ring; results land ~1 frame later.
    const gpuEngine = this._gpuEngine;
    if (gpuEngine && gpuEngine.active) {
      gpuEngine.submitRays(this);
      return this.readings;
    }

    // CPU backend: per-ray casting.
    for (let i = 0; i < this.rays.length; i++) {
      const ray = this.rays[i];
      const segment = this.raySegments[i];
      const hit = this.raycastEngine.castRay({
        origin: segment.origin,
        direction: segment.direction,
        maxRangeM: this.maxRangeM,
        ignoreVehicle: this.vehicle,
      });
      segment.hit = hit;
      this.readings.proximityM[ray.name] = hit ? hit.distanceM : this.maxRangeM;
      this.readings.hitKind[ray.name] = hit ? hit.kind : 'none';
    }
    return this.readings;
  }
}