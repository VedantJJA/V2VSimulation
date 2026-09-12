import * as THREE from 'three';
import { SplineUtils } from './SplineUtils.js';
import { MARKING_Y } from './LaneMarkingBuilder.js';

/**
 * LaneMergerBuilder — modular lane merger assets for road transitions and intersection mouths.
 *
 * Scenarios:
 * 1. Multi-lane to fewer lanes (e.g. 4-lane to 2-lane, 3-lane to 2-lane).
 * 2. Approach merge into an intersection throat.
 *
 * Modular Assets:
 * - Chevron / Gore Area Hatching: 45° angled warning stripes in the dropped lane dead space.
 * - Painted Merge Arrows: Standard road surface curved arrows indicating lane termination.
 * - Warning Dotted Transition Line: Short warning dashes along the merge corridor boundary.
 */
export class LaneMergerBuilder {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this._sceneManager = engine.sceneManager;
    /** @type {Map<string, THREE.Group>} */
    this._groups = new Map();

    this._whiteMaterial = new THREE.MeshStandardMaterial({
      color: 0xf2f4f6,
      roughness: 0.88,
    });
  }

  /**
   * Build modular merger markings for a road segment where a lane drops.
   * @param {import('./RoadSegment.js').RoadSegment} segment
   * @param {object} options
   * @param {'start' | 'end'} [options.taperEnd='end'] which end of the segment narrows
   * @param {'right' | 'left' | 'both'} [options.side='both'] which lane(s) drop
   * @param {number} [options.taperLengthM=25] length of the taper corridor
   * @param {number} [options.originalWidthM] wider width
   * @param {number} [options.targetWidthM] narrower width
   */
  buildForSegment(segment, {
    taperEnd = 'end',
    side = 'both',
    taperLengthM = 25,
    originalWidthM,
    targetWidthM,
  } = {}) {
    if (this._groups.has(segment.id)) this.dispose(segment.id);

    const curve = segment.getCurve();
    const totalLength = curve.getLength();
    if (totalLength < 10) return null;

    const group = new THREE.Group();
    group.name = `merger:${segment.id}`;

    const whitePositions = [];
    const whiteIndices = [];
    const y = MARKING_Y + 0.002;

    const taperFraction = Math.min(taperLengthM / totalLength, 0.45);
    const startU = taperEnd === 'end' ? 1.0 - taperFraction : 0.0;
    const endU = taperEnd === 'end' ? 1.0 : taperFraction;

    const sides = side === 'both' ? ['right', 'left'] : [side];

    for (const curSide of sides) {
      const isRight = curSide === 'right';
      const sign = isRight ? 1 : -1;

      // 1. Modular Gore Area: 45° Chevron / Hatch Striping in the dropped lane triangle
      this._addGoreChevrons(
        curve,
        startU,
        endU,
        sign,
        originalWidthM,
        targetWidthM,
        y,
        whitePositions,
        whiteIndices
      );

      // 2. Modular Merge Arrow: Curved painted arrow indicating "merge into through lane"
      const arrowU = taperEnd === 'end'
        ? Math.max(0.05, startU - 12 / totalLength)
        : Math.min(0.95, endU + 12 / totalLength);
      const arrowLateral = sign * (targetWidthM + (originalWidthM - targetWidthM) * 0.5);

      this._addMergeArrow(
        curve,
        arrowU,
        arrowLateral,
        -sign, // curve toward the through lane
        y,
        whitePositions,
        whiteIndices
      );

      // 3. Modular Warning Dotted Line along the merge boundary
      this._addWarningDottedLine(
        curve,
        startU,
        endU,
        sign * targetWidthM,
        y,
        whitePositions,
        whiteIndices
      );
    }

    if (whitePositions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(whitePositions, 3));
      geo.setIndex(whiteIndices);
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, this._whiteMaterial);
      mesh.name = `merger:${segment.id}:markings`;
      group.add(mesh);

      this._sceneManager.add(group);
      this._groups.set(segment.id, group);
      return group;
    }

    return null;
  }

  /** Chevron hatch stripes across the dropped lane dead space. */
  _addGoreChevrons(curve, startU, endU, sign, fullWidth, taperWidth, y, positions, indices) {
    const stripes = 6;
    const stripeWidthM = 0.35;

    for (let i = 1; i <= stripes; i++) {
      const f = i / (stripes + 1);
      const u = startU + (endU - startU) * f;
      // Linear width from full to taper
      const currentEdge = fullWidth - (fullWidth - taperWidth) * f;
      const innerW = taperWidth + 0.3;
      const outerW = currentEdge - 0.2;
      if (outerW <= innerW) continue;

      const pInner = SplineUtils.lateralAt(curve, u, sign * innerW);
      // Offset outer point slightly along curve for authentic 45° angle
      const forwardShift = 0.02 * (endU - startU);
      const pOuter = SplineUtils.lateralAt(curve, Math.min(1, u + forwardShift), sign * outerW);

      this._addQuadBetween(pInner, pOuter, stripeWidthM, y, positions, indices);
    }
  }

  /** Curved road surface merge arrow indicating lane reduction. */
  _addMergeArrow(curve, u, lateralOffset, curveDirSign, y, positions, indices) {
    const frame = SplineUtils.computeFrame(curve, u);
    const center = frame.position.clone().addScaledVector(frame.right, lateralOffset);
    const fwd = frame.tangent;
    const right = frame.right;

    // Stem: 4.5m long, 0.45m wide
    const stemStart = center.clone().addScaledVector(fwd, -2.25);
    const stemEnd = center.clone().addScaledVector(fwd, 1.2);
    this._addQuadBetween(stemStart, stemEnd, 0.45, y, positions, indices);

    // Arrowhead: curved tip pointing toward continuing lane
    const tip = center.clone()
      .addScaledVector(fwd, 2.5)
      .addScaledVector(right, curveDirSign * 1.2);
    const wing1 = center.clone()
      .addScaledVector(fwd, 0.8)
      .addScaledVector(right, curveDirSign * 0.4);
    const wing2 = center.clone()
      .addScaledVector(fwd, 1.0)
      .addScaledVector(right, curveDirSign * 1.8);

    this._addTriangle(tip, wing1, wing2, y, positions, indices);
  }

  /** Dotted warning line along merge boundary. */
  _addWarningDottedLine(curve, startU, endU, lateralOffset, y, positions, indices) {
    const dashes = 10;
    const dashLen = (endU - startU) / dashes * 0.45;
    for (let i = 0; i < dashes; i++) {
      const u0 = startU + (endU - startU) * (i / dashes);
      const u1 = u0 + dashLen;
      const p0 = SplineUtils.lateralAt(curve, u0, lateralOffset);
      const p1 = SplineUtils.lateralAt(curve, u1, lateralOffset);
      this._addQuadBetween(p0, p1, 0.20, y, positions, indices);
    }
  }

  _addQuadBetween(p1, p2, width, y, positions, indices) {
    const dir = new THREE.Vector3().subVectors(p2, p1);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.normalize();
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    const half = width / 2;
    const base = positions.length / 3;

    const v0 = p1.clone().addScaledVector(perp, -half);
    const v1 = p2.clone().addScaledVector(perp, -half);
    const v2 = p2.clone().addScaledVector(perp, half);
    const v3 = p1.clone().addScaledVector(perp, half);

    positions.push(
      v0.x, y, v0.z,
      v1.x, y, v1.z,
      v2.x, y, v2.z,
      v3.x, y, v3.z
    );
    indices.push(base, base + 1, base + 3, base + 1, base + 2, base + 3);
  }

  _addTriangle(p0, p1, p2, y, positions, indices) {
    const base = positions.length / 3;
    positions.push(
      p0.x, y, p0.z,
      p1.x, y, p1.z,
      p2.x, y, p2.z
    );
    indices.push(base, base + 1, base + 2);
  }

  dispose(segmentId) {
    const group = this._groups.get(segmentId);
    if (!group) return;
    for (const child of group.children) child.geometry?.dispose();
    this._sceneManager.remove(group);
    this._groups.delete(segmentId);
  }

  disposeAll() {
    for (const [id] of this._groups) this.dispose(id);
    this._whiteMaterial.dispose();
  }
}
