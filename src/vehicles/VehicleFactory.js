import { EgoVehicle } from './EgoVehicle.js';
import { NPCVehicle } from './NPCVehicle.js';
import { SplineUtils } from '../road/SplineUtils.js';
import { createVehicleMesh } from '../utils/GeometryUtils.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';
import { clamp } from '../utils/MathUtils.js';

const VEHICLE = ConfigDefaults.vehicle;

/**
 * VehicleFactory — spawns Ego/NPC vehicles at network locations.
 *
 * resolveSpawnPose() is the shared placement core (lane-center pose at
 * distanceAlongM, travel heading from the lane direction).
 *
 * MODELS (Phase 11): call preloadModels() once after construction; it loads
 * ConfigDefaults.vehicle.modelUrl through AssetLoader. When the GLTF loads,
 * every spawn clones it (geometries/materials shared). When it fails (or
 * the file is absent), each spawn gets the per-paint fallback car instead —
 * preserving the ego/NPC color identity. Without preloadModels(), spawns
 * always use fallbacks.
 *
 * Every spawned vehicle carries `spawnInfo` (its network location) for the
 * "edit this map" round-trip.
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
    /** @type {THREE.Group | null} shared GLTF car model (null → fallbacks) */
    this._carModel = null;
    this._modelPreload = null;
  }

  /**
   * Load the shared vehicle GLTF once. Resolves with the model (or null when
   * the load failed and fallbacks apply). Idempotent.
   */
  async preloadModels() {
    if (!this._modelPreload) {
      this._modelPreload = AssetLoader.loadModel(VEHICLE.modelUrl).then((model) => {
        this._carModel = model && !model.userData?.assetFallback ? model : null;
        return this._carModel;
      });
    }
    return this._modelPreload;
  }

  /**
   * Lane-center pose at (segment, lane, distanceAlongM).
   * @returns {{ position: import('three').Vector3, headingRad: number }}
   */
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
    const travel = lane >= 0 ? 1 : -1; // backward lanes drive against the tangent
    const headingRad = Math.atan2(tangent.x * travel, -tangent.z * travel);
    return { position, headingRad };
  }

  /**
   * Spawn the player's car. Defaults to the physics model; pass motionModel
   * for an alternative (e.g. KinematicBicycleModel).
   * @returns {import('./EgoVehicle.js').EgoVehicle}
   */
  spawnEgo({
    segmentId,
    lane = 0,
    distanceAlongM = 0,
    controller = null,
    motionModel = null,
    paintColor = VEHICLE.egoPaintHex,
  }) {
    const spawnPose = segmentId != null
      ? this.resolveSpawnPose({ segmentId, lane, distanceAlongM, y: VEHICLE.physicsSpawnHeightM })
      : null;
    const ego = new EgoVehicle({
      motionModel: motionModel ?? null,
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

  /**
   * Spawn an AI car on a lane, driven by a WaypointFollower.
   * @returns {import('./NPCVehicle.js').NPCVehicle}
   */
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
    this.vehicles.push(npc);
    return npc;
  }

  /** Shared model clone, or the per-paint fallback car. */
  _meshFor(paintColor) {
    return this._carModel ? this._carModel.clone(true) : createVehicleMesh(paintColor);
  }

  /** Update every spawned vehicle (registered once in main's update order). */
  updateAll(dt) {
    for (const vehicle of this.vehicles) vehicle.update(dt);
  }

  /** Dispose all vehicles (meshes + physics models). */
  disposeAll() {
    for (const vehicle of [...this.vehicles]) vehicle.dispose();
    this.vehicles.length = 0;
  }
}