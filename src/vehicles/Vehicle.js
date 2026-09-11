import { createVehicleMesh } from '../utils/GeometryUtils.js';

/**
 * Vehicle — base class binding a motion model (IVehicleMotionModel) to a mesh.
 *
 * update(dt): getControlInput(dt) → motionModel.update(dt, input) →
 * transform the mesh. The applied input is stored as `lastControlInput`
 * (the BSM's braking/turnSignal fields are derived from it).
 *
 * V2V state (attached by V2VManager each tick): bsm, v2vLinks,
 * v2vNeighbors, v2vAlerts.
 *
 * The mesh defaults to the shared fallback car (utils/GeometryUtils);
 * inject a GLTF via the `mesh` option (faces −Z, origin at chassis center).
 */
export class Vehicle {
  constructor({ id, motionModel, mesh = null, paintColor = 0x8a8f98, sceneManager = null } = {}) {
    if (!id) throw new TypeError('Vehicle: id is required');
    if (!motionModel || typeof motionModel.update !== 'function' || typeof motionModel.getState !== 'function') {
      throw new TypeError('Vehicle: motionModel must implement update(dt, input) and getState()');
    }

    this.id = id;
    this.motionModel = motionModel;
    this.mesh = mesh ?? createVehicleMesh(paintColor);
    this.mesh.name = `vehicle:${id}`;
    this._sceneManager = sceneManager;
    if (sceneManager) sceneManager.add(this.mesh);

    // Last control input applied (throttle/steering/brake) — BSM source.
    this.lastControlInput = { throttle: 0, steering: 0, brake: 0 };

    // V2V state (rebuilt by V2VManager every tick).
    this.bsm = null;
    this.v2vLinks = [];
    this.v2vNeighbors = [];
    this.v2vAlerts = [];

    // Place the mesh at the spawn pose immediately (before the first update).
    this._applyTransform(motionModel.getState());
  }

  get speedMps() {
    return this.motionModel.getState().speedMps;
  }

  get headingRad() {
    return this.motionModel.getState().headingRad;
  }

  /** Step control → motion → mesh transform. Returns the motion state. */
  update(dt) {
    const input = this.getControlInput(dt);
    this.lastControlInput = input;
    const state = this.motionModel.update(dt, input);
    this._applyTransform(state);
    return state;
  }

  /** Override: produce this tick's control input. Default: coast. */
  getControlInput() {
    return { throttle: 0, steering: 0, brake: 0 };
  }

  _applyTransform({ position, headingRad }) {
    this.mesh.position.copy(position);
    this.mesh.rotation.y = -headingRad; // mesh faces −Z; heading is compass yaw
  }

  dispose() {
    if (this._sceneManager) this._sceneManager.remove(this.mesh);
    this.motionModel.dispose?.();
    this.mesh = null;
    this.motionModel = null;
    this._sceneManager = null;
  }
}