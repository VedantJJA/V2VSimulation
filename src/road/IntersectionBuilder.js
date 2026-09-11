import * as THREE from 'three';
import { SplineUtils } from './SplineUtils.js';
import { MARKING_Y } from './LaneMarkingBuilder.js';
import { ASPHALT_TILE_M } from './RoadMeshBuilder.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ROAD = ConfigDefaults.road;

/** Pad sits ABOVE markings: line ends vanish inside the junction. */
export const INTERSECTION_PAD_Y = MARKING_Y + ROAD.padLiftM;
export const CONNECTOR_Y = INTERSECTION_PAD_Y + ROAD.connectorLiftM;

const UP = new THREE.Vector3(0, 1, 0);
const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);

/**
 * IntersectionBuilder — flat pads + simplified lane routing.
 *
 * Pad: a regular N-gon (CircleGeometry) at the node, radius = widest
 * approach half-width + margin; every approach's centreline passes exactly
 * through the node, so a disc covers every end cross-section.
 *
 * Connectors (SIMPLIFIED): one straight quad per (arriving → departing)
 * pair, per lane rank.
 */
export class IntersectionBuilder {
  /**
   * @param {object} options
   * @param {import('../core/Engine.js').Engine} options.engine
   * @param {THREE.Material} options.asphaltMaterial shared with RoadMeshBuilder
   */
  constructor({ engine, asphaltMaterial }) {
    if (!asphaltMaterial) {
      throw new TypeError('IntersectionBuilder: requires the asphaltMaterial owned by RoadMeshBuilder');
    }
    this._sceneManager = engine.sceneManager;
    this._asphaltMaterial = asphaltMaterial; // owned by RoadMeshBuilder — never disposed here
    /** @type {Map<string, THREE.Group>} */
    this._groups = new Map();
    this._connectorMaterial = new THREE.MeshStandardMaterial({
      color: 0xf2f4f6,
      roughness: 0.9,
      transparent: true,
      opacity: 0.9,
    });
  }

  /** Build pads for every node with 2+ connected segments. */
  buildAll(network) {
    for (const nodeId of network.nodeIds) {
      if (network.getSegmentsAtNode(nodeId).length >= 2) this.buildAtNode(network, nodeId);
    }
  }

  buildAtNode(network, nodeId) {
    if (this._groups.has(nodeId)) return this.rebuildAtNode(network, nodeId);
    const node = network.getNode(nodeId);
    const segments = network.getSegmentsAtNode(nodeId);

    const group = new THREE.Group();
    group.name = `intersection:${nodeId}`;
    group.add(this._buildPad(node, segments));
    const connectors = this._buildConnectors(node, segments);
    if (connectors) group.add(connectors);

    this._sceneManager.add(group);
    this._groups.set(nodeId, group);
    return group;
  }

  rebuildAtNode(network, nodeId) {
    const group = this._groups.get(nodeId);
    if (!group) return this.buildAtNode(network, nodeId);
    this._disposeGroup(group);
    this._groups.delete(nodeId);
    return this.buildAtNode(network, nodeId);
  }

  /** Pad sizes depend on lane counts — rebuild everything after lane changes. */
  rebuildAll(network) {
    for (const nodeId of [...this._groups.keys()]) {
      this._disposeGroup(this._groups.get(nodeId));
      this._groups.delete(nodeId);
    }
    this.buildAll(network);
  }

  getGroup(nodeId) {
    return this._groups.get(nodeId);
  }

  disposeAll() {
    for (const group of [...this._groups.values()]) this._disposeGroup(group);
    this._groups.clear();
    this._connectorMaterial.dispose();
  }

  _buildPad(node, segments) {
    let radius = ROAD.padMarginM;
    for (const segment of segments) {
      radius = Math.max(radius, Math.max(segment.lanesForward, segment.lanesBackward) * segment.laneWidthM);
    }
    radius += ROAD.padMarginM;

    const geometry = new THREE.CircleGeometry(radius, ROAD.padSides);
    // Rescale UVs so the shared asphalt texture density matches the roads.
    const uv = geometry.attributes.uv;
    const scale = (radius * 2) / ASPHALT_TILE_M;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * scale, uv.getY(i) * scale);

    const mesh = new THREE.Mesh(geometry, this._asphaltMaterial);
    mesh.name = `intersection:${node.id}:pad`;
    mesh.rotation.x = -Math.PI / 2; // face up
    mesh.position.set(node.position.x, node.position.y + INTERSECTION_PAD_Y, node.position.z);
    mesh.receiveShadow = true;
    return mesh;
  }

  _buildConnectors(node, segments) {
    const positions = [];
    const indices = [];

    // Arrivals/departures per direction family (forward travels start→end).
    const forward = { arrivals: [], departures: [] };
    const backward = { arrivals: [], departures: [] };

    for (const segment of segments) {
      const atStart = segment.startNodeId === node.id;
      const atEnd = segment.endNodeId === node.id;
      if (atStart && atEnd) continue; // self-loop — skip routing
      if (atEnd) forward.arrivals.push({ segment, lanes: range(0, segment.lanesForward) });
      if (atStart) forward.departures.push({ segment, lanes: range(0, segment.lanesForward) });
      if (atStart) backward.arrivals.push({ segment, lanes: range(-segment.lanesBackward, 0) });
      if (atEnd) backward.departures.push({ segment, lanes: range(-segment.lanesBackward, 0) });
    }

    for (const family of [forward, backward]) {
      for (const arrival of family.arrivals) {
        for (const departure of family.departures) {
          if (arrival.segment === departure.segment) continue; // no U-turn quads
          const pairs = Math.min(arrival.lanes.length, departure.lanes.length);
          for (let k = 0; k < pairs; k++) {
            this._addConnectorQuad(
              node,
              arrival.segment,
              arrival.lanes[k],
              departure.segment,
              departure.lanes[k],
              positions,
              indices
            );
          }
        }
      }
    }

    if (positions.length === 0) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, this._connectorMaterial);
    mesh.name = `intersection:${node.id}:connectors`;
    return mesh;
  }

  _addConnectorQuad(node, fromSegment, fromLane, toSegment, toLane, positions, indices) {
    const p1 = this._laneEndpointAtNode(fromSegment, node, fromLane);
    const p2 = this._laneEndpointAtNode(toSegment, node, toLane);

    const direction = new THREE.Vector3().subVectors(p2, p1);
    const left = new THREE.Vector3().crossVectors(UP, direction);
    if (left.lengthSq() < 1e-10) return; // degenerate: coincident endpoints
    left.normalize();

    const half = ROAD.connectorWidthM / 2;
    const y = node.position.y + CONNECTOR_Y;
    const base = positions.length / 3;

    positions.push(
      p1.x - left.x * half, y, p1.z - left.z * half,
      p1.x + left.x * half, y, p1.z + left.z * half,
      p2.x - left.x * half, y, p2.z - left.z * half,
      p2.x + left.x * half, y, p2.z + left.z * half
    );
    // (v0, v1, v2) + (v1, v3, v2) — upward-facing winding.
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }

  /** Lane-curve endpoint (lane center) where a segment touches this node. */
  _laneEndpointAtNode(segment, node, laneIndex) {
    const t = segment.startNodeId === node.id ? 0 : 1;
    return SplineUtils.lateralAt(
      segment.getCurve(),
      t,
      SplineUtils.laneOffsetM(laneIndex, segment.laneWidthM)
    );
  }

  _disposeGroup(group) {
    for (const child of group.children) {
      child.geometry.dispose(); // geometries only; materials shared/owned elsewhere
    }
    this._sceneManager.remove(group);
  }
}