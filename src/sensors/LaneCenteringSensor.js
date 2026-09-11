import { SplineUtils } from '../road/SplineUtils.js';
import { clamp, wrapPi } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const SENSOR = ConfigDefaults.sensor;

/**
 * LaneCenteringSensor — analytic lane tracking, no raycasts.
 *
 * Inputs: position/heading + EITHER a known lane (NPCs: follower state) or
 * nothing (ego: nearest-lane lookup).
 *
 * Output (readings, also returned from update):
 * - segmentId / lane: the lane being tracked.
 * - lateralOffsetM: signed distance from the LANE OFFSET CURVE's centerline
 *   (+ = right of lane center).
 * - headingErrorRad: wrapPi(laneTravelHeading − vehicleHeading).
 * - distanceAlongM: arc distance along the segment.
 */
export class LaneCenteringSensor {
  /** @param {object} options @param {import('../road/RoadNetwork.js').RoadNetwork} options.network */
  constructor({ network }) {
    if (!network) throw new TypeError('LaneCenteringSensor: network is required');
    this._network = network;
    this.readings = this._nullReadings();
  }

  /**
   * @param {import('../vehicles/IVehicleMotionModel.js').VehicleMotionState} vehicleState
   * @param {{ segmentId: string, lane: number } | null} [knownLane]
   */
  update(vehicleState, knownLane = null) {
    if (!vehicleState || this._network.segments.size === 0) {
      this.readings = this._nullReadings();
      return this.readings;
    }

    let segment = null;
    let lane = 0;
    if (knownLane) {
      segment = this._network.getSegment(knownLane.segmentId);
      lane = knownLane.lane ?? 0;
    } else {
      const nearest = this._findNearestLane(vehicleState.position);
      if (!nearest) {
        this.readings = this._nullReadings();
        return this.readings;
      }
      segment = this._network.getSegment(nearest.segmentId);
      lane = nearest.lane;
    }
    if (!segment) {
      this.readings = this._nullReadings();
      return this.readings;
    }

    const projection = this._project(segment, vehicleState.position);
    const laneOffset = SplineUtils.laneOffsetM(lane, segment.laneWidthM);
    const lateralOffsetM = projection.lateral - laneOffset;

    // Lane travel direction: forward lanes follow the curve tangent.
    const travel = lane >= 0 ? 1 : -1;
    const laneHeading = Math.atan2(projection.tangent.x * travel, -projection.tangent.z * travel);

    this.readings = {
      segmentId: segment.id,
      lane,
      lateralOffsetM,
      headingErrorRad: wrapPi(laneHeading - vehicleState.headingRad),
      distanceAlongM: projection.distanceAlongM,
    };
    return this.readings;
  }

  _nullReadings() {
    return { segmentId: null, lane: null, lateralOffsetM: null, headingErrorRad: null, distanceAlongM: null };
  }

  /** Closest segment + the lane under the position (nearest-sample projection). */
  _findNearestLane(position) {
    let best = null;
    for (const segment of this._network.segments.values()) {
      const projection = this._project(segment, position);
      if (!best || projection.distanceSq < best.projection.distanceSq) {
        best = { segmentId: segment.id, lane: this._laneForLateral(segment, projection.lateral), projection };
      }
    }
    return best ? { segmentId: best.segmentId, lane: best.lane } : null;
  }

  /** Signed lane index from a signed lateral offset (road centerline = 0). */
  _laneForLateral(segment, lateral) {
    const laneWidth = segment.laneWidthM;
    if (lateral >= 0) {
      return Math.min(Math.floor(lateral / laneWidth), segment.lanesForward - 1);
    }
    return -1 - Math.min(Math.floor(-lateral / laneWidth), segment.lanesBackward - 1);
  }

  /**
   * Project a position onto a segment's centerline: arc distance, signed
   * lateral offset, tangent, and the 2D distance for segment ranking.
   * (Same nearest-sample + adjacent-span refinement as the follower/editor.)
   */
  _project(segment, position) {
    const curve = segment.getCurve();
    const length = curve.getLength();
    const count = Math.max(SENSOR.laneMinSamples, Math.ceil(length / SENSOR.laneSampleSpacingM) + 1);

    let nearest = 0;
    let nearestDistSq = Infinity;
    const samples = [];
    for (let i = 0; i < count; i++) {
      const p = curve.getPointAt(i / (count - 1));
      samples.push(p);
      const dx = position.x - p.x;
      const dz = position.z - p.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = i;
      }
    }

    // Refine on the two adjacent spans (linear projection).
    let t = nearest;
    let bestDistSq = nearestDistSq;
    for (const [a, b] of [
      [nearest - 1, nearest],
      [nearest, nearest + 1],
    ]) {
      if (a < 0 || b > count - 1) continue;
      const pa = samples[a];
      const pb = samples[b];
      const abx = pb.x - pa.x;
      const abz = pb.z - pa.z;
      const lenSq = abx * abx + abz * abz;
      if (lenSq < 1e-9) continue;
      const s = clamp(((position.x - pa.x) * abx + (position.z - pa.z) * abz) / lenSq, 0, 1);
      const px = pa.x + abx * s;
      const pz = pa.z + abz * s;
      const dx = position.x - px;
      const dz = position.z - pz;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        t = a + s;
      }
    }

    const u = clamp(t / (count - 1), 0, 1);
    const frame = SplineUtils.computeFrame(curve, u);
    const lateral =
      (position.x - frame.position.x) * frame.right.x +
      (position.z - frame.position.z) * frame.right.z;

    return {
      distanceAlongM: u * length,
      lateral,
      tangent: frame.tangent,
      distanceSq: bestDistSq,
    };
  }
}