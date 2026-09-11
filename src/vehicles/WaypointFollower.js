import { SplineUtils } from '../road/SplineUtils.js';
import { clamp, wrapPi } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const NPC = ConfigDefaults.vehicle.npc;

/**
 * WaypointFollower — lane-following AI controller.
 *
 * Chain drawing, projection-based progress, and heading-matched segment
 * routing (see the Phase 4 design notes). V2V reactions (Phase 10):
 * - 'icw' CRITICAL: clamp target speed to 20% of cruise + brake ≥ 0.7.
 * - 'eebl': clamp target speed to (distanceM − 10) / 12.
 * Alerts arrive one tick late (V2V runs after vehicle updates).
 */
export class WaypointFollower {
  constructor({
    network,
    segmentId,
    lane = -1,
    distanceAlongM = 0,
    targetSpeedMps = NPC.defaultTargetSpeedMps,
    lookaheadM = NPC.lookaheadM,
    steerGain = NPC.steerGain,
    speedGain = NPC.speedGain,
    brakeGain = NPC.brakeGain,
    cornerSlowFactor = NPC.cornerSlowFactor,
    uTurnSpeedMps = NPC.uTurnSpeedMps,
  } = {}) {
    if (!network) throw new TypeError('WaypointFollower: network is required');
    if (!network.getSegment(segmentId)) {
      throw new Error(`WaypointFollower: unknown segment "${segmentId}"`);
    }

    this._network = network;
    this._segmentId = segmentId;
    this._lane = lane;
    this._targetSpeedMps = targetSpeedMps;
    this._lookaheadM = lookaheadM;
    this._steerGain = steerGain;
    this._speedGain = speedGain;
    this._brakeGain = brakeGain;
    this._cornerSlowFactor = cornerSlowFactor;
    this._uTurnSpeedMps = uTurnSpeedMps;

    this._progressM = distanceAlongM;
    /** @type {Array<{ x: number, z: number, d: number }> | null} */
    this._centerline = null;
    this._rebuildPath();
  }

  get segmentId() {
    return this._segmentId;
  }

  get lane() {
    return this._lane;
  }

  get progressM() {
    return this._progressM;
  }

  get targetSpeedMps() {
    return this._targetSpeedMps;
  }

  update(dt, vehicleState, v2vAlerts = []) {
    if (!vehicleState) return { throttle: 0, steering: 0, brake: 1 };

    let segment = this._network.getSegment(this._segmentId);
    if (!segment || !this._centerline) return { throttle: 0, steering: 0, brake: 1 };

    // 1. Progress by projecting the live position onto the centerline.
    this._progressM = this._projectProgress(vehicleState.position);

    // 2. Segment end → advance (intersection routing or dead-end U-turn).
    if (this._atNode(segment)) {
      this._advanceSegment(vehicleState.headingRad);
      segment = this._network.getSegment(this._segmentId);
      if (!segment || !this._centerline) return { throttle: 0, steering: 0, brake: 1 };
    }

    const lengthM = segment.lengthM;
    const travel = this._lane >= 0 ? 1 : -1;
    const progress = clamp(this._progressM, 0, lengthM);
    const targetDistance = clamp(progress + travel * this._lookaheadM, 0, lengthM);
    const u = lengthM > 0 ? targetDistance / lengthM : 0;
    const laneOffset = SplineUtils.laneOffsetM(this._lane, segment.laneWidthM);
    const target = SplineUtils.lateralAt(segment.getCurve(), u, laneOffset);

    // Pure pursuit: steer proportionally to the heading error toward target.
    const dx = target.x - vehicleState.position.x;
    const dz = target.z - vehicleState.position.z;
    const headingError = wrapPi(Math.atan2(dx, -dz) - vehicleState.headingRad);
    const steering = clamp(headingError * this._steerGain, -1, 1);

    // Speed: ease off with steering urgency; creep through U-turns.
    const urgency = Math.min(1, Math.abs(headingError) / 0.7);
    let desiredSpeed = this._targetSpeedMps * (1 - this._cornerSlowFactor * urgency);
    if (Math.abs(headingError) > 1.6) desiredSpeed = Math.min(desiredSpeed, this._uTurnSpeedMps);
    desiredSpeed = Math.max(0, desiredSpeed);

    // ---- V2V safety reactions (Phase 10) ---------------------------------
    let forcedBrake = 0;
    let throttleLocked = false;
    for (const alert of v2vAlerts) {
      if (alert.type === 'icw' && alert.severity === 'critical') {
        desiredSpeed = Math.min(desiredSpeed, this._targetSpeedMps * 0.2);
        forcedBrake = Math.max(forcedBrake, 0.7);
        throttleLocked = true;
      } else if (alert.type === 'eebl') {
        // Proportional to distance: ~cruise at 100 m, crawl near 10 m.
        desiredSpeed = Math.min(desiredSpeed, Math.max(0, (alert.distanceM - 10) / 12));
      }
    }

    // Longitudinal control from the (possibly clamped) desired speed.
    const speedError = desiredSpeed - vehicleState.speedMps;
    let throttle = 0;
    let brake = 0;
    if (speedError > 0.2) throttle = clamp(speedError * this._speedGain, 0, 1);
    else if (speedError < -0.4) brake = clamp(-speedError * this._brakeGain, 0, 1);
    if (forcedBrake > 0) {
      brake = Math.max(brake, forcedBrake);
      throttle = 0;
    }
    if (throttleLocked) throttle = 0;

    return { throttle, steering, brake };
  }

