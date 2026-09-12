import * as THREE from 'three';
import { SplineUtils } from './SplineUtils.js';
import { ROAD_SURFACE_Y } from './RoadMeshBuilder.js';
import { createObstructionMesh } from '../utils/GeometryUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ROAD = ConfigDefaults.road;
export const MAX_ROADS_PER_JUNCTION = 4;

let obstructionSequence = 0;

/**
 * RoadNode — a point where segments meet.
 */
export class RoadNode {
  /**
   * @param {object} options
   * @param {string} options.id
   * @param {THREE.Vector3 | number[]} options.position
   * @param {'square' | 'roundabout'} [options.intersectionType]
   */
  constructor({ id, position, intersectionType = 'square' }) {
    if (!id) throw new TypeError('RoadNode: id is required');
    this.id = id;
    this.position = position.isVector3
      ? position.clone()
      : new THREE.Vector3(position[0], position[1] ?? 0, position[2] ?? 0);
    this.intersectionType = intersectionType;
  }
}

/**
 * RoadObstruction — a placeable prop blocking part or all of a lane.
 */
export class RoadObstruction {
  /**
   * @param {object} options
   * @param {string} [options.id]
   * @param {RoadSegment} options.segment
   * @param {number} [options.lane]
   * @param {number} [options.distanceAlongM]
   * @param {'partial' | 'full'} [options.blocking]
   * @param {import('../core/SceneManager.js').SceneManager} [options.sceneManager]
   */
  constructor({ id, segment, lane = 0, distanceAlongM = 0, blocking = 'partial', sceneManager = null }) {
    if (!segment) throw new TypeError('RoadObstruction: requires a segment');
    if (blocking !== 'partial' && blocking !== 'full') {
      throw new Error(`RoadObstruction: blocking must be 'partial' or 'full' (got "${blocking}")`);
    }

    this.id = id ?? `obstruction-${++obstructionSequence}`;
    this.segment = segment;
    this.segmentId = segment.id;
    this.lane = lane;
    this.distanceAlongM = Math.max(0, distanceAlongM);
    this.blocking = blocking;

    this.mesh = createObstructionMesh({ blocking: this.blocking, laneWidthM: segment.laneWidthM });
    this.mesh.name = `obstruction:${this.id}`;
    this._place();

    segment.obstructions.push(this);

    if (sceneManager) sceneManager.add(this.mesh);
  }

  _place() {
    const laneCurve = this.segment.getLaneCurve(this.lane);
    const length = laneCurve.getLength();
    const u = THREE.MathUtils.clamp(this.distanceAlongM / length, 0, 1);
    const frame = SplineUtils.computeFrame(laneCurve, u);

    const position = frame.position;
    position.y += ROAD_SURFACE_Y + this.mesh.geometry.parameters.height / 2;

    this.mesh.position.copy(position);
    this.mesh.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(frame.left, frame.up, frame.tangent)
    );
  }

  refresh() {
    this._place();
  }

  dispose(sceneManager = null) {
    if (sceneManager) sceneManager.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
    const index = this.segment.obstructions.indexOf(this);
    if (index >= 0) this.segment.obstructions.splice(index, 1);
    this.segment = null;
  }

  toJSON() {
    return {
      id: this.id,
      segmentId: this.segmentId,
      lane: this.lane,
      distanceAlongM: this.distanceAlongM,
      blocking: this.blocking,
    };
  }
}

/**
 * RoadSegment — one drivable stretch between two nodes.
 */
