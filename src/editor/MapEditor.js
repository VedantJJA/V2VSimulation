import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { RoadNetwork } from '../road/RoadNetwork.js';
import { RoadMeshBuilder } from '../road/RoadMeshBuilder.js';
import { LaneMarkingBuilder } from '../road/LaneMarkingBuilder.js';
import { IntersectionBuilder } from '../road/IntersectionBuilder.js';
import { RoadSerializer } from '../road/RoadSerializer.js';
import { RoadObstruction } from '../road/RoadObstruction.js';
import { SplineUtils } from '../road/SplineUtils.js';
import { BuildingManager } from '../buildings/BuildingManager.js';
import { CollisionResolver } from '../buildings/CollisionResolver.js';
import { VehicleFactory } from '../vehicles/VehicleFactory.js';
import { createVehicleMesh } from '../utils/GeometryUtils.js';
import { clamp, isTypingTarget } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

import { GizmoManager } from './GizmoManager.js';
import { EditorUI } from './EditorUI.js';
import { RoadDrawTool } from './RoadDrawTool.js';
import { BuildingPlaceTool } from './BuildingPlaceTool.js';
import { ObstructionPlaceTool } from './ObstructionPlaceTool.js';
import { VehiclePlaceTool } from './VehiclePlaceTool.js';

const EDITOR = ConfigDefaults.editor;

const NODE_MARKER_GEOMETRY = new THREE.SphereGeometry(EDITOR.nodeMarkerRadiusM, 12, 8);
const NODE_MARKER_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0x4ac9ff,
  transparent: true,
  opacity: EDITOR.nodeMarkerOpacity,
});
const NDC = new THREE.Vector2();

/**
 * MapEditor — the editor session. Owns an editor-scoped OrbitControls camera
 * (LEFT button reserved for tools), the edited world (network + builders +
 * buildings + obstructions + vehicle spawns with static previews), the four
 * placement tools + GizmoManager + EditorUI chrome. All mutations run the
 * Phase-3 rebuild + collision-resolution contracts. See the Phase 5 notes.
 */
export class MapEditor {
  constructor(engine, { initialData = null, onRunSimulation = null } = {}) {
    this._engine = engine;
    this._sceneManager = engine.sceneManager;
    this._onRunSimulation = onRunSimulation;
    this._camera = engine.camera;

    // ---- Editor camera (LEFT reserved for tools) -----------------------------
    this._camera.position.set(...EDITOR.initialCameraPosition);
    this._orbit = new OrbitControls(this._camera, engine.renderer.domElement);
    this._orbit.enableDamping = true;
    this._orbit.dampingFactor = EDITOR.orbitDampingFactor;
    this._orbit.target.set(0, 0, 0);
    this._orbit.minDistance = EDITOR.orbitMinDistanceM;
    this._orbit.maxDistance = EDITOR.orbitMaxDistanceM;
    this._orbit.maxPolarAngle = Math.PI * 0.495;
    this._orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };

    // ---- Gizmo ----------------------------------------------------------------
    this.gizmoManager = new GizmoManager(engine, {
      onCommit: (object, mode) => this._commitGizmo(object, mode),
      onDraggingChange: (dragging) => {
        this._orbit.enabled = !dragging;
      },
    });

    // ---- Tools ------------------------------------------------------------------
    this.tools = {
      road: new RoadDrawTool(this),
      building: new BuildingPlaceTool(this),
      obstruction: new ObstructionPlaceTool(this),
      vehicle: new VehiclePlaceTool(this),
    };
    this._activeTool = null;

    // ---- World (built by loadMap) ------------------------------------------------
    this.network = null;
    this.roadMeshBuilder = null;
    this.laneMarkingBuilder = null;
    this.intersectionBuilder = null;
    this.buildingManager = null;
    this.collisionResolver = new CollisionResolver();
    this.vehicleSpawns = [];
    this._spawnPreviews = new Map();
    this._spawnSequence = 0;
    this._vehiclePoseResolver = null;
    this._selectedSegmentId = null;
    this._nodeMarkers = null;

    // ---- Raycasting ----------------------------------------------------------------
    this._raycaster = new THREE.Raycaster();
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    // ---- UI + input ------------------------------------------------------------------
    this.ui = new EditorUI(this);

