import * as THREE from 'three';
import { RoadNode } from './RoadNode.js';
import { RoadSegment } from './RoadSegment.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ROAD = ConfigDefaults.road;

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
  addNode(position, id = undefined) {
    if (id !== undefined && this.nodes.has(id)) return this.nodes.get(id);
    const node = new RoadNode({ id: id ?? `node-${++this._nodeSequence}`, position });
    this.nodes.set(node.id, node);
    this._adjacency.set(node.id, new Set());
    return node;
  }

  /**
   * Add a segment with automatic node-snapping. Endpoints may be coordinates
   * (start/end) or explicit ids (startNodeId/endNodeId). controlPoints must
   * include both endpoints; they are re-pinned to the resolved node
   * positions so segments sharing a node join EXACTLY.
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
  } = {}) {
    const startNode =
      startNodeId !== undefined ? this._requireNode(startNodeId) : this._snapOrCreateNode(start);
    const endNode =
      endNodeId !== undefined ? this._requireNode(endNodeId) : this._snapOrCreateNode(end);

    if (id !== undefined && this.segments.has(id)) {
      throw new Error(`RoadNetwork.addSegment: duplicate segment id "${id}"`);
    }

    const points = (controlPoints !== undefined ? controlPoints : [startNode.position, endNode.position])
      .map(toVector3);
    if (points.length < 2) {
      throw new Error('RoadNetwork.addSegment: controlPoints needs at least [start, end]');
    }
    points[0] = startNode.position.clone();
    points[points.length - 1] = endNode.position.clone();

    if (startNode === endNode && points.length < 3) {
      throw new Error('RoadNetwork.addSegment: a loop segment needs at least one interior control point');
    }

    const segment = new RoadSegment({
      id: id ?? `segment-${++this._segmentSequence}`,
      startNodeId: startNode.id,
      endNodeId: endNode.id,
      controlPoints: points,
      lanesForward,
      lanesBackward,
      laneWidthM,
      speedLimitKph,
    });

    this.segments.set(segment.id, segment);
    this._adjacency.get(startNode.id).add(segment.id);
    this._adjacency.get(endNode.id).add(segment.id);
    return segment;
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