export class RoadSegment {
  constructor({
    id,
    startNodeId,
    endNodeId,
    controlPoints,
    lanesForward = 1,
    lanesBackward = 1,
    laneWidthM = ROAD.laneWidthM,
    speedLimitKph = ROAD.defaultSpeedLimitKph,
    obstructions = [],
    guardRails = 'none',
  } = {}) {
    if (!id) throw new TypeError('RoadSegment: id is required');
    if (!startNodeId || !endNodeId) throw new TypeError('RoadSegment: startNodeId and endNodeId are required');
    if (!Array.isArray(controlPoints) || controlPoints.length < 2) {
      throw new TypeError('RoadSegment: controlPoints needs at least [start, end]');
    }

    this.id = id;
    this.startNodeId = startNodeId;
    this.endNodeId = endNodeId;
    this.controlPoints = controlPoints.map((p) =>
      p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1] ?? 0, p[2] ?? 0)
    );
    this.lanesForward = lanesForward;
    this.lanesBackward = lanesBackward;
    this.laneWidthM = laneWidthM;
    this.speedLimitKph = speedLimitKph;
    this.guardRails = guardRails;
    /** @type {RoadObstruction[]} */
    this.obstructions = [...obstructions];

    this._curve = null;
    this._laneCurves = new Map();
  }

  getCurve() {
    if (!this._curve) {
      this._curve = new THREE.CatmullRomCurve3(this.controlPoints);
    }
    return this._curve;
  }

  getLaneCurve(laneIndex) {
    if (!this._laneCurves.has(laneIndex)) {
      this._laneCurves.set(
        laneIndex,
        SplineUtils.buildLaneCurve(this.getCurve(), laneIndex, this.laneWidthM)
      );
    }
    return this._laneCurves.get(laneIndex);
  }

  invalidateCurves() {
    this._curve = null;
    this._laneCurves.clear();
  }

  get lengthM() {
    return this.getCurve().getLength();
  }

  get halfWidthForwardM() {
    return this.lanesForward * this.laneWidthM;
  }

  get halfWidthBackwardM() {
    return this.lanesBackward * this.laneWidthM;
  }

  get roadWidthM() {
    return (this.lanesForward + this.lanesBackward) * this.laneWidthM;
  }
}

function toVector3(p) {
  return p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1] ?? 0, p[2] ?? 0);
}

/**
 * RoadNetwork — nodes + segments, Maps keyed by id. Pure topology, no meshes.
 *
 * Intersections form via node-snapping: addSegment() resolves each endpoint
 * by position — if an existing node lies within nodeSnapThresholdM (nearest
 * wins), that node is REUSED instead of creating a new one. An internal
 * adjacency map keeps getSegmentsAtNode() O(degree). findNodeNear() exposes
 * the snap query for editor tooling.
 */
export class RoadNetwork {
  /**
   * @param {object} [options]
   * @param {number} [options.nodeSnapThresholdM] default: ConfigDefaults.road.nodeSnapThresholdM
   */
  constructor({ nodeSnapThresholdM = ROAD.nodeSnapThresholdM } = {}) {
    /** @type {Map<string, RoadNode>} */
    this.nodes = new Map();
    /** @type {Map<string, RoadSegment>} */
    this.segments = new Map();
    this._adjacency = new Map(); // nodeId -> Set<segmentId>
    this._nodeSnapThresholdSq = nodeSnapThresholdM * nodeSnapThresholdM;
    this._nodeSequence = 0;
    this._segmentSequence = 0;
  }

  /** True if a node can accept more connected road segments. */
  canConnectNode(nodeId) {
    const adj = this._adjacency.get(nodeId);
    return (adj?.size ?? 0) < MAX_ROADS_PER_JUNCTION;
  }

  get nodeIds() {
    return [...this.nodes.keys()];
  }

  get segmentIds() {
    return [...this.segments.keys()];
  }

  /**
   * Add a node. Idempotent: re-adding an existing id returns the stored node
   * (useful when deserializing).
   */
  addNode(position, id = undefined, intersectionType = 'square') {
    if (id !== undefined && this.nodes.has(id)) return this.nodes.get(id);
    const node = new RoadNode({ id: id ?? `node-${++this._nodeSequence}`, position, intersectionType });
    this.nodes.set(node.id, node);
    this._adjacency.set(node.id, new Set());
    return node;
  }

