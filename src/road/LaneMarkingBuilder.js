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
    this.network = null;
    this._dashGeometry = new THREE.BoxGeometry(
      ROAD.markingLineWidthM,
      ROAD.dashHeightM,
      ROAD.dashLengthM
    );
  }

  setNetwork(network) {
    this.network = network;
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

  _getTaperedOffsets(segment) {
    const W_fwd = segment.halfWidthForwardM;
    const W_bwd = segment.halfWidthBackwardM;
    if (!this.network) {
      return { left: W_bwd, right: W_fwd };
    }

    const startSegs = this.network.getSegmentsAtNode(segment.startNodeId).filter((s) => s.id !== segment.id);
    let minStartFwd = segment.lanesForward;
    let minStartBwd = segment.lanesBackward;
    for (const s of startSegs) {
      minStartFwd = Math.min(minStartFwd, s.lanesForward);
      minStartBwd = Math.min(minStartBwd, s.lanesBackward);
    }

    const endSegs = this.network.getSegmentsAtNode(segment.endNodeId).filter((s) => s.id !== segment.id);
    let minEndFwd = segment.lanesForward;
    let minEndBwd = segment.lanesBackward;
    for (const s of endSegs) {
      minEndFwd = Math.min(minEndFwd, s.lanesForward);
      minEndBwd = Math.min(minEndBwd, s.lanesBackward);
    }

    const startTotalSegs = this.network.getSegmentsAtNode(segment.startNodeId);
    const endTotalSegs = this.network.getSegmentsAtNode(segment.endNodeId);

    // Merging/tapering ONLY happens when the junction has MORE than two roads
    const hasStartTaper = startTotalSegs.length > 2 && (minStartFwd < segment.lanesForward || minStartBwd < segment.lanesBackward);
    const hasEndTaper = endTotalSegs.length > 2 && (minEndFwd < segment.lanesForward || minEndBwd < segment.lanesBackward);

    if (!hasStartTaper && !hasEndTaper) {
      return { left: W_bwd, right: W_fwd };
    }

    const L = Math.max(segment.lengthM, 1);
    const tMerge = Math.min(25 / L, 0.35);

    const startWFwd = minStartFwd * segment.laneWidthM;
    const startWBwd = minStartBwd * segment.laneWidthM;
    const endWFwd = minEndFwd * segment.laneWidthM;
    const endWBwd = minEndBwd * segment.laneWidthM;

    const smooth = (x) => x * x * (3 - 2 * x);

    const right = (t) => {
      if (hasStartTaper && t < tMerge) {
        const factor = smooth(t / tMerge);
        return startWFwd + (W_fwd - startWFwd) * factor;
      }
      if (hasEndTaper && t > 1 - tMerge) {
        const factor = smooth((1 - t) / tMerge);
        return endWFwd + (W_fwd - endWFwd) * factor;
      }
      return W_fwd;
    };

    const left = (t) => {
      if (hasStartTaper && t < tMerge) {
        const factor = smooth(t / tMerge);
        return startWBwd + (W_bwd - startWBwd) * factor;
      }
      if (hasEndTaper && t > 1 - tMerge) {
        const factor = smooth((1 - t) / tMerge);
        return endWBwd + (W_bwd - endWBwd) * factor;
      }
      return W_bwd;
    };

    return { left, right };
  }

  _getMarkingRange(segment) {
    if (!this.network) return { tStart: 0, tEnd: 1 };
    const L = Math.max(segment.lengthM, 1);
    const W = segment.roadWidthM;
    let sStart = 0;
    const startSegs = this.network.getSegmentsAtNode(segment.startNodeId);
    if (startSegs.length > 2) {
      // 3+ roads junction: mouth setback
      sStart = Math.min(Math.max(W * 0.65, 4.0), L * 0.35);
    } else if (startSegs.length === 2) {
      // 2 roads bend: check if not straight
      const other = startSegs.find((s) => s.id !== segment.id);
      if (other) {
        const dirSelf = segment.getCurve().getTangentAt(0);
        const dirOther = other.startNodeId === segment.startNodeId
          ? other.getCurve().getTangentAt(0)
          : other.getCurve().getTangentAt(1).clone().negate();
        if (dirSelf.dot(dirOther) > -0.99) {
          sStart = Math.min(Math.max(W * 0.85, 4.0), L * 0.35, other.lengthM * 0.35);
        }
      }
    }

    let sEnd = 0;
    const endSegs = this.network.getSegmentsAtNode(segment.endNodeId);
    if (endSegs.length > 2) {
      sEnd = Math.min(Math.max(W * 0.65, 4.0), L * 0.35);
    } else if (endSegs.length === 2) {
      const other = endSegs.find((s) => s.id !== segment.id);
      if (other) {
        const dirSelf = segment.getCurve().getTangentAt(1).clone().negate();
        const dirOther = other.startNodeId === segment.endNodeId
          ? other.getCurve().getTangentAt(0)
          : other.getCurve().getTangentAt(1).clone().negate();
        if (dirSelf.dot(dirOther) > -0.99) {
          sEnd = Math.min(Math.max(W * 0.85, 4.0), L * 0.35, other.lengthM * 0.35);
        }
      }
    }

    return {
      tStart: Math.min(0.45, sStart / L),
      tEnd: Math.max(0.55, 1.0 - sEnd / L),
    };
  }

  _solidLines(segment) {
    const lines = [];
    if (segment.lanesForward > 0 && segment.lanesBackward > 0) {
      lines.push({ offsetM: 0, material: this.yellowMaterial });
    }
    const { left, right } = this._getTaperedOffsets(segment);
    lines.push({ offsetM: right, material: this.whiteMaterial });
    lines.push({
      offsetM: typeof left === 'function' ? (t) => -left(t) : -left,
      material: this.whiteMaterial,
    });
    return lines;
  }

  _dashedOffsets(segment) {
    const offsets = [];
    for (let k = 1; k < segment.lanesForward; k++) offsets.push(k * segment.laneWidthM);
    for (let k = 1; k < segment.lanesBackward; k++) offsets.push(-k * segment.laneWidthM);
    return offsets;
  }

  _buildSolidLine(segment, { offsetM, material }) {
    const half = ROAD.markingLineWidthM / 2;
    const isFn = typeof offsetM === 'function';
    const { tStart, tEnd } = this._getMarkingRange(segment);
    const geometry = buildRibbonGeometry(segment.getCurve(), {
      offsetLeftM: isFn ? (t) => half - offsetM(t) : half - offsetM,
      offsetRightM: isFn ? (t) => offsetM(t) + half : offsetM + half,
      y: MARKING_Y,
      tStart,
      tEnd,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `marking:${segment.id}:solid`;
    return mesh;
  }

  _buildDashes(segment) {
    const offsets = this._dashedOffsets(segment);
    if (offsets.length === 0) return null;

    const curve = segment.getCurve();
    const length = curve.getLength();
    const period = ROAD.dashLengthM + ROAD.dashGapM;
    const { tStart, tEnd } = this._getMarkingRange(segment);
    const usableLength = length * Math.max(0, tEnd - tStart);
    const dashesPerLine = Math.max(0, Math.floor((usableLength - ROAD.dashLengthM) / period) + 1);
    const totalCount = dashesPerLine * offsets.length;
    if (totalCount === 0) return null;

    const { left, right } = this._getTaperedOffsets(segment);

    const instanced = new THREE.InstancedMesh(this._dashGeometry, this.whiteMaterial, totalCount);
    instanced.name = `marking:${segment.id}:dashes`;
    instanced.frustumCulled = false;

    const matrix = new THREE.Matrix4();
    let index = 0;
    for (const offsetM of offsets) {
      for (let k = 0; k < dashesPerLine; k++) {
        const t = tStart + (ROAD.dashLengthM / 2 + k * period) / length;
        if (t > tEnd) continue;
        const curLimit = offsetM > 0
          ? (typeof right === 'function' ? right(t) : right)
          : (typeof left === 'function' ? left(t) : left);

        // Omit dashes if within the merged taper zone
        if (Math.abs(offsetM) > curLimit - 0.4) continue;

        const frame = SplineUtils.computeFrame(curve, t);
        const position = frame.position.clone().addScaledVector(frame.right, offsetM);
        position.y += MARKING_Y;
        matrix.makeBasis(frame.left, frame.up, frame.tangent);
        matrix.setPosition(position);
        instanced.setMatrixAt(index++, matrix);
      }
    }

    instanced.count = index;
    instanced.instanceMatrix.needsUpdate = true;
    return index > 0 ? instanced : null;
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