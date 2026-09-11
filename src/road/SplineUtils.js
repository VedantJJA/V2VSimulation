import * as THREE from 'three';
import { clamp } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ROAD = ConfigDefaults.road;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * SplineUtils — curve sampling, stable frames, and lane offsets.
 *
 * Frame convention ("Frenet-ish" but stable): lateral axis is the world-up
 * projection perpendicular to the tangent (the true Frenet normal flips at
 * inflections). (left, up', tangent) is a proper right-handed orthonormal
 * basis — Matrix4.makeBasis(left, up', tangent) gives local +Z along travel.
 *
 * Lane convention: signed lane index, center at
 * (laneIndex + 0.5) * laneWidthM along `right` — lane 0 and lane −1 are the
 * centerline-adjacent lanes.
 *
 * All curve evaluations use getPointAt/getTangentAt, i.e. ARC-LENGTH
 * parameterised t ∈ [0, 1], so t = distanceM / curve.getLength() exactly.
 * (Ribbon GEOMETRY lives in utils/GeometryUtils.js since Phase 11.)
 */
export const SplineUtils = {
  /** Lateral offset (meters, along `right`) of a lane's center. */
  laneOffsetM(laneIndex, laneWidthM) {
    return (laneIndex + 0.5) * laneWidthM;
  },

  /**
   * Frame at arc-length parameter t.
   * @returns {{ position, tangent, left, right, up }} fresh THREE.Vector3s
   */
  computeFrame(curve, t) {
    const clamped = clamp(t, 0, 1);
    const position = curve.getPointAt(clamped);
    const tangent = curve.getTangentAt(clamped).normalize();

    const left = new THREE.Vector3().crossVectors(UP, tangent);
    if (left.lengthSq() < 1e-10) {
      // Degenerate (near-vertical tangent). Flat road networks never hit
      // this; fall back so the basis stays usable anyway.
      left.set(0, 0, -1);
    }
    left.normalize();

    const up = new THREE.Vector3().crossVectors(tangent, left).normalize();
    const right = left.clone().negate();

    return { position, tangent, left, right, up };
  },

  /** Point at arc-length t, offset laterally by offsetM along `right`. */
  lateralAt(curve, t, offsetM, target = new THREE.Vector3()) {
    const frame = this.computeFrame(curve, t);
    return target.copy(frame.position).addScaledVector(frame.right, offsetM);
  },

  /**
   * Offset ("lane") curve for a signed lane index. Built by sampling the
   * centreline and displacing each sample along the frame's right axis,
   * then refitting a CatmullRom through the displaced points — the standard
   * approximation, since splines have no closed-form offset.
   */
  buildLaneCurve(curve, laneIndex, laneWidthM, { spacingM = ROAD.sampleSpacingM } = {}) {
    const offset = this.laneOffsetM(laneIndex, laneWidthM);
    const length = curve.getLength();
    const samples = Math.max(ROAD.minSamples, Math.ceil(length / spacingM) + 1);
    const points = [];
    for (let i = 0; i < samples; i++) {
      points.push(this.lateralAt(curve, i / (samples - 1), offset));
    }
    return new THREE.CatmullRomCurve3(points);
  },
};