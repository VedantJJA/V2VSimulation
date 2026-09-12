import { clamp, isTypingTarget } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';
const CONTROLS = ConfigDefaults.vehicle.controls;

/**
 * VehicleController — keyboard → VehicleControlInput for the ego.
 * WASD/arrows, Space = brake. Steering is slew-rate limited.
 * Supports autonomous "Auto Drive" mode with sensor-based navigation.
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

    /** @type {import('./AutoDriveController.js').AutoDriveController | null} */
    this.autoDriveController = null;
    this.autoDriveEnabled = false;
    this.onDriverTakeover = null;
    this.onAutoDriveDisengaged = null;
    this.onAutoDriveToggled = null;
    this.onCycleCamera = null;
    this.onGamepadConnected = null;

    this._keys = new Set();
    this._steering = 0; // slewed current steering
    this._holdingBrake = false;
    this._prevGamepadToggle = false;
    this._prevGamepadCamera = false;

    this._mappedCodes = new Set(Object.values(keyMap).flat());

    this._onKeyDown = (event) => {
      if (isTypingTarget(event)) return;
      if (this._mappedCodes.has(event.code)) event.preventDefault();
      this._keys.add(event.code);
      if (this._holdingBrake) this._holdingBrake = false;
    };
    this._onKeyUp = (event) => {
      this._keys.delete(event.code);
    };
    this._onBlur = () => {
      this._keys.clear(); // never leave a key "stuck" after alt-tab
    };

    this._onGamepadConnected = (e) => {
      console.log(`[controller] Gamepad connected: ${e.gamepad.id}`);
      this.onGamepadConnected?.(e.gamepad);
      this.playHaptic(0.4, 150);
    };
    this._onGamepadDisconnected = (e) => {
      console.log(`[controller] Gamepad disconnected: ${e.gamepad.id}`);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', this._onGamepadConnected);
    window.addEventListener('gamepaddisconnected', this._onGamepadDisconnected);
  }

  /**
   * Poll active Gamepad for analog sticks, triggers, and action buttons.
   * Standard mapping: Left Stick = Steer, RT = Throttle, LT = Brake/Reverse,
   * Y / RB = Auto Drive Toggle, LB = Camera View Toggle.
   * @private
   */
  _pollGamepadInput() {
    const gamepads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (let i = 0; i < gamepads.length; i++) {
      if (gamepads[i] && gamepads[i].connected) {
        gp = gamepads[i];
        break;
      }
    }
    if (!gp) return null;

    // 1. Steering: Left Thumbstick X (axis 0) with deadzone & fine sensitivity curve
    let steer = 0;
    const stickX = gp.axes[0] ?? 0;
    const DEADZONE = 0.08;
    if (Math.abs(stickX) > DEADZONE) {
      const sign = Math.sign(stickX);
      const mag = (Math.abs(stickX) - DEADZONE) / (1.0 - DEADZONE);
      steer = sign * Math.pow(mag, 1.15);
    }
    // D-Pad Left (button 14) / Right (button 15)
    if (gp.buttons[14]?.pressed) steer = -1.0;
    if (gp.buttons[15]?.pressed) steer = 1.0;

    // 2. Throttle: Right Trigger RT (button 7) or Button A (button 0) or D-Pad Up (button 12)
    let throttle = 0;
    const rtVal = gp.buttons[7]?.value ?? (gp.buttons[7]?.pressed ? 1 : 0);
    if (rtVal > 0.04) throttle = rtVal;
    if (gp.buttons[0]?.pressed) throttle = Math.max(throttle, 1.0); // Button A / Cross
    if (gp.buttons[12]?.pressed) throttle = Math.max(throttle, 1.0); // D-Pad Up

    // 3. Brake: Left Trigger LT (button 6) or Button B (button 1) or Button X (button 2)
    let brake = 0;
    const ltVal = gp.buttons[6]?.value ?? (gp.buttons[6]?.pressed ? 1 : 0);
    if (ltVal > 0.04) brake = ltVal;
    if (gp.buttons[1]?.pressed || gp.buttons[2]?.pressed) brake = Math.max(brake, 1.0); // Button B / X
    if (gp.buttons[13]?.pressed) brake = Math.max(brake, 1.0); // D-Pad Down

    // 4. Action Buttons
    const toggleBtn = !!(gp.buttons[3]?.pressed || gp.buttons[5]?.pressed || gp.buttons[8]?.pressed); // Y / Triangle, RB, View/Back
    const cameraBtn = !!(gp.buttons[4]?.pressed || gp.buttons[11]?.pressed); // LB, Right Stick Click

    return {
      steer: clamp(steer, -1, 1),
      throttle: clamp(throttle, 0, 1),
      brake: clamp(brake, 0, 1),
      toggleBtn,
      cameraBtn,
      hasInput: Math.abs(steer) > 0.05 || throttle > 0.05 || brake > 0.05,
    };
  }

  /**
   * Trigger haptic vibration on connected gamepad controller.
   * @param {number} [intensity] 0.0 to 1.0
   * @param {number} [durationMs] duration in milliseconds
   */
  playHaptic(intensity = 0.5, durationMs = 150) {
    const gamepads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of gamepads) {
      if (gp?.vibrationActuator?.playEffect) {
        gp.vibrationActuator
          .playEffect('dual-rumble', {
            startDelay: 0,
            duration: durationMs,
            weakMagnitude: clamp(intensity * 0.7, 0, 1),
            strongMagnitude: clamp(intensity, 0, 1),
          })
          .catch(() => {});
      }
    }
  }

  /** Auto-brake flag (default off). */
  setAutoBrakeOnCriticalICW(enabled) {
    this.autoBrakeOnCriticalICW = !!enabled;
    return this.autoBrakeOnCriticalICW;
  }

  /** Set auto-drive controller for autonomous waypoint navigation */
  setAutoDriveController(controller) {
    this.autoDriveController = controller;
  }

  /**
   * Toggle auto-drive mode.
   * @param {boolean} enabled
   * @param {object} [ego] ego vehicle (needed for egoState)
   * @returns {{ enabled: boolean, status: string }}
   */
  toggleAutoDrive(enabled, ego = null) {
    this.autoDriveEnabled = !!enabled;
    this._holdingBrake = false;
    if (this.autoDriveController) {
      const result = this.autoDriveController.setEnabled(this.autoDriveEnabled);
      if (!this.autoDriveEnabled) {
        this._steering = 0; // reset manual steering on disengage
      }
      return result;
    }
    return { enabled: false, status: 'NO_CONTROLLER' };
  }

  /**
   * @param {number} [dt]
   * @param {Array<{ type: string, severity: string }>} [v2vAlerts] ego alerts
   * @param {object} [sensorData]
   * @param {number} [timeSec]
   * @param {object} [ego] ego vehicle for auto-drive state access
   * @returns {import('./IVehicleMotionModel.js').VehicleControlInput}
   */
  getControlInput(dt = 1 / 60, v2vAlerts = [], sensorData = {}, timeSec = 0, ego = null) {
    // ── Gamepad Controller Input Polling ─────────────────────────────
    const gpInput = this._pollGamepadInput();

    // Gamepad button edge detection for Auto-Drive toggle (Button Y / RB)
    if (gpInput?.toggleBtn && !this._prevGamepadToggle) {
      this.toggleAutoDrive(!this.autoDriveEnabled, ego);
      this.onAutoDriveToggled?.(this.autoDriveEnabled);
      this.playHaptic(0.5, 120);
    }
    this._prevGamepadToggle = gpInput?.toggleBtn ?? false;

    // Gamepad button edge detection for Camera toggle (Button LB)
    if (gpInput?.cameraBtn && !this._prevGamepadCamera) {
      this.onCycleCamera?.();
      this.playHaptic(0.3, 80);
    }
    this._prevGamepadCamera = gpInput?.cameraBtn ?? false;

    // ── Driver Manual Input Detection (Keyboard + Gamepad) ───────────
    const isDown = (action) => this._keyMap[action].some((code) => this._keys.has(code));

    let throttle = (isDown('forward') ? 1 : 0) - (isDown('backward') ? 1 : 0);
    let brake = isDown('brake') ? 1 : 0;
    let targetSteering = (isDown('right') ? 1 : 0) - (isDown('left') ? 1 : 0);

    // Merge Gamepad analog values
    if (gpInput) {
      if (gpInput.throttle > 0) throttle = Math.max(throttle, gpInput.throttle);
      if (gpInput.brake > 0) brake = Math.max(brake, gpInput.brake);
      if (Math.abs(gpInput.steer) > 0.05) targetSteering = gpInput.steer;
    }

    const hasManualInput = Math.abs(throttle) > 0.05 || brake > 0.05 || Math.abs(targetSteering) > 0.05;

    // ── DESTINATION ARRIVAL BRAKE HOLD ───────────────────────────────
    // If vehicle arrived at destination, lock holding brake firmly until driver provides input
    if (this._holdingBrake) {
      if (hasManualInput) {
        this._holdingBrake = false; // Release hold on manual takeover
      } else {
        return { throttle: 0, steering: 0, brake: 1.0 };
      }
    }

    // ── AUTO-DRIVE MODE (with Seamless Driver Takeover) ──────────────
    if (this.autoDriveEnabled && this.autoDriveController && this.autoDriveController.enabled) {
      if (hasManualInput) {
        // Driver takes over control! Disengage Auto Drive smoothly
        this.toggleAutoDrive(false, ego);
        this.onDriverTakeover?.();
        this.playHaptic(0.4, 120);
      } else {
        const egoState = ego?.motionModel?.getState?.() ?? null;
        const autoInput = this.autoDriveController.update(dt, sensorData, egoState);

        // If auto-drive disengaged itself (arrived at destination), lock holding brake!
        if (!this.autoDriveController.enabled) {
          this.autoDriveEnabled = false;
          if (this.autoDriveController.status === 'ARRIVED') {
            this._holdingBrake = true;
          }
          this.onAutoDriveDisengaged?.(this.autoDriveController.status);
        }

        return autoInput;
      }
    }

    // ── MANUAL MODE ──────────────────────────────────────────────────
    // Realistic trigger-based reverse at standstill (holding LT / brake when stopped reverses car)
    const egoSpeed = ego?.motionModel?.getState?.()?.speedMps ?? 0;
    if (egoSpeed < 0.4 && brake > 0.1 && throttle === 0) {
      throttle = -brake;
      brake = 0;
    }

    const slew = targetSteering === 0 ? this._steerSlewRate * 1.6 : this._steerSlewRate;
    const maxDelta = slew * (dt || 1 / 60);
    this._steering += clamp(targetSteering - this._steering, -maxDelta, maxDelta);

    const rawInput = {
      throttle: clamp(throttle, -1, 1),
      steering: clamp(this._steering, -1, 1),
      brake: clamp(brake, 0, 1),
    };

    // Optional legacy V2V reaction: full brake on a CRITICAL intersection warning.
    if (
      this.autoBrakeOnCriticalICW &&
      v2vAlerts.some((alert) => alert.type === 'icw' && alert.severity === 'critical')
    ) {
      rawInput.throttle = 0;
      rawInput.brake = 1;
    }

    return rawInput;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('gamepadconnected', this._onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this._onGamepadDisconnected);
    this._keys.clear();
    this.autoDriveController?.dispose?.();
    this.autoDriveController = null;
  }
}