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

    // GTA-style orbital camera controls in 3rd-person view
    this._orbitYaw = 0;
    this._orbitPitch = 0;
    this._zoomDistance = CAMERA.thirdPersonDistanceM;
    this._isDragging = false;
    this._dragStart = { x: 0, y: 0 };
    this._recenterDelayTimer = 0;

    const dom = engine.renderer.domElement;
    this._dom = dom;
    this._onPointerDown = (event) => {
      if (this._mode !== 'third') return;
      this._isDragging = true;
      this._dragStart.x = event.clientX;
      this._dragStart.y = event.clientY;
    };
    this._onPointerMove = (event) => {
      if (!this._isDragging || this._mode !== 'third') return;
      const dx = event.clientX - this._dragStart.x;
      const dy = event.clientY - this._dragStart.y;
      this._dragStart.x = event.clientX;
      this._dragStart.y = event.clientY;
      this._orbitYaw -= dx * 0.005;
      this._orbitPitch = Math.max(-0.35, Math.min(1.2, this._orbitPitch + dy * 0.004));
      this._recenterDelayTimer = 1.8;
    };
    this._onPointerUp = () => {
      this._isDragging = false;
    };
    this._onWheel = (event) => {
      if (this._mode !== 'third') return;
      this._zoomDistance = Math.max(3.5, Math.min(18.0, this._zoomDistance + event.deltaY * 0.005));
    };

    dom.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    dom.addEventListener('wheel', this._onWheel, { passive: true });

    this._onKeyDown = (event) => {
      if (isTypingTarget(event)) return;
      if (event.code === 'KeyC' || event.code === 'KeyV' || event.code === this._toggleKey) {
        this.toggleMode();
      }
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

    // Mesh forward (−Z local) and right (+X local) in world space
    const forwardX = -Math.sin(mesh.rotation.y);
    const forwardZ = -Math.cos(mesh.rotation.y);
    const rightX = Math.cos(mesh.rotation.y);
    const rightZ = -Math.sin(mesh.rotation.y);

    if (this._mode === 'first') {
      // Driver seat position: left-hand drive (local X = -0.36, Y = 0.68, Z = 0.16)
      const eyeX = mesh.position.x + rightX * -0.36 - forwardX * 0.16;
      const eyeY = mesh.position.y + 0.68;
      const eyeZ = mesh.position.z + rightZ * -0.36 - forwardZ * 0.16;
      this._camera.position.set(eyeX, eyeY, eyeZ);

      // Look out through the windshield down the road, with slight downward pitch
      // so the steering wheel and instrument cluster are nicely framed
      this._camera.lookAt(
        eyeX + forwardX * 40,
        eyeY - 1.2,
        eyeZ + forwardZ * 40
      );
      return;
    }

    const p = this._thirdPerson;

    // Auto-recenter behind the car if moving and not actively dragging
    const state = this._target.motionModel?.getState?.();
    const speed = Math.abs(state?.speedMps ?? 0);
    if (!this._isDragging && speed > 1.2) {
      this._recenterDelayTimer -= dt;
      if (this._recenterDelayTimer <= 0) {
        this._orbitYaw = damp(this._orbitYaw, 0, 2.5, dt);
        this._orbitPitch = damp(this._orbitPitch, 0, 2.5, dt);
      }
    }

    // Effective orbital angle combining car heading + orbital yaw/pitch
    const totalYaw = mesh.rotation.y + this._orbitYaw;
    const distH = this._zoomDistance * Math.cos(this._orbitPitch);
    const camHeight = p.heightM + this._zoomDistance * Math.sin(this._orbitPitch);

    const desiredX = mesh.position.x + Math.sin(totalYaw) * distH;
    const desiredZ = mesh.position.z + Math.cos(totalYaw) * distH;
    const desiredY = Math.max(p.minY, mesh.position.y + camHeight);

    // Look target smoothly tracks the car center with subtle forward look-ahead
    const lookAhead = p.lookAheadM * Math.cos(this._orbitYaw) * 0.4;
    const targetX = mesh.position.x - Math.sin(mesh.rotation.y) * lookAhead;
    const targetZ = mesh.position.z - Math.cos(mesh.rotation.y) * lookAhead;
    const targetY = mesh.position.y + p.lookHeightM;

    if (!this._snapped) {
      this._followPosition.set(desiredX, desiredY, desiredZ);
      this._lookTarget.set(targetX, targetY, targetZ);
      this._snapped = true;
    } else {
      // Exponential damping: frame-rate independent smoothing.
      this._followPosition.x = damp(this._followPosition.x, desiredX, p.positionLambda, dt);
      this._followPosition.y = damp(this._followPosition.y, desiredY, p.positionLambda, dt);
      this._followPosition.z = damp(this._followPosition.z, desiredZ, p.positionLambda, dt);
      this._lookTarget.x = damp(this._lookTarget.x, targetX, p.targetLambda, dt);
      this._lookTarget.y = damp(this._lookTarget.y, targetY, p.targetLambda, dt);
      this._lookTarget.z = damp(this._lookTarget.z, targetZ, p.targetLambda, dt);
    }

    this._camera.position.copy(this._followPosition);
    this._camera.lookAt(this._lookTarget);
  }

  dispose() {
    this._dom?.removeEventListener('pointerdown', this._onPointerDown);
    this._dom?.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    this._unsubscribeUpdate?.();
    this._unsubscribeUpdate = null;
    this._target = null;
  }
}