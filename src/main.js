import { Engine } from './core/Engine.js';
import {
  Lighting,
  SkyController,
  TimeOfDayController,
  FogController,
} from './environment/EnvironmentManager.js';
import { ControlPanel } from './ui/ControlPanel.js';
import { ModeSwitcher } from './ui/ModeSwitcher.js';
import { Minimap } from './ui/Minimap.js';
import { NavigationSystem } from './navigation/NavigationSystem.js';
import { LaneGuideVisualizer } from './navigation/LaneGuideVisualizer.js';
import { AutoDriveController } from './vehicles/AutoDriveController.js';

import { RoadNetwork } from './road/RoadNetwork.js';
import { RoadMeshBuilder, ROAD_SURFACE_Y } from './road/RoadMeshBuilder.js';
import { LaneMarkingBuilder } from './road/LaneMarkingBuilder.js';
import { IntersectionBuilder } from './road/IntersectionBuilder.js';
import { GuardRailBuilder } from './road/GuardRailBuilder.js';
import { LaneMergerBuilder } from './road/LaneMergerBuilder.js';
import { RoadSerializer } from './road/RoadSerializer.js';

import { BuildingManager, CollisionResolver } from './buildings/BuildingManager.js';

import { PhysicsWorld } from './physics/PhysicsWorld.js';
import { VehicleCollisionSystem } from './physics/VehicleCollisionSystem.js';
import { CameraRig } from './core/CameraRig.js';
import { VehicleController } from './vehicles/VehicleController.js';
import { VehicleFactory } from './vehicles/VehicleFactory.js';

import { RaycastEngine } from './sensors/RaycastEngine.js';
import { SensorVisualizer } from './sensors/SensorVisualizer.js';
import { FrontCameraSensor } from './sensors/FrontCameraSensor.js';
import { GPUCastEngine } from './sensors/GPUCastEngine.js';

import { LODManager } from './v2v/LODManager.js';
import { V2VManager } from './v2v/V2VManager.js';

