import { Vehicle } from './Vehicle.js';
import { PhysicsVehicleModel } from './PhysicsVehicleModel.js';

/**
 * EgoVehicle — the player's car. Uses PhysicsVehicleModel by default
 * (configurable: pass any IVehicleMotionModel, e.g. a KinematicBicycleModel
 * for arcade handling). Control input comes from a VehicleController
 * (keyboard); the CameraRig follows this vehicle.
 *
 * Phase 10: the ego's v2vAlerts are forwarded to the controller each tick —
 * the controller may auto-brake on CRITICAL ICW behind a config flag
 * (default OFF: the ego is player-controlled, alerts are primarily
 * visual/HUD).
 */
export class EgoVehicle extends Vehicle {
  /**
   * @param {object} options
   * @param {string} [options.id]
   * @param {import('./IVehicleMotionModel.js').IVehicleMotionModel} [options.motionModel]
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} [options.physicsWorld]
   * @param {{ position: import('three').Vector3, headingRad: number }} [options.spawnPose]
   * @param {import('./VehicleController.js').VehicleController} [options.controller]
   * @param {THREE.Object3D} [options.mesh] custom model (faces −Z)
   * @param {number} [options.paintColor]
   * @param {import('../core/SceneManager.js').SceneManager} [options.sceneManager]
   */
  constructor({
    id = 'ego',
    motionModel = null,
    physicsWorld = null,
    spawnPose = null,
    controller = null,
    mesh = null,
    paintColor = 0xc23b2e,
    sceneManager = null,
  } = {}) {
    if (!motionModel) {
      if (!physicsWorld || !spawnPose) {
        throw new TypeError('EgoVehicle: provide motionModel, or physicsWorld + spawnPose for the default PhysicsVehicleModel');
      }
      motionModel = new PhysicsVehicleModel({
        physicsWorld,
        position: spawnPose.position,
        headingRad: spawnPose.headingRad,
      });
    }
    super({ id, motionModel, mesh, paintColor, sceneManager });
    this.controller = controller;
  }

  getControlInput(dt) {
    if (!this.controller) return { throttle: 0, steering: 0, brake: 0 };
    return this.controller.getControlInput(dt, this.v2vAlerts ?? []);
  }
}