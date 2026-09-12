import { TransformControls } from 'three/addons/controls/TransformControls.js';

const GIZMO_MODES = ['translate', 'rotate', 'scale'];

/**
 * GizmoManager — thin wrapper around THREE.TransformControls.
 *
 * - Attaches to an object (a Building's mesh) and exposes translate /
 *   rotate / scale with editor-sane axis restrictions: translate is locked
 *   to the XZ plane (buildings stay grounded), rotate only around Y, scale
 *   on all axes (Y = height).
 * - `onCommit(object, mode)` fires when a drag ENDS — MapEditor syncs the
 *   mesh transform back into Building data and runs collision validation.
 * - `onDraggingChange(bool)` lets the editor disable its orbit camera while
 *   a handle is being dragged.
 * - `isBusy` covers hovering AND dragging, so editor tools can ignore
 *   pointer events that belong to the gizmo.
 *
 * three r166+ made TransformControls a plain Controls (not an Object3D):
 * the scene gets `getHelper()`. The fallback keeps older layouts working.
 */
export class GizmoManager {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {object} [options]
   * @param {(object: THREE.Object3D, mode: string) => void} [options.onCommit]
   * @param {(dragging: boolean) => void} [options.onDraggingChange]
   */
  constructor(engine, { onCommit = null, onDraggingChange = null } = {}) {
    this._engine = engine;
    this._controls = new TransformControls(engine.camera, engine.renderer.domElement);
    this._helper =
      typeof this._controls.getHelper === 'function' ? this._controls.getHelper() : this._controls;
    this._helper.visible = false;
    engine.sceneManager.add(this._helper);

    this._attached = null;
    this._mode = 'translate';
    this._isDragging = false;
    this._onCommit = onCommit;

    this._controls.addEventListener('dragging-changed', (event) => {
      this._isDragging = event.value;
      if (onDraggingChange) onDraggingChange(event.value);
      if (!event.value && this._attached && this._onCommit) {
        this._onCommit(this._attached, this._mode);
      }
    });

    this.setMode('translate');
  }

  get mode() {
    return this._mode;
  }

  get attached() {
    return this._attached;
  }

  get isDragging() {
    return this._isDragging;
  }

  /** True while the pointer hovers a handle or drags it. */
  get isBusy() {
    if (!this._attached) return false;
    return this._isDragging || this._controls.axis !== null;
  }

  setMode(mode) {
    if (!GIZMO_MODES.includes(mode)) {
      throw new Error(`GizmoManager: unknown mode "${mode}" (use ${GIZMO_MODES.join(' | ')})`);
    }
    this._mode = mode;
    this._controls.setMode(mode);
    if (mode === 'translate') {
      this._controls.showX = true;
      this._controls.showZ = true;
      this._controls.showY = false; // buildings never leave the ground
    } else if (mode === 'rotate') {
      this._controls.showX = false;
      this._controls.showZ = false;
      this._controls.showY = true; // yaw only
    } else {
      this._controls.showX = true;
      this._controls.showY = true;
      this._controls.showZ = true; // XZ footprint + Y height
    }
  }

  attach(object) {
    this._attached = object;
    if (this._controls) this._controls.attach(object);
    if (this._helper) this._helper.visible = true;
  }

  detach() {
    this._attached = null;
    if (this._controls) this._controls.detach();
    if (this._helper) this._helper.visible = false;
  }

  dispose() {
    this.detach();
    if (this._helper) {
      this._engine.sceneManager.remove(this._helper);
      try {
        this._helper.traverse?.((child) => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
            else child.material.dispose();
          }
        });
      } catch (e) {
        // ignore
      }
    }
    try {
      this._controls?.disconnect?.();
      this._controls?.dispose?.();
    } catch (e) {
      console.warn('TransformControls disposal warning:', e);
    }
    this._controls = null;
    this._helper = null;
    this._onCommit = null;
  }
}