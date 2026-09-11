import { NeighborIndex } from './NeighborIndex.js';
import { VehicleStateBroadcaster } from './VehicleStateBroadcaster.js';
import { BSMProtocol } from './BSMProtocol.js';
import { SensorStack } from '../sensors/SensorStack.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';
import { AppState } from '../state/AppState.js';

const V2V = ConfigDefaults.v2v;

/**
 * Lane provider for NPC vehicles: their WaypointFollower IS the lane
 * authority. The ego passes null → nearest-lane lookup.
 */
function npcKnownLane(vehicle) {
  return vehicle?.waypointFollower
    ? { segmentId: vehicle.waypointFollower.segmentId, lane: vehicle.waypointFollower.lane }
    : null;
}

/**
 * V2VManager — the per-tick V2V + safety pipeline (Phases 7–10).
 *
 * 1. beginFrame on the ACTIVE backend (CPU/GPU) + broadphases.
 * 2. BSM broadcast for EVERY vehicle (cheap, sensor-free).
 * 3. Full sensor frames for ACTIVE vehicles (BSM embedded).
 * 4. GPU flush. 5. Demotion. 6. Propagation-filtered delivery + alerts for
 * EVERY vehicle. See the Phase 10 file notes for the full rationale.
 *
 * Phase 11: radius defaults from ConfigDefaults; the ego falls back to
 * AppState.ego when not passed (thin state lookup instead of chain-reaching).
 */
export class V2VManager {
  /**
   * @param {object} options
   * @param {import('../vehicles/Vehicle.js').Vehicle[]} options.vehicles live list
   * @param {import('./LODManager.js').LODManager} options.lodManager
   * @param {import('../sensors/RaycastEngine.js').RaycastEngine} options.raycastEngine
   * @param {import('../road/RoadNetwork.js').RoadNetwork} options.network
   * @param {number} [options.radiusM] default: ConfigDefaults.v2v.radiusM
   * @param {import('../vehicles/Vehicle.js').Vehicle} [options.ego] falls back to AppState.ego
   * @param {import('../sensors/GPUCastEngine.js').GPUCastEngine} [options.gpuCastEngine]
   * @param {import('./PropagationModel.js').PropagationModel} [options.propagationModel]
   * @param {import('./SafetyApplications.js').SafetyApplications} [options.safetyApplications]
   */
  constructor({
    vehicles,
    lodManager,
    raycastEngine,
    network,
    radiusM = V2V.radiusM,
    ego = null,
    gpuCastEngine = null,
    propagationModel = null,
    safetyApplications = null,
  } = {}) {
    if (!vehicles || !lodManager || !raycastEngine || !network) {
      throw new TypeError('V2VManager: requires { vehicles, lodManager, raycastEngine, network }');
    }
    this.radiusM = radiusM;
    this._vehicles = vehicles;
    this._lodManager = lodManager;
    this._raycastEngine = raycastEngine;
    this._network = network;
    this._ego = ego ?? AppState.ego ?? null;
    this._gpuCastEngine = gpuCastEngine;
    this._propagationModel = propagationModel;
    this._safetyApplications = safetyApplications;
    this._sensorBackend = 'cpu';

    this._neighborIndex = new NeighborIndex({ radiusM });
    this._neighborIndex.setVehicles(vehicles);
    this._broadcaster = new VehicleStateBroadcaster();

    /** @type {Map<import('../vehicles/Vehicle.js').Vehicle, import('../sensors/SensorStack.js').SensorStack>} */
    this._stacks = new Map();
    this._elapsedSec = 0;

    this.stats = {
      active: 0,
      neighborLinks: 0,
      stacks: 0,
      deliveredLinks: 0,
      droppedLinks: 0,
      alerts: 0,
    };
  }

  get stacks() {
    return this._stacks;
  }

  get sensorBackend() {
    return this._sensorBackend;
  }

  /**
   * Swap the proximity backend (Phase 8). 'gpu' requires a healthy
   * GPUCastEngine; otherwise the request is logged and downgraded to CPU.
   */
  setSensorBackend(mode) {
    if (mode !== 'cpu' && mode !== 'gpu') {
      throw new Error(`V2VManager.setSensorBackend: unknown mode "${mode}"`);
    }
    if (mode === 'gpu' && !(this._gpuCastEngine && this._gpuCastEngine.active)) {
      console.warn('[V2V] GPU sensor backend requested but unavailable — staying on CPU');
      mode = 'cpu';
    }
    this._sensorBackend = mode;
    const engine = mode === 'gpu' ? this._gpuCastEngine : null;
    for (const stack of this._stacks.values()) {
      stack.proximity.setGpuEngine(engine);
    }
    console.info(`[V2V] sensor backend → ${mode}`);
    return mode;
  }

