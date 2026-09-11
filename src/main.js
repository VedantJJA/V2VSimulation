import { Engine } from './core/Engine.js';
import { Lighting } from './environment/Lighting.js';
import { SkyController } from './environment/SkyController.js';
import { TimeOfDayController } from './environment/TimeOfDayController.js';
import { FogController } from './environment/FogController.js';
import { ControlPanel } from './ui/ControlPanel.js';
import { ModeSwitcher } from './ui/ModeSwitcher.js';

import { RoadNetwork } from './road/RoadNetwork.js';
import { RoadMeshBuilder, ROAD_SURFACE_Y } from './road/RoadMeshBuilder.js';
import { LaneMarkingBuilder } from './road/LaneMarkingBuilder.js';
import { IntersectionBuilder } from './road/IntersectionBuilder.js';
import { RoadSerializer } from './road/RoadSerializer.js';

import { BuildingManager } from './buildings/BuildingManager.js';
import { CollisionResolver } from './buildings/CollisionResolver.js';

import { PhysicsWorld } from './physics/PhysicsWorld.js';
import { CameraRig } from './core/CameraRig.js';
import { VehicleController } from './vehicles/VehicleController.js';
import { VehicleFactory } from './vehicles/VehicleFactory.js';

import { RaycastEngine } from './sensors/RaycastEngine.js';
import { SensorVisualizer } from './sensors/SensorVisualizer.js';
import { FrontCameraSensor } from './sensors/FrontCameraSensor.js';
import { GPUCastEngine } from './sensors/GPUCastEngine.js';

import { LODManager } from './v2v/LODManager.js';
import { V2VManager } from './v2v/V2VManager.js';

import { mulberry32 } from './utils/MathUtils.js';

import { MapEditor } from './editor/MapEditor.js';

const engine = new Engine();

// ---- Shared across modes: environment + its GUI panel -------------------------
const lighting = new Lighting(engine);
const sky = new SkyController(engine);
const timeOfDay = new TimeOfDayController({ lighting, sky, bus: engine.bus, initialPreset: 'day' });
const fog = new FogController(engine, { color: 0x9fb2c8, density: 0.0025 });
const controlPanel = new ControlPanel({ bus: engine.bus, timeOfDay, fog });

// ---- Mode lifecycle --------------------------------------------------------------

let activeSession = null;

function leaveSession() {
  if (!activeSession) return;
  activeSession.dispose();
  activeSession = null;
}

function enterEditor(initialData = null) {
  leaveSession();
  const editor = new MapEditor(engine, {
    initialData,
    onRunSimulation: (data) => enterSimulation({ data }),
  });
  window.__editor = editor;
  activeSession = {
    dispose() {
      editor.dispose();
      delete window.__editor;
    },
  };
}

function enterSimulation(source) {
  leaveSession();
  activeSession = createSimulationSession(source);
}

async function resolveMapData(source) {
  if (source && source.data) return source.data;
  const url = (source && source.url) ?? `${import.meta.env.BASE_URL}maps/sample.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}`);
  return response.json();
}

// The v2 sample map declares no vehicleSpawns — fall back to the Phase-4
// default traffic. Editor-made and city maps declare their own.
const DEFAULT_VEHICLE_SPAWNS = [
  { segmentId: 's1', lane: 0, distanceAlongM: 95, isEgo: true },
  { segmentId: 's1', lane: -1, distanceAlongM: 25, targetSpeedMps: 8 },
  { segmentId: 's2', lane: 0, distanceAlongM: 30, targetSpeedMps: 7 },
];

const CITY_MAP_URL = `${import.meta.env.BASE_URL}maps/city.json`;