import * as THREE from 'three';
import { mulberry32, clamp, isTypingTarget } from './utils/MathUtils.js';

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
  try {
    activeSession.dispose();
  } catch (err) {
    console.error('[leaveSession] error during session disposal:', err);
  }
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
function formatSensorReadout(ego, egoStack, lodManager, v2vManager, gpuCastEngine, cameraSensor = null, autoDriveCtrl = null) {
  const state = ego.motionModel.getState();
  const lane = egoStack.laneCentering.readings;
  const proximity = egoStack.proximity.readings;
  const counts = lodManager.tierCounts;
  const frame = ego.sensorFrame;
  const backend =
    v2vManager.sensorBackend === 'gpu' && gpuCastEngine
      ? `gpu · ${gpuCastEngine.stats.raysLastFrame} rays/frame`
      : 'cpu';

  const camReadings = cameraSensor?.getLaneReadings?.();

  const lines = [
    `speed        ${state.speedMps.toFixed(1)} m/s (${Math.round(state.speedMps * 3.6)} km/h)`,
    `lane         ${lane.segmentId ?? '—'} · lane ${lane.lane ?? '—'}`,
    `lat offset   ${lane.lateralOffsetM == null ? '—' : `${lane.lateralOffsetM.toFixed(2)} m`}`,
    `heading err  ${lane.headingErrorRad == null ? '—' : `${((lane.headingErrorRad * 180) / Math.PI).toFixed(1)}°`}`,
  ];

  if (autoDriveCtrl) {
    const tel = autoDriveCtrl.getTelemetry?.() ?? {};
    lines.push(`auto-drive   ${autoDriveCtrl.enabled ? `🟢 ${autoDriveCtrl.status}` : '⚪ OFF'}`);
    if (autoDriveCtrl.enabled) {
      lines.push(`lane idx     ${tel.currentLaneIndex} -> ${tel.targetLaneIndex} ${tel.isLaneChanging ? '(CHANGING)' : '(LOCKED)'}`);
      if (tel.obstacleDistanceM != null && tel.obstacleDistanceM < 40) {
        lines.push(`obstacle     ${tel.obstacleDistanceM.toFixed(1)}m ahead`);
      }
    }
  }

  if (camReadings && camReadings.detected) {
    lines.push(`cam lane ctr offset ${camReadings.lateralOffsetM.toFixed(2)} m · head ${((camReadings.headingErrorRad * 180) / Math.PI).toFixed(1)}°`);
  }

  lines.push(
    `traffic      ${counts.active} active · ${counts.passive} passive · ${counts.culled} culled`,
    `v2v          ${frame ? frame.v2vNeighbors.length : 0} neighbors ≤ ${v2vManager.radiusM} m`,
    `backend      ${backend}`,
    'proximity (analog distance)',
  );
  for (const ray of egoStack.proximity.rays) {
    const distance = proximity.proximityM[ray.name];
    const kind = proximity.hitKind[ray.name];
    const maxR = egoStack.proximity.maxRangeM || 50;
    const hasHit = kind && kind !== 'none' && distance != null && distance < maxR;
    const d = hasHit ? distance : maxR;

    // 8-segment proportional analog bar meter
    const barBlocks = ['░', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
    const norm = clamp(d / maxR, 0, 1);
    const fullBars = Math.floor(norm * 8);
    const rem = Math.floor((norm * 8 - fullBars) * 8);
    let bar = '█'.repeat(fullBars);
    if (fullBars < 8) {
      bar += barBlocks[rem];
      bar += '░'.repeat(7 - fullBars);
    }

    const distStr = hasHit ? `${distance.toFixed(1).padStart(5)}m` : '  >50m';
    const tag = hasHit ? `[${kind}]` : '[clear]';
    lines.push(`  ${ray.name.padEnd(12)} [${bar}] ${distStr} ${tag}`);
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
  const guardRailBuilder = new GuardRailBuilder(engine);
  const laneMergerBuilder = new LaneMergerBuilder(engine);
  const intersectionBuilder = new IntersectionBuilder({
    engine,
    asphaltMaterial: roadMeshBuilder.asphaltMaterial,
  });
  const roadNetwork = new RoadNetwork();
  roadMeshBuilder.setNetwork(roadNetwork);
  laneMarkingBuilder.setNetwork(roadNetwork);
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
  let cleanupSimInputs = null;
  let autoDriveController = null;

  const session = {
    dispose() {
      if (disposed) return;
      disposed = true;
      cleanupSimInputs?.();
      cleanupSimInputs = null;
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
      controlPanel.removeCameraFolder();
      unsubscribeTraffic();
      unsubscribeSensors();
      vehicleFactory.disposeAll();
      cameraRig.dispose();
      vehicleController.dispose();
      physicsWorld.dispose();
      if (navigationSystem) {
        navigationSystem.dispose();
        navigationSystem = null;
      }
      if (laneGuideVisualizer) {
        laneGuideVisualizer.dispose();
        laneGuideVisualizer = null;
      }
      if (autoDriveController) {
        autoDriveController.dispose();
        autoDriveController = null;
      }
      if (minimap) {
        minimap.dispose();
        minimap = null;
      }
      if (mapLoaded) {
        buildingManager.disposeAll();
        intersectionBuilder.disposeAll();
        laneMergerBuilder.disposeAll();
        laneMarkingBuilder.disposeAll();
        guardRailBuilder.disposeAll();
        roadMeshBuilder.disposeAll(); // owns the shared asphalt material/texture
      }
      delete window.__road;
    },
  };

  let navigationSystem = null;
  let laneGuideVisualizer = null;
  let minimap = null;

  resolveMapData(source)
    .then(async (data) => {
      if (disposed) return; // session left while the map was loading

      const { network, vehicleSpawns } = RoadSerializer.deserialize(data, {
        network: roadNetwork,
        meshBuilder: roadMeshBuilder,
        markingBuilder: laneMarkingBuilder,
        intersectionBuilder,
        guardRailBuilder,
        laneMergerBuilder,
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

      // Spawns: filter to existing segments in this network
      const validMapSpawns = vehicleSpawns.filter((s) => roadNetwork.getSegment(s.segmentId));
      const validDefaultSpawns = DEFAULT_VEHICLE_SPAWNS.filter((s) => roadNetwork.getSegment(s.segmentId));
      const spawns = validMapSpawns.length > 0 ? validMapSpawns : validDefaultSpawns;

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

      // If no ego was spawned, automatically place player on the first road segment
      if (!ego && roadNetwork.segmentIds.length > 0) {
        const firstSeg = roadNetwork.getSegment(roadNetwork.segmentIds[0]);
        const lane = firstSeg.lanesForward > 0 ? 0 : -1;
        const dist = Math.min(15, Math.max(0, firstSeg.lengthM * 0.3));
        ego = vehicleFactory.spawnEgo({
          segmentId: firstSeg.id,
          lane,
          distanceAlongM: dist,
          controller: vehicleController,
        });
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

      // Functions to place / spawn cars on the road during simulation
      const addCarAhead = (distanceM = 25, oncoming = false, stopped = false) => {
        let seg = null;
        let targetLane = 0;
        let baseDist = 15;

        if (ego) {
          const readings = egoExtras?.egoStack?.laneCentering?.readings;
          if (readings?.segmentId && roadNetwork.getSegment(readings.segmentId)) {
            seg = roadNetwork.getSegment(readings.segmentId);
            targetLane = readings.lane ?? 0;
            baseDist = readings.distanceAlongM ?? (seg.lengthM * 0.3);
          } else {
            const egoState = ego.motionModel.getState();
            let bestD = Infinity;
            for (const s of roadNetwork.segments.values()) {
              const u = 0.5;
              const p = s.getCurve().getPointAt(u);
              const d = Math.hypot(egoState.position.x - p.x, egoState.position.z - p.z);
              if (d < bestD) {
                bestD = d;
                seg = s;
              }
            }
          }
        }

        if (!seg && roadNetwork.segmentIds.length > 0) {
          seg = roadNetwork.getSegment(roadNetwork.segmentIds[0]);
        }
        if (!seg) {
          console.warn('[traffic] No road segment available to spawn car');
          return null;
        }

        if (oncoming) {
          if (targetLane >= 0 && seg.lanesBackward > 0) {
            targetLane = -1;
          } else if (targetLane < 0 && seg.lanesForward > 0) {
            targetLane = 0;
          }
        }

        const travelDir = targetLane >= 0 ? 1 : -1;
        let spawnDist = baseDist + (travelDir * distanceM);
        spawnDist = Math.max(5, Math.min(seg.lengthM - 5, spawnDist));

        const targetSpeedMps = stopped ? 0 : (oncoming ? 9 : 8);
        const npc = vehicleFactory.spawnNPC({
          segmentId: seg.id,
          lane: targetLane,
          distanceAlongM: spawnDist,
          targetSpeedMps,
        });
        console.log(`[traffic] Spawned ${oncoming ? 'oncoming' : stopped ? 'stopped' : 'moving'} car on ${seg.id} (lane ${targetLane}) at ${spawnDist.toFixed(1)}m`);
        return npc;
      };

      const clearAllTraffic = () => {
        vehicleFactory.clearNPCs();
        console.log('[traffic] Cleared all NPC vehicles');
      };

      controlPanel.addTrafficFolder({
        lodManager,
        onSpawnNpcs: spawnTrafficNpcs,
        onAddCarAhead: () => addCarAhead(25, false, false),
        onAddOncomingCar: () => addCarAhead(40, true, false),
        onAddStoppedCar: () => addCarAhead(30, false, true),
        onClearTraffic: clearAllTraffic,
      });

      // Shift+Click on ground / road to place a vehicle in simulation mode
      const onCanvasPointerDown = (event) => {
        if (!event.shiftKey) return;
        const rect = engine.renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, engine.camera);
        const groundHit = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), groundHit)) return;

        let bestSeg = null;
        let bestDist = Infinity;
        let bestDistAlong = 0;

        for (const seg of roadNetwork.segments.values()) {
          const curve = seg.getCurve();
          const length = seg.lengthM;
          const samples = 20;
          for (let i = 0; i <= samples; i++) {
            const u = i / samples;
            const pt = curve.getPointAt(u);
            const d = Math.hypot(groundHit.x - pt.x, groundHit.z - pt.z);
            if (d < bestDist) {
              bestDist = d;
              bestSeg = seg;
              bestDistAlong = u * length;
            }
          }
        }

        if (bestSeg && bestDist < 25.0) {
          const lane = bestSeg.lanesForward > 0 ? 0 : -1;
          vehicleFactory.spawnNPC({
            segmentId: bestSeg.id,
            lane,
            distanceAlongM: bestDistAlong,
            targetSpeedMps: 8,
          });
          console.log(`[traffic] Shift+Click placed car on ${bestSeg.id} at ${bestDistAlong.toFixed(1)}m`);
        }
      };

      // Hotkeys for simulation: C (car ahead), O (oncoming car), X (clear traffic)
      const toggleAutoDrive = (enabled) => {
        if (!autoDriveController || !ego) return;
        const navState = navigationSystem?.getNavState?.();
        const hasCheckpoint = !!navState?.hasCheckpoint;

        const result = vehicleController.toggleAutoDrive(enabled, ego);
        controlPanel.updateAutoDriveToggle(result.enabled);
        if (result.enabled) {
          // Auto-enable front camera when auto-drive engages
          if (egoExtras?.frontCameraSensor) {
            egoExtras.frontCameraSensor.setEnabled(true);
          }
          if (hasCheckpoint) {
            navigationSystem?.showToast('🤖 Auto Drive Engaged — Navigating to Checkpoint');
          } else {
            navigationSystem?.showToast('🤖 Auto Drive Engaged — Lane Keeping & Free Cruise');
          }
          console.log('[auto-drive] Engaged');
        } else {
          navigationSystem?.showToast(
            result.status === 'ARRIVED' ? '🎉 Auto Drive — Destination Reached!' : '🛑 Auto Drive Disengaged'
          );
          console.log(`[auto-drive] Disengaged (${result.status})`);
        }
      };

      const onSimKeyDown = (event) => {
        if (isTypingTarget(event)) return;
        if (event.code === 'KeyC') {
          addCarAhead(25, false, false);
        } else if (event.code === 'KeyO') {
          addCarAhead(40, true, false);
        } else if (event.code === 'KeyX') {
          clearAllTraffic();
        } else if (event.code === 'KeyT') {
          toggleAutoDrive(!vehicleController.autoDriveEnabled);
        }
      };

      window.addEventListener('keydown', onSimKeyDown);
      engine.renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown);

      cleanupSimInputs = () => {
        window.removeEventListener('keydown', onSimKeyDown);
        engine.renderer.domElement.removeEventListener('pointerdown', onCanvasPointerDown);
      };

      navigationSystem = new NavigationSystem({
        engine,
        network: roadNetwork,
        ego,
      });

      if (ego) {
        // Ego debug extras, wired to its (always-active) sensor stack.
        const egoStack = v2vManager.ensureStack(ego);
        const sensorVisualizer = new SensorVisualizer(engine, { sensorArray: egoStack.proximity });
        const frontCameraSensor = new FrontCameraSensor(engine, { vehicle: ego });

        // Auto-drive controller: sensor-based autonomous navigation with lane changing
        autoDriveController = new AutoDriveController({
          navigationSystem,
          roadNetwork,
          cruiseSpeedMps: 13.9,
          ego,
          vehicles: () => vehicleFactory.vehicles,
        });
        vehicleController.setAutoDriveController(autoDriveController);

        // Instant driver takeover and auto-drive state synchronization
        vehicleController.onDriverTakeover = () => {
          controlPanel.updateAutoDriveToggle(false);
          navigationSystem?.showToast('⚠️ Driver Takeover — Manual Control');
          console.log('[auto-drive] Driver takeover triggered');
        };

        vehicleController.onAutoDriveDisengaged = (status) => {
          controlPanel.updateAutoDriveToggle(false);
          if (status === 'ARRIVED') {
            navigationSystem?.showToast('🎉 Destination Reached! Holding Brake Active.', 4500);
            navigationSystem?.clearCheckpoint?.();
          } else {
            navigationSystem?.showToast('🛑 Auto Drive Disengaged');
          }
          console.log(`[auto-drive] Auto-disengaged (${status})`);
        };

        vehicleController.onCycleCamera = () => {
          cameraRig.toggleMode();
          navigationSystem?.showToast(`📷 Camera: ${cameraRig.mode.toUpperCase()}`);
        };

        vehicleController.onAutoDriveToggled = (enabled) => {
          toggleAutoDrive(enabled);
        };

        vehicleController.onGamepadConnected = (gp) => {
          const name = (gp.id || 'Gamepad').split('(')[0].trim();
          navigationSystem?.showToast(`🎮 Controller Connected: ${name}`, 4000);
        };

        laneGuideVisualizer = new LaneGuideVisualizer(engine, {
          network: roadNetwork,
          ego,
        });

        controlPanel.addSensorsFolder({
          visualizer: sensorVisualizer,
          frontCamera: frontCameraSensor,
          autoDrive: {
            onToggle: (enabled) => toggleAutoDrive(enabled),
          },
        });
        egoExtras = { egoStack, sensorVisualizer, frontCameraSensor };
      }

      controlPanel.addCameraFolder({ cameraRig });

      const vehicleCollisionSystem = new VehicleCollisionSystem({
        vehicles: vehicleFactory.vehicles,
        buildingManager,
        network: roadNetwork,
      });

      minimap = new Minimap({
        network: roadNetwork,
        ego,
        vehicles: vehicleFactory.vehicles,
        navigationSystem,
      });

      // Slot 1: LOD-tiered traffic motion + collision resolution + GPS navigation + HUD minimap.
      runTraffic = (dt) => {
        lodManager.update(dt);
        vehicleCollisionSystem.update();
        if (navigationSystem) navigationSystem.update(dt);
        if (minimap) minimap.update(dt);
      };

      // Slot 2: V2V + sensors, then ego extras + HUD (10 Hz).
      let readoutTimer = 0;
      let totalSimTime = 0;
      runSensors = (dt) => {
        totalSimTime += dt;
        v2vManager.update(dt);
        if (!egoExtras || !ego) return;
        egoExtras.sensorVisualizer.update();
        egoExtras.frontCameraSensor.update(dt);

        // Package sensor readings for ego vehicle & ADAS controller
        const cameraReadings = egoExtras.frontCameraSensor.getLaneReadings();
        const proximityReadings = egoExtras.egoStack.proximity.readings;
        const laneCenteringReadings = egoExtras.egoStack.laneCentering.readings;
        const currentSegment = laneCenteringReadings.segmentId
          ? roadNetwork.getSegment(laneCenteringReadings.segmentId)
          : null;

        ego.sensorData = {
          cameraReadings,
          proximityReadings,
          laneCenteringReadings,
          currentSegment,
          distanceAlongM: laneCenteringReadings.distanceAlongM,
          v2vNeighbors: ego.v2vNeighbors,
        };
        ego.timeSec = totalSimTime;

        // Sync auto-drive toggle if controller self-disengaged (e.g. arrival)
        if (autoDriveController && vehicleController.autoDriveEnabled && !autoDriveController.enabled) {
          vehicleController.autoDriveEnabled = false;
          controlPanel.updateAutoDriveToggle(false);
          const status = autoDriveController.status;
          navigationSystem?.showToast(
            status === 'ARRIVED' ? '🎉 Auto Drive — Destination Reached!' : '🛑 Auto Drive Disengaged'
          );
        }

        // Update predicted path ribbon (lane-aligned FSD ribbon)
        if (laneGuideVisualizer) {
          const autoTel = autoDriveController?.getTelemetry?.() ?? {};
          const navRoute = navigationSystem?.getNavState?.()?.route;
          laneGuideVisualizer.update(totalSimTime, {
            ...autoTel,
            routeWaypoints: navRoute?.waypoints ?? null,
            cameraLateralOffsetM: cameraReadings.detected ? cameraReadings.lateralOffsetM : null,
            cameraDetected: cameraReadings.detected,
            targetLateralOffsetM: cameraReadings.detected
              ? cameraReadings.lateralOffsetM
              : laneCenteringReadings.lateralOffsetM,
          });
        }

        readoutTimer += dt;
        if (readoutTimer >= 0.1) {
          readoutTimer = 0;
          controlPanel.setSensorReadout(
            formatSensorReadout(
              ego,
              egoExtras.egoStack,
              lodManager,
              v2vManager,
              gpuCastEngine,
              egoExtras.frontCameraSensor,
              autoDriveController
            )
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
        laneMergerBuilder,
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
        navigationSystem,
        minimap,
        laneGuideVisualizer,
        autoDriveController,
        spawnTrafficNpcs,
      };
    })
    .catch((error) => console.error('[simulation] failed to load map:', error));

  return session;
}

// ---- Boot ------------------------------------------------------------------------
engine.camera.near = 0.05;
engine.camera.updateProjectionMatrix();
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