  /**
   * The vehicle's sensor stack — created on first activation and KEPT
   * (toggled) across demotions, so tier flips never allocate.
   */
  ensureStack(vehicle) {
    let stack = this._stacks.get(vehicle);
    if (!stack) {
      const isNpc = !!vehicle.waypointFollower;
      stack = new SensorStack({
        raycastEngine: this._raycastEngine,
        network: this._network,
        vehicle,
        autoBeginFrame: false, // this manager calls beginFrame() once per tick
        getKnownLane: isNpc ? npcKnownLane : null,
      });
      if (this._sensorBackend === 'gpu' && this._gpuCastEngine) {
        stack.proximity.setGpuEngine(this._gpuCastEngine);
      }
      this._stacks.set(vehicle, stack);
      this.stats.stacks = this._stacks.size;
    }
    return stack;
  }

  getStack(vehicle) {
    return this._stacks.get(vehicle) ?? null;
  }

  update(dt) {
    this._elapsedSec += dt;
    const active = this._lodManager.activeVehicles;
    this.stats.active = active.length;

    // 1) Per-tick refresh of the ACTIVE backend + broadphases.
    const gpuActive = this._sensorBackend === 'gpu' && this._gpuCastEngine && this._gpuCastEngine.active;
    if (gpuActive) {
      this._gpuCastEngine.beginFrame();
    } else {
      this._raycastEngine.beginFrame();
    }
    this._neighborIndex.update();
    this._propagationModel?.update();

    // 2) BSM broadcast — EVERY vehicle, every tick.
    for (const vehicle of this._vehicles) {
      if (!vehicle?.motionModel) continue;
      vehicle.bsm = this._broadcaster.broadcastBSM(vehicle, dt, this._elapsedSec);
    }

    // 3) Full sensor frames for actives (BSM embedded).
    for (const vehicle of active) {
      const stack = this.ensureStack(vehicle);
      stack.setEnabled(true);
      stack.update(dt);
      vehicle.sensorFrame = this._broadcaster.broadcastFrame(vehicle, stack, vehicle.bsm, this._elapsedSec);
    }

    // 4) GPU backend: one batched dispatch for every staged ray.
    if (gpuActive) {
      this._gpuCastEngine.flush();
    }

    // 5) Demote: frames only on actives (BSMs and V2V state remain for all).
    const activeSet = new Set(active);
    for (const [vehicle, stack] of this._stacks) {
      if (activeSet.has(vehicle)) continue;
      if (stack.enabled) stack.setEnabled(false);
      if (vehicle.sensorFrame) vehicle.sensorFrame = null;
    }

    // 6) Propagation-filtered delivery + safety alerts — EVERY vehicle.
    let delivered = 0;
    let dropped = 0;
    let alertCount = 0;
    for (const vehicle of this._vehicles) {
      const ownBsm = vehicle.bsm;
      if (!ownBsm) {
        vehicle.v2vLinks = [];
        vehicle.v2vNeighbors = [];
        vehicle.v2vAlerts = [];
        continue;
      }

      const candidates = this._neighborIndex.query(vehicle, this.radiusM);
      const links = [];
      const neighbors = [];
      for (const { vehicle: other, distanceM } of candidates) {
        const otherBsm = other.bsm;
        if (!otherBsm) continue;

        const link = this._propagationModel
          ? this._propagationModel.evaluate(vehicle, other)
          : { received: true, los: true, thicknessM: 0, pdr: 1, hits: [] };
        links.push({ id: other.id, distanceM, received: link.received, los: link.los, pdr: link.pdr, bsm: otherBsm });
        if (!link.received) {
          dropped += 1;
          continue;
        }

        const decoded = BSMProtocol.decode(otherBsm); // reception validation
        if (!decoded) {
          dropped += 1;
          continue;
        }
        neighbors.push({
          id: other.id,
          distanceM,
          relSpeedMps: other.speedMps - vehicle.speedMps,
          los: link.los,
          pdr: link.pdr,
          bsm: decoded,
        });
        delivered += 1;
      }

      vehicle.v2vLinks = links;
      vehicle.v2vNeighbors = neighbors;
      vehicle.v2vAlerts = this._safetyApplications
        ? this._safetyApplications.evaluate(vehicle, ownBsm, neighbors)
        : [];
      alertCount += vehicle.v2vAlerts.length;

      if (vehicle.sensorFrame) {
        vehicle.sensorFrame.v2vNeighbors = neighbors;
        vehicle.sensorFrame.v2vLinks = links;
        vehicle.sensorFrame.v2vAlerts = vehicle.v2vAlerts;
      }
    }

    this.stats.neighborLinks = delivered;
    this.stats.deliveredLinks = delivered;
    this.stats.droppedLinks = dropped;
    this.stats.alerts = alertCount;
  }

  dispose() {
    this._stacks.clear();
    this._neighborIndex.dispose();
    this._gpuCastEngine = null;
    this._propagationModel = null;
    this._safetyApplications = null;
    this.stats = { active: 0, neighborLinks: 0, stacks: 0, deliveredLinks: 0, droppedLinks: 0, alerts: 0 };
  }
}