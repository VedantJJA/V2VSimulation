import { EgoVehicle, NPCVehicle } from './Vehicle.js';
import { KinematicBicycleModel } from './KinematicBicycleModel.js';
import { SplineUtils } from '../road/SplineUtils.js';
import { createVehicleMesh } from '../utils/GeometryUtils.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';
import { clamp } from '../utils/MathUtils.js';

const VEHICLE = ConfigDefaults.vehicle;

/**
 * VehicleFactory — spawns Ego/NPC vehicles at network locations.
 */
export class VehicleFactory {
  /**
   * @param {object} options
   * @param {import('../core/Engine.js').Engine} options.engine
   * @param {import('../road/RoadNetwork.js').RoadNetwork} options.network
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} [options.physicsWorld]
   */
  constructor({ engine, network, physicsWorld = null }) {
    this._sceneManager = engine.sceneManager;
    this._network = network;
    this._physicsWorld = physicsWorld;
    /** @type {import('./Vehicle.js').Vehicle[]} */
    this.vehicles = [];
    this._npcCount = 0;
    this._carModel = null;
    this._modelPreload = null;
  }

  async preloadModels() {
    if (!this._modelPreload) {
      this._modelPreload = AssetLoader.loadModel(VEHICLE.modelUrl).then((model) => {
        this._carModel = model && !model.userData?.assetFallback ? model : null;
        return this._carModel;
      });
    }
    return this._modelPreload;
  }

  resolveSpawnPose({
    segmentId,
    lane = 0,
    distanceAlongM = 0,
    y = VEHICLE.kinematicRideHeightM,
  }) {
    const segment = this._network.getSegment(segmentId);
    if (!segment) throw new Error(`VehicleFactory: unknown segment "${segmentId}"`);

    const length = segment.lengthM;
    const u = clamp(length > 0 ? distanceAlongM / length : 0, 0, 1);
    const position = SplineUtils.lateralAt(
      segment.getCurve(),
      u,
      SplineUtils.laneOffsetM(lane, segment.laneWidthM)
    );
    position.y = y;

    const tangent = segment.getCurve().getTangentAt(u);
    const travel = lane >= 0 ? 1 : -1;
    const headingRad = Math.atan2(tangent.x * travel, -tangent.z * travel);
    return { position, headingRad };
  }

  spawnEgo({
    segmentId,
    lane = 0,
    distanceAlongM = 0,
    controller = null,
    motionModel = null,
    paintColor = VEHICLE.egoPaintHex,
  }) {
    const spawnPose = segmentId != null
      ? this.resolveSpawnPose({ segmentId, lane, distanceAlongM, y: VEHICLE.kinematicRideHeightM })
      : null;
    const egoMotion = motionModel ?? (spawnPose ? new KinematicBicycleModel({
      position: spawnPose.position,
      headingRad: spawnPose.headingRad,
      maxSpeedMps: ConfigDefaults.vehicle.bicycle.maxSpeedMps,
      engineAccelMps2: 6.5,
      brakeDecelMps2: 12.0,
      maxSteerRad: 0.58,
    }) : null);
    const ego = new EgoVehicle({
      motionModel: egoMotion,
      physicsWorld: this._physicsWorld,
      spawnPose,
      controller,
      mesh: this._meshFor(paintColor),
      paintColor,
      sceneManager: this._sceneManager,
    });
    if (segmentId != null) {
      ego.spawnInfo = { segmentId, lane, distanceAlongM, isEgo: true };
    }
    this.vehicles.push(ego);
    return ego;
  }

  spawnNPC({
    segmentId,
    lane = -1,
    distanceAlongM = 0,
    targetSpeedMps = ConfigDefaults.vehicle.npc.defaultTargetSpeedMps,
    paintColor = null,
    followerOptions = {},
    motionModel = null,
  }) {
    const spawnPose = this.resolveSpawnPose({ segmentId, lane, distanceAlongM });
    this._npcCount += 1;
    const color = paintColor ?? VEHICLE.npcPaintPalette[(this._npcCount - 1) % VEHICLE.npcPaintPalette.length];
    const npc = new NPCVehicle({
      id: `npc-${this._npcCount}`,
      network: this._network,
      segmentId,
      lane,
      distanceAlongM,
      targetSpeedMps,
      spawnPose,
      motionModel,
      followerOptions,
      mesh: this._meshFor(color),
      paintColor: color,
      sceneManager: this._sceneManager,
    });
    npc.spawnInfo = { segmentId, lane, distanceAlongM, isEgo: false, targetSpeedMps };
    npc.waypointFollower?.setVehicles(this.vehicles);
    this.vehicles.push(npc);
    return npc;
  }

  _meshFor(paintColor) {
    return this._carModel ? this._carModel.clone(true) : createVehicleMesh(paintColor);
  }

  updateAll(dt) {
    for (const vehicle of this.vehicles) vehicle.update(dt);
  }

  clearNPCs() {
    const npcs = this.vehicles.filter((v) => !v.isEgo);
    for (const npc of npcs) {
      npc.dispose();
      const idx = this.vehicles.indexOf(npc);
      if (idx !== -1) this.vehicles.splice(idx, 1);
    }
  }

  disposeAll() {
    for (const vehicle of [...this.vehicles]) vehicle.dispose();
    this.vehicles.length = 0;
  }
}