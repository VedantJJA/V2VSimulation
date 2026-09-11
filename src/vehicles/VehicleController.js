import { clamp, isTypingTarget } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const CONTROLS = ConfigDefaults.vehicle.controls;

/**
 * VehicleController — keyboard → VehicleControlInput for the ego.
 * WASD/arrows, Space = brake. Steering is slew-rate limited.
 *
 * Phase 10: getControlInput(dt, v2vAlerts) may auto-brake on a CRITICAL ICW
 * behind setAutoBrakeOnCriticalICW (default OFF — the ego is
 * player-controlled; alerts are primarily a HUD concern).
 */
export class VehicleController {
  constructor({
    keyMap = CONTROLS.keyMap,
    steerSlewRate = CONTROLS.steerSlewRate,
    autoBrakeOnCriticalICW = false,
  } = {}) {
    this._keyMap = keyMap;
    this._steerSlewRate = steerSlewRate;
    this.autoBrakeOnCriticalICW = autoBrakeOnCriticalICW;

    this._keys = new Set();
    this._steering = 0; // slewed current steering

    this._mappedCodes = new Set(Object.values(keyMap).flat());

    this._onKeyDown = (event) => {
      if (isTypingTarget(event)) return;
      if (this._mappedCodes.has(event.code)) event.preventDefault();
      this._keys.add(event.code);
    };
    this._onKeyUp = (event) => {
      this._keys.delete(event.code);
    };
    this._onBlur = () => {
      this._keys.clear(); // never leave a key "stuck" after alt-tab
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  /** Auto-brake flag (default off). */
  setAutoBrakeOnCriticalICW(enabled) {
    this.autoBrakeOnCriticalICW = !!enabled;
    return this.autoBrakeOnCriticalICW;
  }

  /**
   * @param {number} [dt]
   * @param {Array<{ type: string, severity: string }>} [v2vAlerts] ego alerts
   * @returns {import('./IVehicleMotionModel.js').VehicleControlInput}
   */
  getControlInput(dt = 1 / 60, v2vAlerts = []) {
    const isDown = (action) => this._keyMap[action].some((code) => this._keys.has(code));

    let throttle = (isDown('forward') ? 1 : 0) - (isDown('backward') ? 1 : 0);
    let brake = isDown('brake') ? 1 : 0;
    const targetSteering = (isDown('right') ? 1 : 0) - (isDown('left') ? 1 : 0);

    const maxDelta = this._steerSlewRate * (dt || 1 / 60);
    this._steering += clamp(targetSteering - this._steering, -maxDelta, maxDelta);

    // Optional V2V reaction: full brake on a CRITICAL intersection warning.
    if (
      this.autoBrakeOnCriticalICW &&
      v2vAlerts.some((alert) => alert.type === 'icw' && alert.severity === 'critical')
    ) {
      throttle = 0;
      brake = 1;
    }

    return {
      throttle: clamp(throttle, -1, 1),
      steering: clamp(this._steering, -1, 1),
      brake: clamp(brake, 0, 1),
    };
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this._keys.clear();
  }
}