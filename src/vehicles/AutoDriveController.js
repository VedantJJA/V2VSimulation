import { clamp, wrapPi } from '../utils/MathUtils.js';
import { SplineUtils } from '../road/SplineUtils.js';

/**
 * AutoDriveController — Autonomous driving system for V2V simulation.
 *
 * Core Capabilities:
 * 1. Dual Mode Operation:
 *    - ROUTE MODE: Full GPS waypoint route following, multi-segment intersections, U-turns.
 *      Waypoints from RoadRouter are already centered in the driving lane (lateralShift = 0).
 *    - LANE KEEP MODE: Free cruising along road network with lane centering when no checkpoint is set.
 * 2. Dedicated Heading-Aware U-Turn State Machine:
 *    - Activates ONLY when target route is truly behind the vehicle (fwdDot < -0.2 and heading error > 118°).
 *    - Prevents false triggers at ordinary 90° intersection corners.
 *    - Decelerates rapidly to crawl speed (~1.8–2.2 m/s).
 *    - Locks steering into turnaround arc across opposing lanes.
 *    - Multi-point turn (3-point reverse K-turn) fallback if front clearance is restricted (< 3.5m).
 *    - Smoothly transitions back to cruise upon heading alignment.
 * 3. Dynamic Obstruction Evasion & Multi-Lane Selection:
 *    - In Route Mode, cruises right down the route waypoints (lateralShift = 0).
 *    - If obstacle detected (< 18m) and adjacent lane is clear, executes smooth S-curve evasion.
 *    - Safely stops at 5.0m buffer distance if blocked.
 *    - Automatically returns to nominal route lane once obstacle is cleared.
 * 4. Front Camera Lane Centering Fusion:
 *    - Fuses front camera visual edge detection for micro-centering adjustments.
 * 5. Instant Rollout & Predictive Curve Speed Governor:
 *    - Starts decisively from a dead stop (throttle >= 0.35, brake = 0).
 *    - Limits lateral acceleration on curves, stops accurately at destination.
 */
export class AutoDriveController {
  /**
   * @param {object} options
   * @param {import('../navigation/NavigationSystem.js').NavigationSystem} [options.navigationSystem]
   * @param {import('../road/RoadNetwork.js').RoadNetwork} [options.roadNetwork]
   * @param {number} [options.cruiseSpeedMps] target cruise speed (default ~50 km/h)
   * @param {number} [options.lookaheadM] pure-pursuit lookahead distance
   * @param {number} [options.arrivalRadiusM] distance to destination for stop
   */
  constructor({
    navigationSystem = null,
    roadNetwork = null,
    cruiseSpeedMps = 13.9,
    lookaheadM = 16.0,
    arrivalRadiusM = 6.5,
    ego = null,
    vehicles = null,
  } = {}) {
    this.navigationSystem = navigationSystem;
    this.roadNetwork = roadNetwork;
    this.cruiseSpeedMps = cruiseSpeedMps;
    this.lookaheadM = lookaheadM;
    this.arrivalRadiusM = arrivalRadiusM;
    this.ego = ego;
    this.vehicles = vehicles;

    this.enabled = false;
    this.status = 'IDLE'; // IDLE | CRUISING | UTURN_DECEL | UTURN_TURNING | K_TURN_FORWARD_1 | K_TURN_STOP_1 | K_TURN_REVERSE_2 | K_TURN_STOP_2 | K_TURN_FORWARD_3 | ARRIVED | BLOCKED

    // Path tracking state
    this._closestSegIdx = 0;
    this._steerSmooth = 0;
    this._prevHeadingError = 0;
    this._arrivedTimer = 0;
    this._maxCurveDev = 0;
    this._distToTurn = 999;

    // U-turn & K-turn state machine
    this.uTurnActive = false;
    this._uTurnTimer = 0;
    this._uTurnTurnDirection = -1; // -1 = turn left across centerline in right-hand traffic
    this._kTurnTimer = 0;

    // Obstacle evasion & dynamic lane shifting
    this.isEvading = false;
    this.evasionProgress = 1.0;
    this.evasiveShift = 0;
    this.targetEvasiveShift = 0;
    this._evasionCooldown = 0;
    this.laneWidthM = 3.5;
    this._lateralShift = 0;

    // Obstacle tracking
    this._lastObstacleDist = 50.0;
    this._isBlocked = false;
  }

  setVehicles(vehicles) {
    this.vehicles = vehicles;
  }

