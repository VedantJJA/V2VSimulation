import * as THREE from 'three';
import { SplineUtils } from './SplineUtils.js';
import { buildRibbonGeometry } from '../utils/GeometryUtils.js';
import { ROAD_SURFACE_Y } from './RoadMeshBuilder.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ROAD = ConfigDefaults.road;

/** Marking height: above the asphalt, below the intersection pads. */
export const MARKING_Y = ROAD_SURFACE_Y + ROAD.markingLiftM;

/**
 * LaneMarkingBuilder — per-segment marking group.
 *
 * Solid yellow centerline between opposing directions (when both exist);
 * solid white pavement edges; dashed white between same-direction lanes
 * (one shared InstancedMesh of box dashes per segment).
 *
 * Offset rules (lateral meters along `right`, centerline = 0):
 *   +k*W (k>=1)  forward boundary   → dashed white
 *   -k*W (k>=1)  backward boundary  → dashed white
 *   0            direction divider  → solid yellow
 *   ±laneCount*W pavement edges     → solid white
 */
export class LaneMarkingBuilder {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this._sceneManager = engine.sceneManager;
    /** @type {Map<string, THREE.Group>} */
    this._groups = new Map();
    this.whiteMaterial = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.9 });
    this.yellowMaterial = new THREE.MeshStandardMaterial({ color: 0xf5c542, roughness: 0.9 });
    this._dashGeometry = new THREE.BoxGeometry(
      ROAD.markingLineWidthM,
      ROAD.dashHeightM,
      ROAD.dashLengthM
    );
  }

  build(segment) {
    if (this._groups.has(segment.id)) return this.rebuild(segment);

    const group = new THREE.Group();
    group.name = `markings:${segment.id}`;

    for (const line of this._solidLines(segment)) {
      group.add(this._buildSolidLine(segment, line));
    }
    const dashes = this._buildDashes(segment);
    if (dashes) group.add(dashes);

    this._sceneManager.add(group);
    this._groups.set(segment.id, group);
    return group;
  }

  /** Dispose the old group entirely and rebuild from current lane counts. */
  rebuild(segment) {
    const group = this._groups.get(segment.id);
    if (!group) return this.build(segment);
    this._disposeGroup(group);
    this._groups.delete(segment.id);
    return this.build(segment);
  }

  getGroup(segmentId) {
    return this._groups.get(segmentId);
  }

  dispose(segment) {
    const group = this._groups.get(segment.id);
    if (!group) return;
    this._disposeGroup(group);
    this._groups.delete(segment.id);
  }

  disposeAll() {
    for (const group of [...this._groups.values()]) this._disposeGroup(group);
    this._groups.clear();
    this._dashGeometry.dispose();
    this.whiteMaterial.dispose();
    this.yellowMaterial.dispose();
  }

  _solidLines(segment) {
    const lines = [];
    if (segment.lanesForward > 0 && segment.lanesBackward > 0) {
      lines.push({ offsetM: 0, material: this.yellowMaterial });
    }
    lines.push({ offsetM: segment.halfWidthForwardM, material: this.whiteMaterial });
    lines.push({ offsetM: -segment.halfWidthBackwardM, material: this.whiteMaterial });
    return lines;
  }

  _dashedOffsets(segment) {
    const offsets = [];
    for (let k = 1; k < segment.lanesForward; k++) offsets.push(k * segment.laneWidthM);
    for (let k = 1; k < segment.lanesBackward; k++) offsets.push(-k * segment.laneWidthM);
    return offsets;
  }

  _buildSolidLine(segment, { offsetM, material }) {
    const geometry = buildRibbonGeometry(segment.getCurve(), {
      offsetLeftM: ROAD.markingLineWidthM / 2 - offsetM,
      offsetRightM: offsetM + ROAD.markingLineWidthM / 2,
      y: MARKING_Y,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `marking:${segment.id}:solid:${offsetM.toFixed(1)}`;
    return mesh;
  }

  _buildDashes(segment) {
    const offsets = this._dashedOffsets(segment);
    if (offsets.length === 0) return null;

    const curve = segment.getCurve();
    const length = curve.getLength();
    const period = ROAD.dashLengthM + ROAD.dashGapM;
    const dashesPerLine = Math.max(0, Math.floor((length - ROAD.dashLengthM) / period) + 1);
    const totalCount = dashesPerLine * offsets.length;
    if (totalCount === 0) return null;

    const instanced = new THREE.InstancedMesh(this._dashGeometry, this.whiteMaterial, totalCount);
    instanced.name = `marking:${segment.id}:dashes`;
    instanced.frustumCulled = false; // world-space instance matrices

    const matrix = new THREE.Matrix4();
    let index = 0;
    for (const offsetM of offsets) {
      for (let k = 0; k < dashesPerLine; k++) {
        const t = (ROAD.dashLengthM / 2 + k * period) / length; // arc-length param
        const frame = SplineUtils.computeFrame(curve, t);
        const position = frame.position.clone().addScaledVector(frame.right, offsetM);
        position.y += MARKING_Y;
        // Orthonormal basis: local +X across the lane, +Z along travel.
        matrix.makeBasis(frame.left, frame.up, frame.tangent);
        matrix.setPosition(position);
        instanced.setMatrixAt(index++, matrix);
      }
    }
    instanced.instanceMatrix.needsUpdate = true;
    return instanced;
  }

  _disposeGroup(group) {
    for (const child of group.children) {
      if (child.isInstancedMesh) {
        child.dispose(); // instance buffers only — geometry is shared
      } else {
        child.geometry.dispose();
      }
    }
    this._sceneManager.remove(group);
  }
}