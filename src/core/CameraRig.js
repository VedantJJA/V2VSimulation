import * as THREE from 'three';
import { damp, isTypingTarget } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

export const CAMERA_MODES = ['first', 'third'];
const CAMERA = ConfigDefaults.camera;

/**
 * CameraRig — the simulation camera controller.
 *
 * Modes:
 * - 'first': hard-locked cockpit view (fixed windshield offset, yaw-locked).
 * - 'third': exponentially damped chase cam behind/above the vehicle.
 *
 * Toggle with V (own listener; typing in the GUI is exempt). Mode changes
 * emit 'camera:mode-changed' on the EventBus. UPGRADE PATH: raycast
 * pull-in against world/Terrain's BVH so the chase camera never clips.
 */
export class CameraRig {
  /** @param {import('./Engine.js').Engine} engine */
  constructor(engine, { mode = 'third', toggleKey = 'KeyV' } = {}) {
    this._camera = engine.camera;
    this._bus = engine.bus ?? null;
    /** @type {import('../vehicles/Vehicle.js').Vehicle | null} */
    this._target = null;
    this._mode = CAMERA_MODES.includes(mode) ? mode : 'third';
    this._toggleKey = toggleKey;

    this._firstPersonOffset = {
      forwardM: CAMERA.firstPersonForwardM,
      upM: CAMERA.firstPersonUpM,
    };
    this._thirdPerson = {
      distanceM: CAMERA.thirdPersonDistanceM,
      heightM: CAMERA.thirdPersonHeightM,
      lookAheadM: CAMERA.thirdPersonLookAheadM,
      lookHeightM: CAMERA.thirdPersonLookHeightM,
      positionLambda: CAMERA.positionDampLambda,
      targetLambda: CAMERA.targetDampLambda,
      minY: CAMERA.minY,
    };

    this._followPosition = new THREE.Vector3();
    this._lookTarget = new THREE.Vector3();
    this._snapped = false; // snap (not damp) on first attach

    this._onKeyDown = (event) => {
      if (isTypingTarget(event)) return;
      if (event.code === this._toggleKey) this.toggleMode();
    };
    window.addEventListener('keydown', this._onKeyDown);

    // Registered AFTER the vehicle update loop in main.js, so the rig always
    // follows this frame's freshly written vehicle transforms.
    this._unsubscribeUpdate = engine.addUpdate((dt) => this.update(dt));
  }

  get mode() {
    return this._mode;
  }

  get target() {
    return this._target;
  }

  /** Follow a vehicle (snap on the first frame, damp afterwards). */
  attach(vehicle) {
    this._target = vehicle ?? null;
    this._snapped = false;
    return this;
  }

  detach() {
    this._target = null;
    return this;
  }

  setMode(mode) {
    if (!CAMERA_MODES.includes(mode)) {
      throw new Error(`CameraRig: unknown mode "${mode}" (use ${CAMERA_MODES.join(' | ')})`);
    }
    if (mode === this._mode) return;
    this._mode = mode;
    console.info(`[CameraRig] mode → ${mode === 'first' ? 'first person' : 'third person'}`);
    this._bus?.emit('camera:mode-changed', { mode });
  }

  toggleMode() {
    this.setMode(this._mode === 'first' ? 'third' : 'first');
  }

  update(dt) {
    if (!this._target || !this._target.mesh) return;
    const mesh = this._target.mesh;

    // Mesh forward (−Z local) in world — rotation.y was written by
    // Vehicle._applyTransform earlier in this frame's update order.
    const forwardX = -Math.sin(mesh.rotation.y);
    const forwardZ = -Math.cos(mesh.rotation.y);

    if (this._mode === 'first') {
      const eyeX = mesh.position.x + forwardX * this._firstPersonOffset.forwardM;
      const eyeY = mesh.position.y + this._firstPersonOffset.upM;
      const eyeZ = mesh.position.z + forwardZ * this._firstPersonOffset.forwardM;
      this._camera.position.set(eyeX, eyeY, eyeZ);
      // Locked to vehicle yaw; look far down the road with a slight drop.
      this._camera.lookAt(
        eyeX + forwardX * CAMERA.firstPersonLookDistanceM,
        eyeY - CAMERA.firstPersonLookDropM,
        eyeZ + forwardZ * CAMERA.firstPersonLookDistanceM
      );
      return;
    }

    const p = this._thirdPerson;
    const desiredX = mesh.position.x - forwardX * p.distanceM;
    const desiredZ = mesh.position.z - forwardZ * p.distanceM;
    const desiredY = Math.max(p.minY, mesh.position.y + p.heightM);

    if (!this._snapped) {
      this._followPosition.set(desiredX, desiredY, desiredZ);
      this._lookTarget.set(
        mesh.position.x + forwardX * p.lookAheadM,
        mesh.position.y + p.lookHeightM,
        mesh.position.z + forwardZ * p.lookAheadM
      );
      this._snapped = true;
    } else {
      // Exponential damping: frame-rate independent smoothing.
      this._followPosition.x = damp(this._followPosition.x, desiredX, p.positionLambda, dt);
      this._followPosition.y = damp(this._followPosition.y, desiredY, p.positionLambda, dt);
      this._followPosition.z = damp(this._followPosition.z, desiredZ, p.positionLambda, dt);
      this._lookTarget.x = damp(this._lookTarget.x, mesh.position.x + forwardX * p.lookAheadM, p.targetLambda, dt);
      this._lookTarget.y = damp(this._lookTarget.y, mesh.position.y + p.lookHeightM, p.targetLambda, dt);
      this._lookTarget.z = damp(this._lookTarget.z, mesh.position.z + forwardZ * p.lookAheadM, p.targetLambda, dt);
    }

    this._camera.position.copy(this._followPosition);
    this._camera.lookAt(this._lookTarget);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    this._unsubscribeUpdate();
    this._unsubscribeUpdate = null;
    this._target = null;
  }
}