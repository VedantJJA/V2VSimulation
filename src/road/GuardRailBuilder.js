import * as THREE from 'three';
import { SplineUtils } from './SplineUtils.js';
import { ROAD_SURFACE_Y } from './RoadMeshBuilder.js';

const POST_SPACING_M = 3.2;
const RAIL_HEIGHT_M = 0.55;
const RAIL_WIDTH_M = 0.08;
const RAIL_THICKNESS_M = 0.30;
const POST_WIDTH_M = 0.09;
const POST_DEPTH_M = 0.09;
const POST_HEIGHT_M = 0.65;
const MARGIN_M = 0.25;

/**
 * GuardRailBuilder — steel W-beam guardrails and vertical posts along road edges.
 */
export class GuardRailBuilder {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this._sceneManager = engine.sceneManager;
    /** @type {Map<string, THREE.Group>} */
    this._groups = new Map();

    this.railMaterial = new THREE.MeshStandardMaterial({
      color: 0xa8b2bd,
      metalness: 0.85,
      roughness: 0.35,
    });
  }

  build(segment) {
    if (this._groups.has(segment.id)) return this.rebuild(segment);

    const mode = segment.guardRails ?? 'none';
    if (mode === 'none') return null;

    const group = new THREE.Group();
    group.name = `guardrails:${segment.id}`;

    const sides = [];
    if (mode === 'both' || mode === 'left') sides.push('left');
    if (mode === 'both' || mode === 'right') sides.push('right');

    const curve = segment.getCurve();
    const length = curve.getLength();
    if (length < 1.0) return null;

    for (const side of sides) {
      const offsetM = side === 'right'
        ? segment.halfWidthForwardM + MARGIN_M
        : -(segment.halfWidthBackwardM + MARGIN_M);

      const sideMesh = this._buildSideRail(curve, length, offsetM);
      if (sideMesh) group.add(sideMesh);
    }

    if (group.children.length === 0) return null;

    this._sceneManager.add(group);
    this._groups.set(segment.id, group);
    return group;
  }

  rebuild(segment) {
    const group = this._groups.get(segment.id);
    if (group) {
      this._disposeGroup(group);
      this._groups.delete(segment.id);
    }
    return this.build(segment);
  }

  getGroup(segmentId) {
    return this._groups.get(segmentId) || null;
  }

  dispose(segment) {
    const group = this._groups.get(segment.id);
    if (!group) return;
    this._disposeGroup(group);
    this._groups.delete(segment.id);
  }

  disposeAll() {
    for (const group of [...this._groups.values()]) {
      this._disposeGroup(group);
    }
    this._groups.clear();
    this.railMaterial.dispose();
  }

  _buildSideRail(curve, length, offsetM) {
    const samples = Math.max(6, Math.ceil(length / 1.5) + 1);
    const postCount = Math.max(2, Math.floor(length / POST_SPACING_M) + 1);

    const positions = [];
    const normals = [];
    const indices = [];

    const railY = ROAD_SURFACE_Y + RAIL_HEIGHT_M;
    const halfThick = RAIL_THICKNESS_M / 2;
    const halfW = RAIL_WIDTH_M / 2;

    // 1. Horizontal Rail Beam (profile with upper and lower corrugated bevels)
    const points = [];
    for (let i = 0; i < samples; i++) {
      const t = i / (samples - 1);
      const frame = SplineUtils.computeFrame(curve, t);
      const p = frame.position.clone().addScaledVector(frame.right, offsetM);
      points.push({ p, right: frame.right, tangent: frame.tangent });
    }

    for (let i = 0; i < samples; i++) {
      const { p, right } = points[i];
      // Slope ends down to ground at endpoints
      const endDrop = (i === 0 || i === samples - 1) ? 0.35 : 0;
      const cy = railY - endDrop;

      const topY = cy + halfThick;
      const midY = cy;
      const botY = cy - halfThick;

      // Outer face and inner face
      const pTop = p.clone().addScaledVector(right, halfW);
      const pMid = p.clone().addScaledVector(right, -halfW * 0.3); // corrugated indent
      const pBot = p.clone().addScaledVector(right, halfW);

      positions.push(
        pTop.x, topY, pTop.z,
        pMid.x, midY, pMid.z,
        pBot.x, botY, pBot.z
      );

      normals.push(right.x, 0.4, right.z);
      normals.push(right.x, 0, right.z);
      normals.push(right.x, -0.4, right.z);

      if (i < samples - 1) {
        const b = i * 3;
        // Upper corrugated face
        indices.push(b, b + 1, b + 3, b + 1, b + 4, b + 3);
        // Lower corrugated face
        indices.push(b + 1, b + 2, b + 4, b + 2, b + 5, b + 4);
      }
    }

    // 2. Vertical Posts
    const postGeo = new THREE.BoxGeometry(POST_WIDTH_M, POST_HEIGHT_M, POST_DEPTH_M);
    const postPositions = postGeo.attributes.position.array;
    const postIndices = postGeo.index ? postGeo.index.array : [];

    for (let k = 0; k < postCount; k++) {
      const t = k / (postCount - 1);
      const frame = SplineUtils.computeFrame(curve, t);
      const postCenter = frame.position.clone().addScaledVector(frame.right, offsetM);
      const py = ROAD_SURFACE_Y + POST_HEIGHT_M / 2;

      const baseIndex = positions.length / 3;

      for (let v = 0; v < postPositions.length; v += 3) {
        const lx = postPositions[v];
        const ly = postPositions[v + 1];
        const lz = postPositions[v + 2];

        // Orient post along frame
        const wx = postCenter.x + frame.right.x * lx + frame.tangent.x * lz;
        const wy = py + ly;
        const wz = postCenter.z + frame.right.z * lx + frame.tangent.z * lz;

        positions.push(wx, wy, wz);
        normals.push(frame.right.x, 0, frame.right.z);
      }

      for (let idx = 0; idx < postIndices.length; idx++) {
        indices.push(baseIndex + postIndices[idx]);
      }
    }
    postGeo.dispose();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, this.railMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  _disposeGroup(group) {
    for (const child of group.children) {
      child.geometry?.dispose();
    }
    this._sceneManager.remove(group);
  }
}
