import * as THREE from 'three';
import { SplineUtils } from './SplineUtils.js';
import { ROAD_SURFACE_Y } from './RoadMeshBuilder.js';
import { createObstructionMesh } from '../utils/GeometryUtils.js';

/**
 * RoadObstruction — a placeable prop blocking part or all of a lane.
 *
 * Data: { segmentId, lane (signed), distanceAlongM, blocking: 'partial'|'full' }.
 * 'partial' renders as an orange cone proxy, 'full' as a red barrier box.
 * Position/orientation come from evaluating the segment's LANE CURVE at
 * distanceAlongM (arc-length parameterised, clamped).
 *
 * Documented side effect: constructing an obstruction registers it on its
 * segment (segment.obstructions) — the list RoadSerializer walks.
 */
export class RoadObstruction {
  /**
   * @param {object} options
   * @param {string} [options.id]
   * @param {import('./RoadSegment.js').RoadSegment} options.segment
   * @param {number} [options.lane] signed lane index (default 0 = first forward lane)
   * @param {number} [options.distanceAlongM]
   * @param {'partial' | 'full'} [options.blocking]
   * @param {import('../core/SceneManager.js').SceneManager} [options.sceneManager] auto-adds the mesh when provided
   */
  constructor({ id, segment, lane = 0, distanceAlongM = 0, blocking = 'partial', sceneManager = null }) {
    if (!segment) throw new TypeError('RoadObstruction: requires a segment');
    if (blocking !== 'partial' && blocking !== 'full') {
      throw new Error(`RoadObstruction: blocking must be 'partial' or 'full' (got "${blocking}")`);
    }

    this.id = id ?? `obstruction-${++obstructionSequence}`;
    this.segment = segment; // runtime back-reference (not serialized)
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

  /** Evaluate the lane curve at distanceAlongM and place the proxy. */
  _place() {
    const laneCurve = this.segment.getLaneCurve(this.lane);
    const length = laneCurve.getLength();
    const u = THREE.MathUtils.clamp(this.distanceAlongM / length, 0, 1);
    const frame = SplineUtils.computeFrame(laneCurve, u);

    // Sit on the road surface (cone/box origins are at their centers).
    const position = frame.position;
    position.y += ROAD_SURFACE_Y + this.mesh.geometry.parameters.height / 2;

    this.mesh.position.copy(position);
    this.mesh.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(frame.left, frame.up, frame.tangent)
    );
  }

  /** Re-evaluate position (e.g. after lane width / control point changes). */
  refresh() {
    this._place();
  }

  /** Remove the mesh and unregister from the segment. */
  dispose(sceneManager = null) {
    if (sceneManager) sceneManager.remove(this.mesh);
    this.mesh.geometry.dispose(); // per-instance; materials are shared
    this.mesh = null;
    const index = this.segment.obstructions.indexOf(this);
    if (index >= 0) this.segment.obstructions.splice(index, 1);
    this.segment = null;
  }

  /** Plain-data form used by RoadSerializer. */
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

let obstructionSequence = 0;