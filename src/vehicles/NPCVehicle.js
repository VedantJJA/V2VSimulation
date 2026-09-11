import { Vehicle } from './Vehicle.js';
import { KinematicBicycleModel } from './KinematicBicycleModel.js';
import { WaypointFollower } from './WaypointFollower.js';

/**
 * NPCVehicle — an AI car. Kinematic bicycle motion (no physics body) driven
 * by a WaypointFollower that tracks lane centerlines across the road network.
 *
 * Phase 10: the follower receives this vehicle's v2vAlerts each tick, so
 * NPCs react to V2V safety alerts (critical ICW → 20% speed + hard brake;
 * EEBL → distance-proportional speed limit). NPCs are ghost-colliders to
 * each other (no avoidance) — V2V reactions are the first traffic behavior
 * layered on top.
 */
export class NPCVehicle extends Vehicle {
  /**
   * @param {object} options
   * @param {string} options.id
   * @param {import('../road/RoadNetwork.js').RoadNetwork} options.network
   * @param {string} options.segmentId spawn segment
   * @param {number} [options.lane] signed lane (≥0 forward, −1..−n backward)
   * @param {number} [options.distanceAlongM]
   * @param {number} [options.targetSpeedMps]
   * @param {{ position: import('three').Vector3, headingRad: number }} [options.spawnPose]
   * @param {import('./IVehicleMotionModel.js').IVehicleMotionModel} [options.motionModel]
   * @param {object} [options.followerOptions] forwarded to WaypointFollower
   * @param {number} [options.paintColor]
   * @param {import('../core/SceneManager.js').SceneManager} [options.sceneManager]
   */
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
    paintColor = 0x8a8f98,
    sceneManager = null,
    mesh = null,
  }) {
    if (!network) throw new TypeError('NPCVehicle: network is required');
    if (!motionModel) {
      if (!spawnPose) {
        throw new TypeError('NPCVehicle: provide motionModel, or spawnPose for the default KinematicBicycleModel');
      }
      motionModel = new KinematicBicycleModel({
        position: spawnPose.position,
        headingRad: spawnPose.headingRad,
        maxSpeedMps: Math.max(targetSpeedMps * 1.5, 5),
      });
    }
    super({ id, motionModel, mesh, paintColor, sceneManager });

    this.waypointFollower = new WaypointFollower({
      network,
      segmentId,
      lane,
      distanceAlongM,
      targetSpeedMps,
      ...followerOptions,
    });
  }

  /** Steer/throttle from the follower + V2V alert reactions (1 tick latency). */
  getControlInput(dt) {
    return this.waypointFollower.update(dt, this.motionModel.getState(), this.v2vAlerts ?? []);
  }
}