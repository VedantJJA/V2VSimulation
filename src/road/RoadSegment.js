import * as THREE from 'three';
import { SplineUtils } from './SplineUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ROAD = ConfigDefaults.road;

/**
 * RoadSegment — one drivable stretch between two nodes.
 *
 * controlPoints include both endpoints; the centreline is a CatmullRomCurve3
 * through them (2 points = straight, 3+ = curved). Lanes: signed index,
 * centers at (laneIndex + 0.5) * laneWidthM from the centreline.
 * obstructions: RoadObstruction[] (runtime list, walked by the serializer).
 * Curves are cached; call invalidateCurves() after mutating
 * controlPoints/laneWidthM.
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
    /** @type {import('./RoadObstruction.js').RoadObstruction[]} */
    this.obstructions = [...obstructions];

    this._curve = null;
    this._laneCurves = new Map();
  }

  /** Centreline curve through the control points (cached). */
  getCurve() {
    if (!this._curve) {
      // Default curveType 'centripetal' — handles uneven control spacing
      // without cusps.
      this._curve = new THREE.CatmullRomCurve3(this.controlPoints);
    }
    return this._curve;
  }

  /** Offset curve for one signed lane index (cached per lane index). */
  getLaneCurve(laneIndex) {
    if (!this._laneCurves.has(laneIndex)) {
      this._laneCurves.set(
        laneIndex,
        SplineUtils.buildLaneCurve(this.getCurve(), laneIndex, this.laneWidthM)
      );
    }
    return this._laneCurves.get(laneIndex);
  }

  /** Drop cached curves (call after mutating controlPoints / laneWidthM). */
  invalidateCurves() {
    this._curve = null;
    this._laneCurves.clear();
  }

  /** Arc length of the centreline, in meters. */
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