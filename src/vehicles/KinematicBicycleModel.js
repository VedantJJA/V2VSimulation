import * as THREE from 'three';
import { clamp } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const BICYCLE = ConfigDefaults.vehicle.bicycle;

/**
 * KinematicBicycleModel — classic bicycle model, no forces, no physics world.
 *
 *   heading += (speed / wheelbase) * tan(steerAngle) * dt
 *   position += forward * speed * dt
 * Positive steerAngle → positive heading rate → right turn.
 *
 * Used by NPC vehicles and optionally by the ego (arcade mode).
 */
export class KinematicBicycleModel {
  constructor({
    position = [0, 0, 0],
    headingRad = 0,
    speedMps = 0,
    wheelbaseM = BICYCLE.wheelbaseM,
    maxSteerRad = BICYCLE.maxSteerRad,
    maxSpeedMps = BICYCLE.maxSpeedMps,
    maxReverseSpeedMps = BICYCLE.maxReverseSpeedMps,
    engineAccelMps2 = BICYCLE.engineAccelMps2,
    brakeDecelMps2 = BICYCLE.brakeDecelMps2,
    coastDecelMps2 = BICYCLE.coastDecelMps2,
  } = {}) {
    if (!(wheelbaseM > 0)) throw new RangeError('KinematicBicycleModel: wheelbaseM must be > 0');

    this.wheelbaseM = wheelbaseM;
    this.maxSteerRad = maxSteerRad;
    this.maxSpeedMps = maxSpeedMps;
    this.maxReverseSpeedMps = maxReverseSpeedMps;
    this.engineAccelMps2 = engineAccelMps2;
    this.brakeDecelMps2 = brakeDecelMps2;
    this.coastDecelMps2 = coastDecelMps2;

    this._state = {
      position: position.isVector3
        ? position.clone()
        : new THREE.Vector3(position[0], position[1] ?? 0, position[2] ?? 0),
      headingRad,
      speedMps,
    };
  }

  getState() {
    return this._state;
  }

  update(dt, input = {}) {
    const throttle = clamp(input.throttle ?? 0, -1, 1);
    const brake = clamp(input.brake ?? 0, 0, 1);
    const steerAngle = clamp(input.steering ?? 0, -1, 1) * this.maxSteerRad;

    // Longitudinal dynamics (accelerate → brake → coast, in priority order).
    let speed = this._state.speedMps;
    if (throttle !== 0) {
      speed += throttle * this.engineAccelMps2 * dt;
    }
    if (brake > 0) {
      const decel = brake * this.brakeDecelMps2 * dt;
      speed = Math.abs(speed) <= decel ? 0 : speed - Math.sign(speed) * decel;
    } else if (throttle === 0) {
      const decel = this.coastDecelMps2 * dt;
      speed = Math.abs(speed) <= decel ? 0 : speed - Math.sign(speed) * decel;
    }
    speed = clamp(speed, -this.maxReverseSpeedMps, this.maxSpeedMps);
    this._state.speedMps = speed;

    // Yaw + position integration (compass convention: +steer = +heading).
    this._state.headingRad += (speed / this.wheelbaseM) * Math.tan(steerAngle) * dt;
    const h = this._state.headingRad;
    this._state.position.x += Math.sin(h) * speed * dt;
    this._state.position.z += -Math.cos(h) * speed * dt;

    return this._state;
  }
}