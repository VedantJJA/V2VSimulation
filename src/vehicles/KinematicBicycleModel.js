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

    // S / Down key acts as brake while moving forward (> 0.4 m/s); once stopped it reverses
    let effThrottle = throttle;
    let effBrake = brake;
    if (speed > 0.4 && throttle < 0) {
      effBrake = Math.max(effBrake, Math.abs(throttle));
      effThrottle = 0;
    }

    if (effBrake > 0) {
      const decel = effBrake * Math.max(this.brakeDecelMps2, 14) * dt;
      speed = Math.abs(speed) <= decel ? 0 : speed - Math.sign(speed) * decel;
      // Absolute stop clamp: when braking firmly at low speed, lock to zero
      if (effBrake >= 0.85 && Math.abs(speed) < 0.35) {
        speed = 0;
      }
    } else if (effThrottle !== 0) {
      speed += effThrottle * this.engineAccelMps2 * dt;
    } else {
      // Realistic rolling resistance + aero drag so the car does not glide on ice
      const aeroDrag = 0.0035 * speed * speed;
      const rollingResistance = 3.2;
      const decel = (rollingResistance + aeroDrag) * dt;
      speed = Math.abs(speed) <= decel ? 0 : speed - Math.sign(speed) * decel;
    }
    speed = clamp(speed, -this.maxReverseSpeedMps, this.maxSpeedMps);
    this._state.speedMps = speed;

    // Realistic speed-dependent steering and lateral tire grip
    const absSpeed = Math.abs(speed);
    // Exponential steering curve gives fine precision on straight roads while allowing full lock
    const steerRatio = Math.abs(this.maxSteerRad) > 1e-4 ? steerAngle / this.maxSteerRad : 0;
    const steerInput = Math.sign(steerAngle) * Math.pow(Math.abs(steerRatio), 1.15) * this.maxSteerRad;

    // At low speeds (< 5 m/s) allow full steering angle for tight intersection turns (~4-5m radius)
    // Speed factor gently fades steering authority as speed rises
    const speedFactor = 1 / (1 + Math.max(0, absSpeed - 4.5) * 0.045);
    const effSteerAngle = steerInput * speedFactor;

    // Lateral grip limit (prevents unrealistic spinning out at speed)
    const rawYawRate = (speed / this.wheelbaseM) * Math.tan(effSteerAngle);
    const maxYawRate = 9.5 / Math.max(1.0, absSpeed);
    const yawRate = clamp(rawYawRate, -maxYawRate, maxYawRate);

    this._state.headingRad += yawRate * dt;
    const h = this._state.headingRad;
    this._state.position.x += Math.sin(h) * speed * dt;
    this._state.position.z += -Math.cos(h) * speed * dt;

    return this._state;
  }
}