  setEgo(ego) {
    this.ego = ego;
  }

  setNavigationSystem(navigationSystem) {
    this.navigationSystem = navigationSystem;
  }

  /**
   * Enable/disable auto-drive.
   * @param {boolean} enabled
   * @returns {{ enabled: boolean, status: string }}
   */
  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) {
      this.reset();
    } else {
      this.status = 'CRUISING';
    }
    return { enabled: this.enabled, status: this.status };
  }

  reset() {
    this.status = 'IDLE';
    this._closestSegIdx = 0;
    this._steerSmooth = 0;
    this._prevHeadingError = 0;
    this._arrivedTimer = 0;
    this._maxCurveDev = 0;
    this.uTurnActive = false;
    this._uTurnTimer = 0;
    this._kTurnTimer = 0;
    this.isEvading = false;
    this.evasionProgress = 1.0;
    this.evasiveShift = 0;
    this.targetEvasiveShift = 0;
    this._evasionCooldown = 0;
    this._isBlocked = false;
    this._lateralShift = 0;
  }

  /**
   * Get telemetry for LaneGuideVisualizer, HUD readouts, and UI.
   */
  getTelemetry() {
    return {
      enabled: this.enabled,
      status: this.status,
      uTurnActive: this.uTurnActive,
      uTurnTurnDirection: this._uTurnTurnDirection,
      isLaneChanging: this.isEvading,
      currentLaneIndex: this.targetEvasiveShift !== 0 ? 0 : 1,
      targetLaneIndex: this.targetEvasiveShift !== 0 ? 0 : 1,
      laneChangeProgress: this.evasionProgress,
      lateralShift: this._lateralShift,
      obstacleDistanceM: this._lastObstacleDist,
      isBlocked: this._isBlocked,
    };
  }

  /**
   * Find nearest road segment in network.
   * @private
   */
  _findNearestSegment(pos) {
    const network = this.roadNetwork || this.navigationSystem?.roadNetwork;
    if (!network?.segments) return null;

    let bestSeg = null;
    let bestDistSq = Infinity;
    let bestT = 0;

    for (const seg of network.segments.values()) {
      const curve = seg.getCurve();
      const len = seg.lengthM;
      const samples = Math.max(6, Math.ceil(len / 15));
      for (let s = 0; s <= samples; s++) {
        const t = s / samples;
        const pt = curve.getPointAt(t);
        const dSq = (pt.x - pos.x) ** 2 + (pt.z - pos.z) ** 2;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestSeg = seg;
          bestT = t;
        }
      }
    }

    if (!bestSeg) return null;
    return { segment: bestSeg, t: bestT, distSq: bestDistSq };
  }

  /**
   * Continuous orthogonal projection onto the route polyline.
   * @private
   */
  _projectEgoOntoPolyline(egoPos, waypoints) {
    if (!waypoints || waypoints.length < 2) {
      return { closestPt: waypoints?.[0] || egoPos, segIdx: 0, distSq: 0 };
    }

    let bestDistSq = Infinity;
    let bestSegIdx = 0;
    let bestPt = waypoints[0];

    // Search window around previous segment
    const startIdx = Math.max(0, this._closestSegIdx - 2);
    const endIdx = Math.min(waypoints.length - 1, this._closestSegIdx + 20);

    for (let i = startIdx; i < endIdx; i++) {
      const p1 = waypoints[i];
      const p2 = waypoints[i + 1];
      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      const segLenSq = dx * dx + dz * dz;

      let t = 0;
      if (segLenSq > 1e-4) {
        t = clamp(((egoPos.x - p1.x) * dx + (egoPos.z - p1.z) * dz) / segLenSq, 0, 1);
      }

      const projX = p1.x + t * dx;
      const projZ = p1.z + t * dz;
      const dSq = (egoPos.x - projX) ** 2 + (egoPos.z - projZ) ** 2;

      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestSegIdx = i;
        bestPt = { x: projX, z: projZ };
      }
    }

    // Global search fallback if vehicle moved unexpectedly far
    if (bestDistSq > 120.0 && (startIdx > 0 || endIdx < waypoints.length - 1)) {
      for (let i = 0; i < waypoints.length - 1; i++) {
        const p1 = waypoints[i];
        const p2 = waypoints[i + 1];
        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const segLenSq = dx * dx + dz * dz;
        const t = segLenSq > 1e-4 ? clamp(((egoPos.x - p1.x) * dx + (egoPos.z - p1.z) * dz) / segLenSq, 0, 1) : 0;
        const projX = p1.x + t * dx;
        const projZ = p1.z + t * dz;
        const dSq = (egoPos.x - projX) ** 2 + (egoPos.z - projZ) ** 2;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestSegIdx = i;
          bestPt = { x: projX, z: projZ };
        }
      }
    }

    this._closestSegIdx = bestSegIdx;
    return { closestPt: bestPt, segIdx: bestSegIdx, distSq: bestDistSq };
  }

  /**
   * Find lookahead target point along polyline at adaptive lookahead distance.
   * @private
   */
  _findLookaheadPoint(waypoints, startSegIdx, closestPt, lookaheadDist) {
    let remaining = lookaheadDist;
    let currPt = closestPt;

    for (let i = startSegIdx; i < waypoints.length - 1; i++) {
      const p2 = waypoints[i + 1];
      const dx = p2.x - currPt.x;
      const dz = p2.z - currPt.z;
      const segLen = Math.hypot(dx, dz);

      if (segLen >= remaining) {
        const factor = remaining / (segLen || 1);
        const targetPt = {
          x: currPt.x + dx * factor,
          z: currPt.z + dz * factor,
        };
        const tangent = {
          x: dx / (segLen || 1),
          z: dz / (segLen || 1),
        };
        return { targetPt, tangent, endReached: false };
      }

      remaining -= segLen;
      currPt = p2;
    }

    // Polyline end reached
    const finalPt = waypoints[waypoints.length - 1];
    const prevPt = waypoints[Math.max(0, waypoints.length - 2)];
    const dx = finalPt.x - prevPt.x;
    const dz = finalPt.z - prevPt.z;
    const len = Math.hypot(dx, dz) || 1;
    return {
      targetPt: finalPt,
      tangent: { x: dx / len, z: dz / len },
      endReached: true,
    };
  }

  /**
   * Main auto-drive update loop.
   *
   * @param {number} dt delta time in seconds
   * @param {object} sensorData ego sensor readings
   * @param {object} egoState { position, headingRad, speedMps } from motionModel
   * @returns {{ throttle: number, steering: number, brake: number }}
   */
  update(dt, sensorData = {}, egoState = null) {
    if (!this.enabled || !egoState) {
      return { throttle: 0, steering: 0, brake: 0 };
    }

    const egoPos = egoState.position;
    const egoHeading = egoState.headingRad;
    const egoSpeed = Math.max(0, egoState.speedMps || 0);

    const egoFwdX = Math.sin(egoHeading);
    const egoFwdZ = -Math.cos(egoHeading);
    const egoRightX = Math.cos(egoHeading);
    const egoRightZ = Math.sin(egoHeading);

    // Update cooldown timers
    if (this._evasionCooldown > 0) {
      this._evasionCooldown -= dt;
    }

    // ── 1. PROXIMITY SENSOR & DIRECT VEHICLE HEADWAY EVALUATION ───────
    const prox = sensorData.proximityReadings?.proximityM || {};
    const rawFront = prox.front ?? 50;
    const cornerMin = Math.min(prox['front-left'] ?? 50, prox['front-right'] ?? 50);
    const rayDist = cornerMin < 3.8 ? Math.min(rawFront, cornerMin) : rawFront;

    // Failsafe 2D distance checks to other vehicles (Ego vs NPCs)
    let leadCarDist = 50.0;
    const vehicleList = typeof this.vehicles === 'function' ? this.vehicles() : (this.vehicles || sensorData.vehicles || []);
    if (vehicleList && vehicleList.length > 0) {
      for (const other of vehicleList) {
        if (!other || other === this.ego || !other.motionModel) continue;
        const oState = other.motionModel.getState?.();
        if (!oState || !oState.position) continue;
        const dx = oState.position.x - egoPos.x;
        const dz = oState.position.z - egoPos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < 0.2 || dSq > 2500) continue;

        const dLong = dx * egoFwdX + dz * egoFwdZ;
        const dLat = dx * egoRightX + dz * egoRightZ;

        // Vehicle in forward driving corridor (±2.2m lateral, up to 45m ahead)
        if (dLong > 0.5 && dLong < 45.0 && Math.abs(dLat) < 2.2) {
          const bumperDist = Math.max(0, dLong - 4.4); // account for vehicle lengths
          if (bumperDist < leadCarDist) {
            leadCarDist = bumperDist;
          }
        }
      }
    }

    const fwdDist = Math.min(rayDist, leadCarDist);
    this._lastObstacleDist = fwdDist;

    const leftDist = prox.left ?? prox['side-left'] ?? 50;
    const rightDist = prox.right ?? prox['side-right'] ?? 50;
    const frontLeftDist = prox['front-left'] ?? 50;
    const frontRightDist = prox['front-right'] ?? 50;
    const rearDist = prox.rear ?? 50;

    // Check if we have a destination route or are free-cruising in lane-keep
    const navState = this.navigationSystem?.getNavState?.();
    const hasRoute = !!(navState?.hasCheckpoint && navState?.route?.waypoints?.length >= 2);
    const waypoints = hasRoute ? navState.route.waypoints : null;

    let targetX = 0;
    let targetZ = 0;
    let distToDestination = 999;
    let closestPt = null;
    this._maxCurveDev = 0;
    this._distToTurn = 999;

    // Front bumper position (effective steering axle point)
    const bumperX = egoPos.x + egoFwdX * 2.1;
    const bumperZ = egoPos.z + egoFwdZ * 2.1;

    // ── 2. DESTINATION ROUTE TRACKING OR LANE-KEEP CRUISE ─────────────
    if (hasRoute) {
      // Destination arrival check
      const finalWp = waypoints[waypoints.length - 1];
      distToDestination = Math.hypot(finalWp.x - egoPos.x, finalWp.z - egoPos.z);

      if (distToDestination < this.arrivalRadiusM) {
        this._arrivedTimer += dt;
        if (egoSpeed <= 0.45 || distToDestination < 2.5 || this._arrivedTimer > 0.45) {
          this.status = 'ARRIVED';
          this.enabled = false;
          this._arrivedTimer = 0;
          return { throttle: 0, steering: 0, brake: 1.0 };
        }
        // Within terminal arrival zone: decelerate forcefully to standstill
        return { throttle: 0, steering: 0, brake: 1.0 };
      }
      this._arrivedTimer = 0;

      // Project front bumper onto route polyline
      const proj = this._projectEgoOntoPolyline({ x: bumperX, z: bumperZ }, waypoints);
      closestPt = proj.closestPt;
      const segIdx = proj.segIdx;

      // Lookahead curvature evaluation (sample waypoints 4m, 8m, 12m, 16m, 22m, 30m, 38m ahead)
      let maxCurveDev = 0;
      let distToTurn = 999;
      for (const cd of [4.0, 8.0, 12.0, 16.0, 22.0, 30.0, 38.0]) {
        const aheadRes = this._findLookaheadPoint(waypoints, segIdx, closestPt, cd);
        if (aheadRes && aheadRes.tangent) {
          const aheadH = Math.atan2(aheadRes.tangent.x, -aheadRes.tangent.z);
          const dev = Math.abs(wrapPi(aheadH - egoHeading));
          if (dev > maxCurveDev) maxCurveDev = dev;
          if (dev > 0.18 && distToTurn === 999) {
            distToTurn = cd;
          }
        }
      }
      this._maxCurveDev = maxCurveDev;
      this._distToTurn = distToTurn;

      // Curvature-adaptive lookahead:
      // On straight roads, use 5 to 13m for smooth stability.
      // When a turn is approaching or active, restrict lookahead to 3.5 - 4.8m so the car
      // tracks the curve faithfully and NEVER cuts corners early off the road!
      const baseLookahead = clamp(5.0 + egoSpeed * 0.45, 4.2, 13.0);
      let adaptiveLookahead = baseLookahead;
      if (distToTurn < 25.0) {
        adaptiveLookahead = Math.min(adaptiveLookahead, Math.max(3.6, distToTurn + 1.2));
      }
      if (maxCurveDev > 0.25) {
        adaptiveLookahead = clamp(3.5 + egoSpeed * 0.2, 3.5, 4.8);
      }

      const { targetPt, tangent } = this._findLookaheadPoint(
        waypoints,
        segIdx,
        closestPt,
        adaptiveLookahead
      );

      // Evaluate vector to lookahead target from front bumper
      const toTargetX = targetPt.x - bumperX;
      const toTargetZ = targetPt.z - bumperZ;
      const targetDist = Math.hypot(toTargetX, toTargetZ) || 1;
      const fwdDot = (toTargetX * egoFwdX + toTargetZ * egoFwdZ) / targetDist;
      const headingToTarget = Math.atan2(toTargetX, -toTargetZ);
      const headingErrorToTarget = wrapPi(headingToTarget - egoHeading);

      // ── 3. HEADING-AWARE U-TURN & REAL-LIFE 3-POINT TURN ──────────────
      // U-turn trigger: target is BEHIND vehicle (fwdDot < -0.2) AND heading error > 118° (2.05 rad)
      const isTurnaroundNeeded = fwdDot < -0.2 && Math.abs(headingErrorToTarget) > 2.05;

      const currentSeg = sensorData.currentSegment || this._findNearestSegment(egoPos)?.segment;
      const numLanes = currentSeg?.lanesForward ?? 1;
      const numBwd = currentSeg?.lanesBackward ?? 1;
      const totalLanes = numLanes + numBwd;
      const isNarrowRoad = totalLanes <= 2;

      if (isTurnaroundNeeded && !this.uTurnActive) {
        this.uTurnActive = true;
        this.status = 'UTURN_DECEL';
        this._uTurnTurnDirection = Math.sign(headingErrorToTarget) || -1;
        this._kTurnTimer = 0;
      }

      if (this.uTurnActive) {
        // Phase 0: Rapid deceleration to crawl speed before initiating turn
        if (this.status === 'UTURN_DECEL') {
          if (egoSpeed > 1.6) {
            this._steerSmooth = clamp(this._uTurnTurnDirection * 0.35, -1.0, 1.0);
            return { throttle: 0, steering: this._steerSmooth, brake: 0.85 };
          }
          // On narrow roads, execute a real-life 3-point turn (K-turn)
          this.status = isNarrowRoad ? 'K_TURN_FORWARD_1' : 'UTURN_TURNING';
          this._kTurnTimer = 0;
        }

        // ── 3-POINT TURN: PHASE 1 (Forward turn toward opposite curb) ──
        if (this.status === 'K_TURN_FORWARD_1') {
          this._kTurnTimer += dt;
          const steer = clamp(this._uTurnTurnDirection * 1.0, -1.0, 1.0);
          this._steerSmooth = steer;

          const angleTurned = Math.PI - Math.abs(headingErrorToTarget);
          if (angleTurned > 1.15 || fwdDist < 2.5 || this._kTurnTimer > 3.0) {
            this.status = 'K_TURN_STOP_1';
            this._kTurnTimer = 0.35; // pause for gear shift to reverse
            return { throttle: 0, steering: steer, brake: 1.0 };
          }
          const throttle = egoSpeed < 1.4 ? 0.34 : 0.06;
          const brake = egoSpeed > 1.8 ? 0.40 : 0;
          return { throttle, steering: steer, brake };
        }

        // Stop & shift to reverse
        if (this.status === 'K_TURN_STOP_1') {
          this._kTurnTimer -= dt;
          if (this._kTurnTimer <= 0) {
            this.status = 'K_TURN_REVERSE_2';
            this._kTurnTimer = 2.4;
          }
          return { throttle: 0, steering: clamp(this._uTurnTurnDirection * 1.0, -1.0, 1.0), brake: 1.0 };
        }

        // Phase 2: Reverse with counter-steering
        if (this.status === 'K_TURN_REVERSE_2') {
          this._kTurnTimer -= dt;
          const revSteer = clamp(-this._uTurnTurnDirection * 1.0, -1.0, 1.0);
          this._steerSmooth = revSteer;

          if (Math.abs(headingErrorToTarget) < 0.70 || rearDist < 2.5 || this._kTurnTimer <= 0) {
            this.status = 'K_TURN_STOP_2';
            this._kTurnTimer = 0.35; // pause for gear shift to forward
            return { throttle: 0, steering: revSteer, brake: 1.0 };
          }
          return { throttle: -0.38, steering: revSteer, brake: 0 };
        }

        // Stop & shift to forward
        if (this.status === 'K_TURN_STOP_2') {
          this._kTurnTimer -= dt;
          if (this._kTurnTimer <= 0) {
            this.status = 'K_TURN_FORWARD_3';
          }
          return { throttle: 0, steering: 0, brake: 1.0 };
        }

        // Phase 3: Roll forward into target lane
        if (this.status === 'K_TURN_FORWARD_3') {
          const steer = clamp(2.2 * headingErrorToTarget, -0.65, 0.65);
          this._steerSmooth = steer;

          if (Math.abs(headingErrorToTarget) < 0.35) {
            this.uTurnActive = false;
            this.status = 'CRUISING';
          } else {
            const throttle = egoSpeed < 1.8 ? 0.35 : 0.12;
            const brake = egoSpeed > 2.4 ? 0.35 : 0;
            return { throttle, steering: steer, brake };
          }
        }

        // ── WIDE ROAD CONTINUOUS U-TURN (Multi-lane roads) ──
        if (this.status === 'UTURN_TURNING') {
          if (fwdDist < 2.8 && egoSpeed < 1.8) {
            this.status = 'K_TURN_REVERSE_2';
            this._kTurnTimer = 2.0;
          } else {
            const turnSteer = clamp(this._uTurnTurnDirection * 1.0, -1.0, 1.0);
            this._steerSmooth = turnSteer;

            if (Math.abs(headingErrorToTarget) < 0.42) {
              this.uTurnActive = false;
              this.status = 'CRUISING';
            } else {
              const throttle = egoSpeed < 1.8 ? 0.35 : 0.08;
              const brake = egoSpeed > 2.5 ? 0.45 : 0;
              return { throttle, steering: turnSteer, brake };
            }
          }
        }
      }

      // ── 4. DYNAMIC OBSTACLE EVASION (ROUTE MODE) ─────────────────────
      const laneW = currentSeg?.laneWidthM ?? 3.5;
      this.laneWidthM = laneW;

      const leftClear = leftDist > 7.0 && frontLeftDist > 11.0;
      const rightClear = rightDist > 7.5 && frontRightDist > 12.0;

      if (numLanes >= 2) {
        // Multi-lane road: if obstacle ahead and left is clear, pass in adjacent lane
        if (fwdDist < 18.0 && !this.isEvading && this._evasionCooldown <= 0 && leftClear) {
          this.isEvading = true;
          this.evasionProgress = 0;
          this.targetEvasiveShift = -laneW; // shift left 1 lane
          this._evasionCooldown = 3.5;
        } else if (this.isEvading && fwdDist > 24.0 && this._evasionCooldown <= 0 && rightClear) {
          // Obstacle passed: return to nominal route lane
          this.isEvading = true;
          this.evasionProgress = 0;
          this.targetEvasiveShift = 0; // return to lane center
          this._evasionCooldown = 3.5;
        }
      } else {
        // Single lane road: stay strictly in lane center (0 offset)
        // If an obstacle or car blocks the road, stop safely at 5.5m buffer
        this.targetEvasiveShift = 0;
      }

      // Smooth S-curve transition for evasive lateral shift
      if (this.evasionProgress < 1.0) {
        this.evasionProgress = clamp(this.evasionProgress + dt / 2.0, 0, 1.0);
        const sCurve = this.evasionProgress * this.evasionProgress * (3 - 2 * this.evasionProgress);
        this._lateralShift = this.evasiveShift + (this.targetEvasiveShift - this.evasiveShift) * sCurve;
        if (this.evasionProgress >= 1.0) {
          this.evasiveShift = this.targetEvasiveShift;
          this._lateralShift = this.targetEvasiveShift;
          if (this.targetEvasiveShift === 0) {
            this.isEvading = false;
          }
        }
      } else {
        this._lateralShift = this.targetEvasiveShift;
      }

      // Pure pursuit target point with evasive shift (0 when cruising normally)
      const perpX = -tangent.z;
      const perpZ = tangent.x;
      targetX = targetPt.x + perpX * this._lateralShift;
      targetZ = targetPt.z + perpZ * this._lateralShift;
    } else {
      // ── FREE DRIVE / LANE KEEPING MODE (NO CHECKPOINT) ───────────────
      const nearest = this._findNearestSegment(egoPos);
      if (!nearest) {
        return { throttle: 0.15, steering: 0, brake: 0 };
      }

      const seg = nearest.segment;
      const bestT = nearest.t;
      const curve = seg.getCurve();
      const segLen = seg.lengthM;
      const laneW = seg.laneWidthM || 3.5;
      this.laneWidthM = laneW;

      const frame0 = SplineUtils.computeFrame(curve, bestT);
      const dot = egoFwdX * frame0.tangent.x + egoFwdZ * frame0.tangent.z;
      const travelDir = dot >= 0 ? 1 : -1;

      const numFwd = seg.lanesForward ?? 1;
      const numBwd = seg.lanesBackward ?? 1;
      const sign = travelDir >= 0 ? 1 : -1;
      const lanesInDir = travelDir >= 0 ? numFwd : numBwd;

      // Curve lookahead evaluation
      const aheadS1 = Math.min(segLen, bestT * segLen + travelDir * 10.0);
      const aheadS2 = Math.min(segLen, bestT * segLen + travelDir * 18.0);
      const f1 = SplineUtils.computeFrame(curve, clamp(aheadS1 / segLen, 0, 1));
      const f2 = SplineUtils.computeFrame(curve, clamp(aheadS2 / segLen, 0, 1));
      const h1 = Math.atan2(travelDir * f1.tangent.x, -travelDir * f1.tangent.z);
      const h2 = Math.atan2(travelDir * f2.tangent.x, -travelDir * f2.tangent.z);
      this._maxCurveDev = Math.max(Math.abs(wrapPi(h1 - egoHeading)), Math.abs(wrapPi(h2 - egoHeading)));

      // Base driving lane center from road centerline in right-hand traffic
      const baseMult = lanesInDir >= 2 ? 1.5 : 0.5;
      const baseLaneOffset = sign * baseMult * laneW;

      // Evasion in free-cruise mode
      if (lanesInDir >= 2) {
        const leftClear = leftDist > 7.0 && frontLeftDist > 11.0;
        const rightClear = rightDist > 8.0 && frontRightDist > 12.0;

        if (fwdDist < 18.0 && !this.isEvading && this._evasionCooldown <= 0 && leftClear) {
          this.isEvading = true;
          this.evasionProgress = 0;
          this.targetEvasiveShift = -sign * laneW;
          this._evasionCooldown = 3.5;
        } else if (this.isEvading && fwdDist > 24.0 && this._evasionCooldown <= 0 && rightClear) {
          this.isEvading = true;
          this.evasionProgress = 0;
          this.targetEvasiveShift = 0;
          this._evasionCooldown = 3.5;
        }
      } else {
        this.targetEvasiveShift = 0;
      }

      if (this.evasionProgress < 1.0) {
        this.evasionProgress = clamp(this.evasionProgress + dt / 2.0, 0, 1.0);
        const sCurve = this.evasionProgress * this.evasionProgress * (3 - 2 * this.evasionProgress);
        this._lateralShift = this.evasiveShift + (this.targetEvasiveShift - this.evasiveShift) * sCurve;
        if (this.evasionProgress >= 1.0) {
          this.evasiveShift = this.targetEvasiveShift;
          this._lateralShift = this.targetEvasiveShift;
          if (this.targetEvasiveShift === 0) this.isEvading = false;
        }
      } else {
        this._lateralShift = this.targetEvasiveShift;
      }

      const totalOffset = baseLaneOffset + this._lateralShift;

      const lookaheadM = clamp(14.0 + egoSpeed * 0.8, 12.0, 28.0);
      const targetS = bestT * segLen + travelDir * lookaheadM;
      const u = clamp(targetS / segLen, 0, 1);
      const frame = SplineUtils.computeFrame(curve, u);

      targetX = frame.position.x + frame.right.x * totalOffset;
      targetZ = frame.position.z + frame.right.z * totalOffset;
    }

    // ── 5. PURE PURSUIT STEERING + SENSOR CENTERING FUSION ─────────────
    const adjustedHeading = Math.atan2(targetX - bumperX, -(targetZ - bumperZ));
    let finalHeadingError = wrapPi(adjustedHeading - egoHeading);

    // Cross-track error correction (lateral offset from lane polyline at front bumper)
    if (hasRoute && closestPt && !this.uTurnActive) {
      const toBumperX = bumperX - closestPt.x;
      const toBumperZ = bumperZ - closestPt.z;
      const crossTrack = toBumperX * egoRightX + toBumperZ * egoRightZ;
      finalHeadingError -= clamp(crossTrack * 0.26, -0.4, 0.4);
    }

    // Front camera lane centering micro-adjustment when cruising in-lane
    if (!this.isEvading && !this.uTurnActive) {
      const cam = sensorData.cameraReadings;
      if (cam && cam.detected && cam.lateralOffsetM != null) {
        finalHeadingError += cam.headingErrorRad * 0.15 - clamp(cam.lateralOffsetM, -1.5, 1.5) * 0.08;
      }
    }

    // PD steering computation
    const headingDeriv = (finalHeadingError - this._prevHeadingError) / Math.max(dt, 0.001);
    this._prevHeadingError = finalHeadingError;

    const kP = 2.1;
    const kD = 0.14;
    const rawSteer = clamp(kP * finalHeadingError + kD * headingDeriv, -1.0, 1.0);

    const steerSlew = 4.2 * dt;
    this._steerSmooth += clamp(rawSteer - this._steerSmooth, -steerSlew, steerSlew);
    this._steerSmooth = clamp(this._steerSmooth, -1.0, 1.0);

    // ── 6. SPEED REGULATION, PROACTIVE CORNER BRAKING & OBSTACLE STOPPING ──
    let targetSpeed = this.cruiseSpeedMps;
    this.status = 'CRUISING';

    // 1. Proactive Lookahead Cornering Deceleration:
    // If a turn / intersection is ahead, brake down to safe turning speed BEFORE entering!
    if (this._distToTurn != null && this._distToTurn < 35.0) {
      const safeTurnSpeed = clamp(2.8 + (1.0 - Math.min(1.57, this._maxCurveDev) / 1.57) * 1.4, 2.7, 3.8);
      const turnDistRatio = clamp(this._distToTurn / 30.0, 0.0, 1.0);
      const approachSpeed = safeTurnSpeed + turnDistRatio * (this.cruiseSpeedMps - safeTurnSpeed);
      targetSpeed = Math.min(targetSpeed, approachSpeed);
    } else if (this._maxCurveDev > 0.25) {
      const safeTurnSpeed = clamp(2.8 + (1.0 - Math.min(1.57, this._maxCurveDev) / 1.57) * 1.4, 2.7, 3.8);
      targetSpeed = Math.min(targetSpeed, safeTurnSpeed);
    }

    // Curve speed governor based on current steering
    const absSteer = Math.abs(this._steerSmooth);
    if (absSteer > 0.12) {
      const curveFactor = clamp(1.0 - (absSteer - 0.12) * 0.9, 0.24, 1.0);
      targetSpeed = Math.min(targetSpeed, Math.max(2.8, this.cruiseSpeedMps * curveFactor));
    }

    // Arrival deceleration ramp towards destination checkpoint
    if (distToDestination < 35.0) {
      const arrivalRatio = clamp((distToDestination - 7.0) / 28.0, 0.0, 1.0);
      const targetArrivalSpeed = 1.6 + arrivalRatio * (this.cruiseSpeedMps - 1.6);
      targetSpeed = Math.min(targetSpeed, targetArrivalSpeed);
    }

    // Proportional obstacle / lead vehicle braking
    let obstacleBrake = 0;
    if (fwdDist < 5.5) {
      // Stopped safely behind lead car or obstacle
      this._isBlocked = true;
      this.status = 'BLOCKED';
      targetSpeed = 0;
      obstacleBrake = 1.0;
    } else if (fwdDist < 16.0) {
      this._isBlocked = true;
      const ratio = clamp((fwdDist - 5.5) / 10.5, 0, 1.0);
      targetSpeed = Math.min(targetSpeed, 1.2 + ratio * 6.0);
      obstacleBrake = (1.0 - ratio) * 0.85;
    } else {
      this._isBlocked = false;
    }

    // Throttle / Brake output
    let throttle = 0;
    let brake = obstacleBrake;
    const speedError = targetSpeed - egoSpeed;

    if (targetSpeed <= 0.2) {
      throttle = 0;
      brake = Math.max(brake, 1.0);
    } else if (egoSpeed < 0.8 && targetSpeed > 1.5) {
      // Start rolling from a stop decisively with zero brake
      throttle = clamp(0.38 + speedError * 0.04, 0.35, 0.65);
      brake = 0;
    } else if (speedError > 0.3) {
      throttle = clamp(speedError * 0.35, 0.15, 1.0);
      brake = 0;
    } else if (speedError < -0.5) {
      // Decisive cornering / headway braking
      throttle = 0;
      brake = Math.max(brake, clamp(-speedError * 0.35, 0.30, 0.95));
    } else {
      throttle = clamp(0.14 + speedError * 0.12, 0.05, 0.35);
    }

    return {
      throttle: clamp(throttle, 0, 1),
      steering: this._steerSmooth,
      brake: clamp(brake, 0, 1),
    };
  }

  dispose() {
    this.enabled = false;
    this.navigationSystem = null;
    this.roadNetwork = null;
  }
}