/** Ego sensor + traffic HUD text (fed at ~10 Hz). */
function formatSensorReadout(ego, egoStack, lodManager, v2vManager, gpuCastEngine) {
  const state = ego.motionModel.getState();
  const lane = egoStack.laneCentering.readings;
  const proximity = egoStack.proximity.readings;
  const counts = lodManager.tierCounts;
  const frame = ego.sensorFrame;
  const backend =
    v2vManager.sensorBackend === 'gpu' && gpuCastEngine
      ? `gpu · ${gpuCastEngine.stats.raysLastFrame} rays/frame`
      : 'cpu';
  const lines = [
    `speed        ${state.speedMps.toFixed(1)} m/s`,
    `lane         ${lane.segmentId ?? '—'} · lane ${lane.lane ?? '—'}`,
    `lat offset   ${lane.lateralOffsetM == null ? '—' : `${lane.lateralOffsetM.toFixed(2)} m`}`,
    `heading err  ${lane.headingErrorRad == null ? '—' : `${((lane.headingErrorRad * 180) / Math.PI).toFixed(1)}°`}`,
    `traffic      ${counts.active} active · ${counts.passive} passive · ${counts.culled} culled`,
    `v2v          ${frame ? frame.v2vNeighbors.length : 0} neighbors ≤ ${v2vManager.radiusM} m`,
    `backend      ${backend}`,
    'proximity (m)',
  ];
  for (const ray of egoStack.proximity.rays) {
    const distance = proximity.proximityM[ray.name];
    const kind = proximity.hitKind[ray.name];
    lines.push(
      `  ${ray.name.padEnd(12)} ${distance == null ? '—' : distance.toFixed(1)}` +
        `${kind && kind !== 'none' ? `  ${kind}` : ''}`
    );
  }
  return lines.join('\n');
}

