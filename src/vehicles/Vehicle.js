import * as THREE from 'three';
import { createVehicleMesh } from '../utils/GeometryUtils.js';
import { PhysicsVehicleModel } from './PhysicsVehicleModel.js';
import { WaypointFollower } from './WaypointFollower.js';
import { SplineUtils } from '../road/SplineUtils.js';

/**
 * Vehicle — Base vehicle class binding a motion model to a 3D car mesh.
 *
 * Supports:
 * - Steering front wheel articulation & rolling tire animations.
 * - Taillight and brake response.
 * - V2V state attachment (BSM, alerts, links).
 */
export class Vehicle {
  /**
   * @param {object} options
   * @param {string} options.id
   * @param {import('./IVehicleMotionModel.js').IVehicleMotionModel} options.motionModel
   * @param {THREE.Object3D} [options.mesh]
   * @param {number} [options.paintColor]
   * @param {import('../core/SceneManager.js').SceneManager} [options.sceneManager]
   * @param {boolean} [options.isEgo]
   */
  constructor({ id, motionModel, mesh = null, paintColor = 0xc23b2e, sceneManager = null, isEgo = false } = {}) {
    if (!id) throw new TypeError('Vehicle: id is required');
    if (!motionModel || typeof motionModel.update !== 'function' || typeof motionModel.getState !== 'function') {
      throw new TypeError('Vehicle: motionModel must implement update(dt, input) and getState()');
    }

    this.id = id;
    this.isEgo = isEgo;
    this.motionModel = motionModel;

    this.mesh = mesh ?? createVehicleMesh(paintColor);
    this.mesh.name = `vehicle:${id}`;
    this._sceneManager = sceneManager;
    if (sceneManager) sceneManager.add(this.mesh);

    this.lastControlInput = { throttle: 0, steering: 0, brake: 0 };

    this.bsm = null;
    this.v2vLinks = [];
    this.v2vNeighbors = [];
    this.v2vAlerts = [];

    this._applyTransform(motionModel.getState(), 0);
  }

  get speedMps() {
    return this.motionModel.getState().speedMps;
  }

  get headingRad() {
    return this.motionModel.getState().headingRad;
  }

  update(dt) {
    const input = this.getControlInput(dt);
    this.lastControlInput = input;
    const state = this.motionModel.update(dt, input);
    this._applyTransform(state, dt);
    return state;
  }

  getControlInput() {
    return { throttle: 0, steering: 0, brake: 0 };
  }

  _applyTransform(state, dt = 0.016) {
    if (!this.mesh) return;

    this.mesh.position.copy(state.position);
    this.mesh.rotation.y = -state.headingRad;

    const steer = state.steeringRad ?? (this.lastControlInput?.steering ? this.lastControlInput.steering * 0.52 : 0);
    const speed = state.speedMps ?? 0;

    // Articulate front wheels
    if (this.mesh.userData?.frontWheels) {
      for (const w of this.mesh.userData.frontWheels) {
        w.rotation.y = -steer;
      }
    }

    // Roll wheels
    if (this.mesh.userData?.wheels && dt > 0) {
      const rollDelta = (speed * dt) / 0.32;
      for (const w of this.mesh.userData.wheels) {
        w.rotation.x -= rollDelta;
      }
    }
  }

  dispose() {
    if (this._sceneManager) this._sceneManager.remove(this.mesh);
    this.motionModel?.dispose?.();
    this.mesh = null;
    this.motionModel = null;
    this._sceneManager = null;
  }
}

/**
 * EgoVehicle — Player-controlled vehicle.
 */
export class EgoVehicle extends Vehicle {
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
        throw new TypeError('EgoVehicle: provide motionModel, or physicsWorld + spawnPose');
      }
      motionModel = new PhysicsVehicleModel({
        physicsWorld,
        position: spawnPose.position,
        headingRad: spawnPose.headingRad,
      });
    }

    super({ id, motionModel, mesh, paintColor, sceneManager, isEgo: true });
    this.controller = controller;
  }

  getControlInput(dt) {
    if (!this.controller) return { throttle: 0, steering: 0, brake: 0 };
    return this.controller.getControlInput(dt, this.v2vAlerts ?? [], this.sensorData ?? {}, this.timeSec ?? 0, this);
  }
}

/**
 * NPCVehicle — Autonomous traffic vehicle.
 */
export class NPCVehicle extends Vehicle {
  constructor({
    id,
    network,
    segmentId,
    lane = -1,
    distanceAlongM = 0,
    targetSpeedMps = 8,
    spawnPose = null,
    motionModel = null,
    followerOptions = {},
    mesh = null,
    paintColor = 0x3a5f8c,
    sceneManager = null,
  } = {}) {
    if (!network) throw new TypeError('NPCVehicle: network is required');

    const follower = new WaypointFollower({
      network,
      segmentId,
      lane,
      distanceAlongM,
      targetSpeedMps,
      ...followerOptions,
    });

    if (!motionModel) {
      const initPose = spawnPose ?? {
        position: SplineUtils.lateralAt(
          network.getSegment(segmentId).getCurve(),
          0,
          SplineUtils.laneOffsetM(lane, network.getSegment(segmentId).laneWidthM)
        ),
        headingRad: 0,
      };

      motionModel = {
        position: initPose.position.clone(),
        headingRad: initPose.headingRad,
        speedMps: targetSpeedMps,
        getState() {
          return {
            position: this.position,
            headingRad: this.headingRad,
            speedMps: this.speedMps,
            steeringRad: this.steeringRad ?? 0,
          };
        },
        update(dt, input) {
          this.speedMps += ((input.throttle > 0 ? input.throttle * 5 : -input.brake * 10) - 0.5) * dt;
          this.speedMps = Math.max(0, Math.min(targetSpeedMps * 1.5, this.speedMps));
          this.steeringRad = (input.steering || 0) * 0.55;
          this.headingRad += this.steeringRad * (this.speedMps / 3.0) * dt;
          this.position.x += Math.sin(this.headingRad) * this.speedMps * dt;
          this.position.z += -Math.cos(this.headingRad) * this.speedMps * dt;
          return this.getState();
        },
      };
    }

    const vehicleMesh = mesh ?? createVehicleMesh(paintColor);

    super({ id, motionModel, mesh: vehicleMesh, paintColor, sceneManager, isEgo: false });
    this.waypointFollower = follower;
  }

  getControlInput(dt) {
    if (!this.waypointFollower) return { throttle: 0, steering: 0, brake: 0 };
    return this.waypointFollower.update(dt, this.motionModel.getState(), this.v2vAlerts ?? []);
  }
}