    this._rightDown = null;
    this._rightDragDistance = 0;
    const dom = engine.renderer.domElement;
    this._onPointerDown = (event) => this._handlePointerDown(event);
    this._onPointerMove = (event) => this._handlePointerMove(event);
    this._onPointerUp = (event) => this._handlePointerUp(event);
    this._onContextMenu = (event) => this._handleContextMenu(event);
    this._onKeyDown = (event) => {
      if (event.code === 'Escape' && !isTypingTarget(event)) this._activeTool?.onCancel?.();
    };
    dom.addEventListener('pointerdown', this._onPointerDown);
    dom.addEventListener('pointermove', this._onPointerMove);
    dom.addEventListener('pointerup', this._onPointerUp);
    dom.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('keydown', this._onKeyDown);

    this._unsubscribeFrame = engine.addUpdate(() => this._orbit.update());

    this.loadMap(initialData);
    this.setTool('road');
  }

  get sceneManager() {
    return this._sceneManager;
  }

  get selectedSegmentId() {
    return this._selectedSegmentId;
  }

  get activeTool() {
    return this._activeTool;
  }

  // ---- session lifecycle ------------------------------------------------------

  /** Rebuild the edited world from map JSON (null = blank). */
  loadMap(data) {
    this._clearWorld();

    // Fresh builders per load — the previous set disposed its shared
    // materials/texture along with its meshes.
    this.roadMeshBuilder = new RoadMeshBuilder(this._engine);
    this.laneMarkingBuilder = new LaneMarkingBuilder(this._engine);
    this.intersectionBuilder = new IntersectionBuilder({
      engine: this._engine,
      asphaltMaterial: this.roadMeshBuilder.asphaltMaterial,
    });
    this.network = new RoadNetwork();
    this.buildingManager = new BuildingManager(this._engine, {
      gridCellSizeM: EDITOR.buildingGridCellSizeM,
    });
    this._vehiclePoseResolver = new VehicleFactory({ engine: this._engine, network: this.network });
    this.vehicleSpawns = [];

    if (data) {
      const { vehicleSpawns } = RoadSerializer.deserialize(data, {
        network: this.network,
        meshBuilder: this.roadMeshBuilder,
        markingBuilder: this.laneMarkingBuilder,
        intersectionBuilder: this.intersectionBuilder,
        sceneManager: this._sceneManager,
        buildingManager: this.buildingManager,
      });
      this.vehicleSpawns = vehicleSpawns;
      this._spawnSequence = vehicleSpawns.length;
      for (const spawn of this.vehicleSpawns) this._addSpawnPreview(spawn);
    }

    this._selectedSegmentId = this.network.segmentIds[0] ?? null;
    this._refreshNodeMarkers();
    this.ui.refresh();
  }

  _clearWorld() {
    this.gizmoManager?.detach();

    // Obstructions live on segments — dispose each instance.
    if (this.network) {
      for (const segment of this.network.segments.values()) {
        for (const obstruction of [...segment.obstructions]) {
          obstruction.dispose(this._sceneManager);
        }
      }
    }

    for (const mesh of this._spawnPreviews.values()) this._sceneManager.remove(mesh);
    this._spawnPreviews.clear();
    this.vehicleSpawns = [];

    if (this._nodeMarkers) {
      this._sceneManager.remove(this._nodeMarkers); // shared geometry/material
      this._nodeMarkers = null;
    }
    this.buildingManager?.disposeAll();
    this.intersectionBuilder?.disposeAll();
    this.laneMarkingBuilder?.disposeAll();
    this.roadMeshBuilder?.disposeAll();

    this.network = null;
    this.roadMeshBuilder = null;
    this.laneMarkingBuilder = null;
    this.intersectionBuilder = null;
    this.buildingManager = null;
    this._vehiclePoseResolver = null;
    this._selectedSegmentId = null;
  }

  dispose() {
    this.setTool(null);
    this.ui.dispose();
    this.gizmoManager.dispose();

    const dom = this._engine.renderer.domElement;
    dom.removeEventListener('pointerdown', this._onPointerDown);
    dom.removeEventListener('pointermove', this._onPointerMove);
    dom.removeEventListener('pointerup', this._onPointerUp);
    dom.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);

    this._unsubscribeFrame();
    this._orbit.dispose();
    this._clearWorld();
  }

  // ---- tools --------------------------------------------------------------------

  setTool(name) {
    if (this._activeTool) this._activeTool.onDisable?.();
    this._activeTool = name ? this.tools[name] ?? null : null;
    this.ui.setActiveTool(name ?? null);
    this._activeTool?.onEnable?.();
  }

  // ---- pointer routing ------------------------------------------------------------

  _handlePointerDown(event) {
    if (event.button === 2) {
      this._rightDown = { x: event.clientX, y: event.clientY };
      this._rightDragDistance = 0;
      return;
    }
    if (event.button !== 0) return;
    if (this.gizmoManager.isBusy) return; // this click belongs to the gizmo
    this._activeTool?.onPointerDown?.(event, this.groundPoint(event));
  }

  _handlePointerMove(event) {
    if (this._rightDown && event.buttons & 2) {
      this._rightDragDistance = Math.max(
        this._rightDragDistance,
        Math.hypot(event.clientX - this._rightDown.x, event.clientY - this._rightDown.y)
      );
    }
    if (this.gizmoManager.isBusy) return;
    this._activeTool?.onPointerMove?.(event, this.groundPoint(event));
  }

  _handlePointerUp(event) {
    if (event.button !== 0) return;
    this._activeTool?.onPointerUp?.(event, this.groundPoint(event));
  }

  _handleContextMenu(event) {
    event.preventDefault();
    // A right-click that was NOT an orbit drag cancels the tool's action.
    if (this._rightDragDistance < 6) this._activeTool?.onCancel?.();
    this._rightDown = null;
  }

  // ---- raycasting -------------------------------------------------------------------

  /** Intersection of the pointer ray with the y=0 ground plane (or null). */
  groundPoint(event, target = new THREE.Vector3()) {
    this._updateRaycaster(event);
    return this._raycaster.ray.intersectPlane(this._groundPlane, target);
  }

  /** Building under the pointer (via mesh.userData.building), or null. */
  pickBuilding(event) {
    if (!this.buildingManager) return null;
    const meshes = this.buildingManager.getAll().map((building) => building.mesh);
    if (meshes.length === 0) return null;
    this._updateRaycaster(event);
    const hits = this._raycaster.intersectObjects(meshes, false);
    return hits.length ? hits[0].object.userData.building ?? null : null;
  }

  /**
   * Road/lane under the pointer: raycast the segment ribbons, project the hit
   * onto its segment, derive the clicked lane + distance + travel heading.
   */
  pickRoad(event) {
    if (!this.network || !this.roadMeshBuilder) return null;
    const meshes = [];
    for (const segmentId of this.network.segmentIds) {
      const mesh = this.roadMeshBuilder.getMesh(segmentId);
      if (mesh) meshes.push(mesh);
    }
    if (meshes.length === 0) return null;

    this._updateRaycaster(event);
    const hits = this._raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    const segmentId = hits[0].object.name.startsWith('road:')
      ? hits[0].object.name.slice('road:'.length)
      : null;
    const segment = this.network.getSegment(segmentId);
    if (!segment) return null;

    const projection = this._projectOntoSegment(segment, hits[0].point);
    return { segment, segmentId, point: hits[0].point, ...projection };
  }

  /** Project a world point onto a segment: lane, arc distance, travel heading. */
  _projectOntoSegment(segment, point) {
    const curve = segment.getCurve();
    const length = curve.getLength();
    const count = Math.max(16, Math.ceil(length / 2) + 1);

    const samples = [];
    let nearest = 0;
    let nearestDistSq = Infinity;
    for (let i = 0; i < count; i++) {
      const p = curve.getPointAt(i / (count - 1));
      samples.push(p);
      const dx = point.x - p.x;
      const dz = point.z - p.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = i;
      }
    }

    // Refine on the two adjacent spans (linear projection).
    let distanceAlongM = (nearest / (count - 1)) * length;
    let bestDistSq = nearestDistSq;
    for (const [a, b] of [
      [nearest - 1, nearest],
      [nearest, nearest + 1],
    ]) {
      if (a < 0 || b > count - 1) continue;
      const pa = samples[a];
      const pb = samples[b];
      const abx = pb.x - pa.x;
      const abz = pb.z - pa.z;
      const lenSq = abx * abx + abz * abz;
      if (lenSq < 1e-9) continue;
      const t = clamp(((point.x - pa.x) * abx + (point.z - pa.z) * abz) / lenSq, 0, 1);
      const px = pa.x + abx * t;
      const pz = pa.z + abz * t;
      const dx = point.x - px;
      const dz = point.z - pz;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        distanceAlongM = ((a + t) / (count - 1)) * length;
      }
    }

    distanceAlongM = clamp(distanceAlongM, 0, length);
    const u = length > 0 ? distanceAlongM / length : 0;
    const frame = SplineUtils.computeFrame(curve, u);

    // Lateral offset decides the lane (signed lane index convention).
    const lateral =
      (point.x - frame.position.x) * frame.right.x + (point.z - frame.position.z) * frame.right.z;
    const laneWidth = segment.laneWidthM;
    let lane;
    if (lateral >= 0) {
      lane = Math.min(Math.floor(lateral / laneWidth), segment.lanesForward - 1);
    } else {
      lane = -1 - Math.min(Math.floor(-lateral / laneWidth), segment.lanesBackward - 1);
    }
    const travel = lane >= 0 ? 1 : -1;
    const headingRad = Math.atan2(frame.tangent.x * travel, -frame.tangent.z * travel);

    return { distanceAlongM, lane, headingRad };
  }

  _updateRaycaster(event) {
    const rect = this._engine.renderer.domElement.getBoundingClientRect();
    NDC.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(NDC, this._camera);
  }

  // ---- world operations (tools + UI) ---------------------------------------------

  findNodeNear(position) {
    return this.network ? this.network.findNodeNear(position, EDITOR.gridSnapSizeM) : null;
  }

  /** Create a segment (network handles node snapping → intersections). */
  createRoadSegment(startPosition, endPosition) {
    const segment = this.network.addSegment({ start: startPosition, end: endPosition });
    this.roadMeshBuilder.build(segment);
    this.laneMarkingBuilder.build(segment);
    this.intersectionBuilder.rebuildAll(this.network);
    // Phase-3 contract: a new corridor pushes buildings out of its way.
    this.collisionResolver.onSegmentLanesChanged(segment, this.buildingManager);
    this._refreshNodeMarkers();
    this.selectSegment(segment.id);
    return segment;
  }

  selectSegment(segmentId) {
    this._selectedSegmentId = segmentId ?? null;
    this.ui.refresh();
  }

  getSelectedSegment() {
    return this.network ? this.network.getSegment(this._selectedSegmentId) : undefined;
  }

  setSegmentLanes(segmentId, lanesForward, lanesBackward) {
    const segment = this.network?.getSegment(segmentId);
    if (!segment) return;
    segment.lanesForward = clamp(Math.round(lanesForward), 0, 8);
    segment.lanesBackward = clamp(Math.round(lanesBackward), 0, 8);
    this.roadMeshBuilder.rebuild(segment);
    this.laneMarkingBuilder.rebuild(segment);
    this.intersectionBuilder.rebuildAll(this.network);
    this.collisionResolver.onSegmentLanesChanged(segment, this.buildingManager);
    this.ui.refresh();
  }

  addBuilding({ position, size, rotationY = 0 }) {
    const building = this.buildingManager.addBuilding({ position, size, rotationY });
    this.selectBuilding(building);
    this.validateCollisions(); // placement release → validation
    return building;
  }

  selectBuilding(building) {
    if (!building || !this.buildingManager.has(building)) {
      this.gizmoManager.detach();
      return;
    }
    this.gizmoManager.attach(building.mesh);
  }

  deselectBuilding() {
    this.gizmoManager.detach();
  }

  addObstruction({ segmentId, lane, distanceAlongM, blocking }) {
    const segment = this.network?.getSegment(segmentId);
    if (!segment) return null;
    return new RoadObstruction({
      segment,
      lane,
      distanceAlongM,
      blocking,
      sceneManager: this._sceneManager,
    });
  }

  addVehicleSpawn({ segmentId, lane, distanceAlongM, isEgo = false, targetSpeedMps = 8 }) {
    const segment = this.network?.getSegment(segmentId);
    if (!segment) return null;
    if (isEgo) {
      // Ego is exclusive: a new ego demotes the previous one.
      for (const spawn of this.vehicleSpawns) spawn.isEgo = false;
      this._refreshSpawnPreviews();
    }
    const spawn = {
      id: `spawn-${++this._spawnSequence}`,
      segmentId,
      lane,
      distanceAlongM: clamp(distanceAlongM, 0, segment.lengthM),
      isEgo,
      targetSpeedMps,
    };
    this.vehicleSpawns.push(spawn);
    this._addSpawnPreview(spawn);
    this.ui.refresh();
    return spawn;
  }

  setVehicleSpawnEgo(spawnId, isEgo) {
    const spawn = this.vehicleSpawns.find((s) => s.id === spawnId);
    if (!spawn) return;
    if (isEgo) {
      for (const s of this.vehicleSpawns) s.isEgo = false;
      spawn.isEgo = true;
      this._refreshSpawnPreviews();
    } else if (spawn.isEgo) {
      spawn.isEgo = false;
      this._refreshSpawnPreview(spawn);
    }
    this.ui.refresh();
  }

  removeVehicleSpawn(spawnId) {
    const mesh = this._spawnPreviews.get(spawnId);
    if (mesh) {
      this._sceneManager.remove(mesh);
      this._spawnPreviews.delete(spawnId);
    }
    this.vehicleSpawns = this.vehicleSpawns.filter((s) => s.id !== spawnId);
    this.ui.refresh();
  }

  /** Full Phase-3 validation: every segment footprint, then overlap removal. */
  validateCollisions() {
    if (!this.network || !this.buildingManager) return;
    for (const segmentId of this.network.segmentIds) {
      this.collisionResolver.resolveForSegment(this.network.getSegment(segmentId), this.buildingManager);
    }
    this.collisionResolver.resolveOverlaps(this.buildingManager);
    // The selected building may have been pushed or removed by validation.
    const attached = this.gizmoManager.attached;
    if (attached && !this.buildingManager.has(attached.userData.building)) {
      this.gizmoManager.detach();
    }
  }

  serialize() {
    return RoadSerializer.serialize(this.network, this.buildingManager, this.vehicleSpawns);
  }

  runSimulation() {
    this._onRunSimulation?.(this.serialize());
  }

  // ---- gizmo commit ------------------------------------------------------------

  _commitGizmo(mesh, mode) {
    const building = mesh.userData.building;
    if (!building || !this.buildingManager?.has(building)) return;

    if (mode === 'translate') {
      building.setPosition(mesh.position.x, mesh.position.z);
    } else if (mode === 'rotate') {
      building.setRotationY(mesh.rotation.y);
    } else if (mode === 'scale') {
      const s = mesh.scale;
      const [w, d, h] = building.size;
      building.setSize([w * s.x, d * s.z, h * s.y]);
    }

    this.buildingManager.notifyBuildingChanged(building);
    this.validateCollisions();
  }

  // ---- views ---------------------------------------------------------------------

  setView(name) {
    const target = this._orbit.target;
    if (name === 'top') {
      this._camera.position.set(target.x, EDITOR.topViewHeightM, target.z + 0.001);
    } else {
      this._camera.position.set(
        target.x + EDITOR.orbitViewOffset[0],
        EDITOR.orbitViewOffset[1],
        target.z + EDITOR.orbitViewOffset[2]
      );
    }
    this._orbit.update();
  }

  // ---- visuals ----------------------------------------------------------------------

  /** One small sphere per network node — the clickable anchors of the graph. */
  _refreshNodeMarkers() {
    if (this._nodeMarkers) {
      this._sceneManager.remove(this._nodeMarkers);
      this._nodeMarkers = null;
    }
    if (!this.network) return;
    const nodes = [...this.network.nodes.values()];
    if (nodes.length === 0) return;

    const markers = new THREE.InstancedMesh(NODE_MARKER_GEOMETRY, NODE_MARKER_MATERIAL, nodes.length);
    markers.name = 'editor:node-markers';
    markers.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    nodes.forEach((node, i) => {
      matrix.setPosition(node.position.x, EDITOR.nodeMarkerHeightM, node.position.z);
      markers.setMatrixAt(i, matrix);
    });
    markers.instanceMatrix.needsUpdate = true;
    this._sceneManager.add(markers);
    this._nodeMarkers = markers;
  }

  _addSpawnPreview(spawn) {
    if (!this._vehiclePoseResolver) return;
    const pose = this._vehiclePoseResolver.resolveSpawnPose({
      segmentId: spawn.segmentId,
      lane: spawn.lane,
      distanceAlongM: spawn.distanceAlongM,
    });
    const mesh = createVehicleMesh(spawn.isEgo ? 0xc23b2e : 0x9aa3ad);
    mesh.name = `spawn-preview:${spawn.id}`;
    mesh.position.copy(pose.position);
    mesh.rotation.y = -pose.headingRad;
    this._sceneManager.add(mesh);
    this._spawnPreviews.set(spawn.id, mesh);
  }

  _refreshSpawnPreview(spawn) {
    const old = this._spawnPreviews.get(spawn.id);
    if (old) {
      this._sceneManager.remove(old);
      this._spawnPreviews.delete(spawn.id);
    }
    this._addSpawnPreview(spawn);
  }

  _refreshSpawnPreviews() {
    for (const spawn of this.vehicleSpawns) this._refreshSpawnPreview(spawn);
  }
}