function createSimulationSession(source) {
  controlPanel.removeRoadsFolder();
  controlPanel.removeMapFolder();
  controlPanel.removeSensorsFolder();
  controlPanel.removeTrafficFolder();

  // Fresh per-session systems (the previous session disposed its own).
  const roadMeshBuilder = new RoadMeshBuilder(engine);
  const laneMarkingBuilder = new LaneMarkingBuilder(engine);
  const intersectionBuilder = new IntersectionBuilder({
    engine,
    asphaltMaterial: roadMeshBuilder.asphaltMaterial,
  });
  const roadNetwork = new RoadNetwork();
  const buildingManager = new BuildingManager(engine, { gridCellSizeM: 25 });
  const collisionResolver = new CollisionResolver({ marginM: 2, buildingOverlapThresholdM: 0.5 });

  // UPDATE ORDER (registration order): physics → traffic (LOD-tiered motion,
  // replaces vehicleFactory.updateAll) → camera rig → sensors/V2V. The two
  // traffic slots are assigned once the map loads; until then they no-op.
  const physicsWorld = new PhysicsWorld(engine, { groundY: ROAD_SURFACE_Y });
  const vehicleController = new VehicleController();
  const vehicleFactory = new VehicleFactory({ engine, network: roadNetwork, physicsWorld });
  let runTraffic = null;
  const unsubscribeTraffic = engine.addUpdate((dt) => runTraffic?.(dt));
  const cameraRig = new CameraRig(engine, { mode: 'third' });
  let runSensors = null;
  const unsubscribeSensors = engine.addUpdate((dt) => runSensors?.(dt));

  engine.camera.position.set(60, 60, 110);
  engine.camera.lookAt(0, 0, 0);

  let disposed = false;
  let mapLoaded = false;
  let raycastEngine = null;
  let v2vManager = null;
  let gpuCastEngine = null;
  let egoExtras = null; // { egoStack, sensorVisualizer, frontCameraSensor }

  const session = {
    dispose() {
      if (disposed) return;
      disposed = true;
      runTraffic = null;
      runSensors = null;
      egoExtras?.sensorVisualizer.dispose();
      egoExtras?.frontCameraSensor.dispose();
      egoExtras = null;
      v2vManager?.dispose();
      gpuCastEngine?.dispose();
      raycastEngine?.dispose();
      controlPanel.removeRoadsFolder();
      controlPanel.removeMapFolder();
      controlPanel.removeSensorsFolder();
      controlPanel.removeTrafficFolder();
      unsubscribeTraffic();
      unsubscribeSensors();
      vehicleFactory.disposeAll();
      cameraRig.dispose();
      vehicleController.dispose();
      physicsWorld.dispose();
      if (mapLoaded) {
        buildingManager.disposeAll();
        intersectionBuilder.disposeAll();
        laneMarkingBuilder.disposeAll();
        roadMeshBuilder.disposeAll(); // owns the shared asphalt material/texture
      }
      delete window.__road;
    },
  };

  resolveMapData(source)
    .then(async (data) => {
      if (disposed) return; // session left while the map was loading

      const { network, vehicleSpawns } = RoadSerializer.deserialize(data, {
        network: roadNetwork,
        meshBuilder: roadMeshBuilder,
        markingBuilder: laneMarkingBuilder,
        intersectionBuilder,
        sceneManager: engine.sceneManager,
        buildingManager,
      });
      mapLoaded = true;

      controlPanel.addRoadsDebugFolder({
        network: roadNetwork,
        meshBuilder: roadMeshBuilder,
        markingBuilder: laneMarkingBuilder,
        intersectionBuilder,
        buildingManager,
        collisionResolver,
      });
      controlPanel.addMapFolder({
        onLoadMapFile: (mapData) => enterSimulation({ data: mapData }),
        onEditMap: () => {
          const spawns = vehicleFactory.vehicles
            .map((vehicle) => vehicle.spawnInfo)
            .filter((info) => info && roadNetwork.getSegment(info.segmentId));
          enterEditor(RoadSerializer.serialize(roadNetwork, buildingManager, spawns));
        },
        builtInMaps: [{ name: 'city grid (600 m)', url: CITY_MAP_URL }],
      });

      // Spawns: map-declared, or the sample defaults when the map has none.
      const spawns = vehicleSpawns.length > 0 ? vehicleSpawns : DEFAULT_VEHICLE_SPAWNS;
      let ego = null;
      for (const spawn of spawns) {
        if (spawn.isEgo) {
          if (ego) continue; // ego is exclusive
          ego = vehicleFactory.spawnEgo({
            segmentId: spawn.segmentId,
            lane: spawn.lane,
            distanceAlongM: spawn.distanceAlongM,
            controller: vehicleController,
          });
        } else {
          vehicleFactory.spawnNPC({
            segmentId: spawn.segmentId,
            lane: spawn.lane,
            distanceAlongM: spawn.distanceAlongM,
            targetSpeedMps: spawn.targetSpeedMps ?? 8,
          });
        }
      }
      if (ego) cameraRig.attach(ego);

      // ---- Sensors, LOD, V2V --------------------------------------------------
      // CPU backend (always present): statics BVH'd, dynamics as analytic OBBs.
      raycastEngine = new RaycastEngine();
      for (const segmentId of roadNetwork.segmentIds) {
        raycastEngine.registerStatic(roadMeshBuilder.getMesh(segmentId));
      }
      for (const building of buildingManager.getAll()) {
        raycastEngine.registerStatic(building.mesh);
      }
      for (const segment of roadNetwork.segments.values()) {
        for (const obstruction of segment.obstructions) {
          raycastEngine.registerStatic(obstruction.mesh);
        }
      }
      raycastEngine.setDynamicVehicles(vehicleFactory.vehicles);

      // Phase 8: optional GPU backend. Returns null (never throws) when
      // WebGPU / three's WebGPURenderer is unavailable — the CPU path then
      // runs identically and the GUI toggle is never created.
      gpuCastEngine = await GPUCastEngine.create({
        vehicles: vehicleFactory.vehicles,
        cpuReference: raycastEngine,
        onDisabled: (reason) => {
          console.warn(`[sensors] GPU backend disabled (${reason}) — CPU path continues`);
          v2vManager?.setSensorBackend('cpu');
          controlPanel.updateGpuSensorsToggle(false);
        },
      });
      if (gpuCastEngine) {
        for (const segmentId of roadNetwork.segmentIds) {
          gpuCastEngine.registerStatic(roadMeshBuilder.getMesh(segmentId));
        }
        for (const building of buildingManager.getAll()) {
          gpuCastEngine.registerStatic(building.mesh);
        }
        for (const segment of roadNetwork.segments.values()) {
          for (const obstruction of segment.obstructions) {
            gpuCastEngine.registerStatic(obstruction.mesh);
          }
        }
      }

      const lodManager = new LODManager({
        vehicles: vehicleFactory.vehicles,
        ego,
        promoteNearestN: 0, // the Traffic folder's flag
        cullRadiusM: 400,
      });
      v2vManager = new V2VManager({
        vehicles: vehicleFactory.vehicles,
        lodManager,
        raycastEngine,
        network: roadNetwork,
        radiusM: 250,
        ego,
        gpuCastEngine,
      });

      // Deterministic traffic scatter across every segment (seeded, so the
      // stress test is reproducible). New NPCs appear in the LOD/neighbor
      // indexes automatically — all systems hold the live list reference.
      const spawnTrafficNpcs = (count) => {
        const segmentIds = roadNetwork.segmentIds;
        if (segmentIds.length === 0) return 0;
        const random = mulberry32(20240607);
        let spawned = 0;
        for (let i = 0; i < count; i++) {
          const segment = roadNetwork.getSegment(segmentIds[i % segmentIds.length]);
          let lane = i % 2 === 0 ? -1 : 0; // alternate travel directions
          if (lane === 0 && segment.lanesForward === 0) lane = -1;
          if (lane === -1 && segment.lanesBackward === 0) lane = 0;
          vehicleFactory.spawnNPC({
            segmentId: segment.id,
            lane,
            distanceAlongM: 10 + random() * Math.max(0, segment.lengthM - 20),
            targetSpeedMps: 7 + Math.floor(random() * 3), // 7–9 m/s
          });
          spawned += 1;
        }
        console.log(`[traffic] spawned ${spawned} NPCs across ${segmentIds.length} segments`);
        return spawned;
      };

      controlPanel.addTrafficFolder({
        lodManager,
        onSpawnNpcs: spawnTrafficNpcs,
      });

      if (ego) {
        // Ego debug extras, wired to its (always-active) sensor stack.
        const egoStack = v2vManager.ensureStack(ego);
        const sensorVisualizer = new SensorVisualizer(engine, { sensorArray: egoStack.proximity });
        const frontCameraSensor = new FrontCameraSensor(engine, { vehicle: ego });
        controlPanel.addSensorsFolder({
          visualizer: sensorVisualizer,
          frontCamera: frontCameraSensor,
          // GPU toggle exists ONLY when the engine probed WebGPU successfully.
          gpuSensors: gpuCastEngine
            ? {
                onToggle: (enabled) => {
                  const applied = v2vManager.setSensorBackend(enabled ? 'gpu' : 'cpu');
                  if (applied !== (enabled ? 'gpu' : 'cpu')) {
                    controlPanel.updateGpuSensorsToggle(false); // snap back
                  }
                },
              }
            : null,
        });
        egoExtras = { egoStack, sensorVisualizer, frontCameraSensor };
      }

      // Slot 1: LOD-tiered traffic motion (replaces updateAll).
      runTraffic = (dt) => lodManager.update(dt);

      // Slot 2: V2V + sensors, then ego extras + HUD (10 Hz).
      let readoutTimer = 0;
      runSensors = (dt) => {
        v2vManager.update(dt);
        if (!egoExtras || !ego) return;
        egoExtras.sensorVisualizer.update();
        egoExtras.frontCameraSensor.update(dt);
        readoutTimer += dt;
        if (readoutTimer >= 0.1) {
          readoutTimer = 0;
          controlPanel.setSensorReadout(
            formatSensorReadout(ego, egoExtras.egoStack, lodManager, v2vManager, gpuCastEngine)
          );
        }
      };

      // Dev / acceptance hook. Examples:
      //   __road.lodManager.setPromoteNearestN(120)        // 100+ active vehicles
      //   __road.v2vManager.setSensorBackend('gpu')       // same as the toggle
      //   __road.gpuCastEngine.stats                      // cpuMs vs gpuMs etc.
      //   __road.gpuCastEngine.runBenchmark(2048)         // timed CPU vs GPU
      window.__road = {
        network: roadNetwork,
        meshBuilder: roadMeshBuilder,
        markingBuilder: laneMarkingBuilder,
        intersectionBuilder,
        buildingManager,
        collisionResolver,
        vehicleFactory,
        vehicleController,
        cameraRig,
        physicsWorld,
        raycastEngine,
        lodManager,
        v2vManager,
        gpuCastEngine,
        spawnTrafficNpcs,
      };
    })
    .catch((error) => console.error('[simulation] failed to load map:', error));

  return session;
}

// ---- Boot ------------------------------------------------------------------------
engine.camera.position.set(60, 55, 105);
engine.camera.lookAt(0, 0, 0);
engine.start();

const modeSwitcher = new ModeSwitcher({ title: 'Road Network Sandbox' });
const choice = await modeSwitcher.choose();

if (choice.mode === 'edit') {
  enterEditor(choice.data ?? null);
} else {
  enterSimulation(choice.data ? { data: choice.data } : {});
}

// Clean teardown on HMR (reverse creation order).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    leaveSession();
    modeSwitcher.dispose();
    controlPanel.dispose();
    fog.dispose();
    sky.dispose();
    timeOfDay.dispose();
    lighting.dispose();
    engine.dispose();
  });
}