  setNodeIntersectionType(nodeId, intersectionType) {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.intersectionType = intersectionType;
    }
  }

  /**
   * Add a segment with automatic node-snapping. Endpoints may be coordinates
   * (start/end) or explicit ids (startNodeId/endNodeId). controlPoints can be:
   * - omitted or empty: creates straight 2-point segment [start, end]
   * - interior control points (e.g. [apex]): auto-expands to [start, apex, end]
   * - full sequence [start, ...interior, end]
   */
  addSegment({
    id,
    start,
    end,
    startNodeId,
    endNodeId,
    controlPoints,
    lanesForward = 1,
    lanesBackward = 1,
    laneWidthM = ROAD.laneWidthM,
    speedLimitKph = ROAD.defaultSpeedLimitKph,
    guardRails = 'none',
  } = {}) {
    const startNode =
      startNodeId !== undefined ? this._requireNode(startNodeId) : this._snapOrCreateNode(start);
    const endNode =
      endNodeId !== undefined ? this._requireNode(endNodeId) : this._snapOrCreateNode(end);

    if (!this.canConnectNode(startNode.id)) {
      throw new Error(`RoadNetwork.addSegment: node "${startNode.id}" reached max junction capacity (${MAX_ROADS_PER_JUNCTION} roads)`);
    }
    if (!this.canConnectNode(endNode.id)) {
      throw new Error(`RoadNetwork.addSegment: node "${endNode.id}" reached max junction capacity (${MAX_ROADS_PER_JUNCTION} roads)`);
    }

    if (id !== undefined && this.segments.has(id)) {
      throw new Error(`RoadNetwork.addSegment: duplicate segment id "${id}"`);
    }

    let rawPoints;
    if (Array.isArray(controlPoints) && controlPoints.length > 0) {
      // Check if controlPoints already starts at startNode and ends at endNode
      const first = toVector3(controlPoints[0]);
      const isFull = controlPoints.length >= 2 &&
        Math.hypot(first.x - startNode.position.x, first.z - startNode.position.z) < 0.2;
      if (isFull) {
        rawPoints = controlPoints.map(toVector3);
      } else {
        // Interior control point(s) passed
        rawPoints = [startNode.position, ...controlPoints, endNode.position].map(toVector3);
      }
    } else {
      rawPoints = [startNode.position, endNode.position].map(toVector3);
    }

    rawPoints[0] = startNode.position.clone();
    rawPoints[rawPoints.length - 1] = endNode.position.clone();

    if (startNode === endNode && rawPoints.length < 3) {
      throw new Error('RoadNetwork.addSegment: a loop segment needs at least one interior control point');
    }

    const segment = new RoadSegment({
      id: id ?? `segment-${++this._segmentSequence}`,
      startNodeId: startNode.id,
      endNodeId: endNode.id,
      controlPoints: rawPoints,
      lanesForward,
      lanesBackward,
      laneWidthM,
      speedLimitKph,
      guardRails,
    });

    this.segments.set(segment.id, segment);
    this._adjacency.get(startNode.id).add(segment.id);
    this._adjacency.get(endNode.id).add(segment.id);
    return segment;
  }

  removeSegment(segmentId) {
    const segment = this.segments.get(segmentId);
    if (!segment) return false;
    this.segments.delete(segmentId);
    this._adjacency.get(segment.startNodeId)?.delete(segmentId);
    this._adjacency.get(segment.endNodeId)?.delete(segmentId);
    return true;
  }

  getNode(nodeId) {
    return this.nodes.get(nodeId);
  }

  getSegment(segmentId) {
    return this.segments.get(segmentId);
  }

  /** All segments touching a node (either endpoint). */
  getSegmentsAtNode(nodeId) {
    const ids = this._adjacency.get(nodeId);
    if (!ids) return [];
    return [...ids].map((segmentId) => this.segments.get(segmentId)).filter(Boolean);
  }

  /** Nodes with 2+ connected segments — the intersection candidates. */
  getIntersectionNodeIds() {
    return this.nodeIds.filter((id) => this.getSegmentsAtNode(id).length >= 2);
  }

  /**
   * Nearest node within maxDistanceM (default: the snap threshold), or null.
   * The editor's road tool uses this to preview node snapping.
   */
  findNodeNear(position, maxDistanceM = undefined) {
    const p = toVector3(position);
    const radius = maxDistanceM ?? Math.sqrt(this._nodeSnapThresholdSq);
    let best = null;
    let bestDistSq = radius * radius;
    for (const node of this.nodes.values()) {
      const distSq = node.position.distanceToSquared(p);
      if (distSq <= bestDistSq) {
        best = node;
        bestDistSq = distSq;
      }
    }
    return best;
  }

  _requireNode(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`RoadNetwork: unknown node id "${nodeId}"`);
    return node;
  }

  /** Nearest node within the snap threshold, else a fresh node. */
  _snapOrCreateNode(position) {
    if (position === undefined) {
      throw new TypeError(
        'RoadNetwork.addSegment: each endpoint needs either start/end coordinates or a startNodeId/endNodeId'
      );
    }
    return this.findNodeNear(position) ?? this.addNode(position);
  }
}