  _atNode(segment) {
    const lengthM = segment.lengthM;
    return this._lane >= 0
      ? this._progressM >= lengthM - NPC.switchEpsilonM
      : this._progressM <= NPC.switchEpsilonM;
  }

  /**
   * Segment routing: among connected segments (excluding the current one),
   * take the one whose travel direction LEAVING the node best matches the
   * current heading. No candidates ⇒ dead end ⇒ U-turn on the same segment.
   */
  _advanceSegment(headingRad) {
    const segment = this._network.getSegment(this._segmentId);
    if (!segment) return;

    const arrivingForward = this._lane >= 0;
    const nodeId = arrivingForward ? segment.endNodeId : segment.startNodeId;
    const node = this._network.getNode(nodeId);
    if (!node) return;

    const forwardX = Math.sin(headingRad);
    const forwardZ = -Math.cos(headingRad);

    const candidates = this._network
      .getSegmentsAtNode(nodeId)
      .filter((s) => s.id !== segment.id && !(s.startNodeId === nodeId && s.endNodeId === nodeId));

    let best = null;
    let bestDot = -Infinity;
    for (const candidate of candidates) {
      const connectsAtStart = candidate.startNodeId === nodeId;
      let exitX;
      let exitZ;
      if (connectsAtStart) {
        const tangent = candidate.getCurve().getTangentAt(0);
        exitX = tangent.x;
        exitZ = tangent.z; // forward travel away from the node
      } else {
        const tangent = candidate.getCurve().getTangentAt(1);
        exitX = -tangent.x;
        exitZ = -tangent.z; // backward travel away from the node
      }
      const dot = exitX * forwardX + exitZ * forwardZ;
      if (dot > bestDot) {
        bestDot = dot;
        best = { segment: candidate, forward: connectsAtStart };
      }
    }

    if (best) {
      this._segmentId = best.segment.id;
      const laneRank = this._lane >= 0 ? this._lane : -this._lane - 1;
      if (best.forward) {
        const lanes = Math.max(1, best.segment.lanesForward);
        this._lane = Math.min(laneRank, lanes - 1);
        this._progressM = 0;
      } else {
        const lanes = Math.max(1, best.segment.lanesBackward);
        this._lane = -1 - Math.min(laneRank, lanes - 1);
        this._progressM = best.segment.lengthM;
      }
    } else {
      // Dead end: U-turn onto the mirrored opposing lane of this segment.
      this._lane = -(this._lane + 1);
      this._progressM = this._lane >= 0 ? 0 : segment.lengthM;
    }

    console.debug(`[WaypointFollower] route: segment ${this._segmentId}, lane ${this._lane}`);
    this._rebuildPath();
  }

  /** Arc-length progress of `position` along the cached centerline samples. */
  _projectProgress(position) {
    const points = this._centerline;
    if (!points || points.length === 0) return this._progressM;

    let nearest = 0;
    let nearestDistSq = Infinity;
    for (let i = 0; i < points.length; i++) {
      const dx = position.x - points[i].x;
      const dz = position.z - points[i].z;
      const distSq = dx * dx + dz * dz;
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = i;
      }
    }

    let best = { s: points[nearest].d, distSq: nearestDistSq };
    if (nearest > 0) best = this._projectOnSpan(points[nearest - 1], points[nearest], position, best);
    if (nearest < points.length - 1) best = this._projectOnSpan(points[nearest], points[nearest + 1], position, best);
    return best.s;
  }

  /** Orthogonal projection onto one sample span; keeps the closer result. */
  _projectOnSpan(a, b, position, best) {
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const lenSq = abx * abx + abz * abz;
    if (lenSq < 1e-9) return best;
    const t = clamp(((position.x - a.x) * abx + (position.z - a.z) * abz) / lenSq, 0, 1);
    const px = a.x + abx * t;
    const pz = a.z + abz * t;
    const dx = position.x - px;
    const dz = position.z - pz;
    const distSq = dx * dx + dz * dz;
    if (distSq < best.distSq) return { s: a.d + (b.d - a.d) * t, distSq };
    return best;
  }

  /** Cache the centerline samples (≈2 m spacing) of the current segment. */
  _rebuildPath() {
    const segment = this._network.getSegment(this._segmentId);
    if (!segment) {
      this._centerline = null;
      return;
    }
    const curve = segment.getCurve();
    const length = curve.getLength();
    const count = Math.max(16, Math.ceil(length / 2) + 1);
    const points = [];
    for (let i = 0; i < count; i++) {
      const p = curve.getPointAt(i / (count - 1)); // arc-length parameterised
      points.push({ x: p.x, z: p.z, d: (i / (count - 1)) * length });
    }
    this._centerline = points;
  }
}