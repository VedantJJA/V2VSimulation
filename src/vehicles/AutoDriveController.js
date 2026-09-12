import { clamp, wrapPi } from '../utils/MathUtils.js';

/**
 * AutoDriveController — Autonomous driving system for V2V simulation.
 *
 * SENSORY ARCHITECTURE (Zero-Cheat Policy):
 * This controller perceives the world exclusively through real autonomous vehicle data channels:
 * 1. SIMULATED GPS: Vehicle position (X, Z), heading, and odometry speed.
 * 2. MINIMAP / NAVIGATION ROUTE: GPS polyline waypoints and target destination coordinates.
 * 3. ONBOARD SENSORS:
 *    - Proximity Sensor Array: Continuous analog distance readings (meters) for obstacles.
 *    - Front Camera: Vision-based lane center offset and heading error.
 *
 * Core Capabilities:
 * 1. Dual Mode Operation:
 *    - ROUTE MODE: Full GPS waypoint navigation, intersection turns, proactive curve braking.
 *    - FREE DRIVE MODE: Vision-based lane centering via Front Camera and GPS heading.
 * 2. Dedicated Heading-Aware U-Turn & K-Turn State Machine:
 *    - Activates ONLY when target destination is behind vehicle (fwdDot < -0.2, heading error > 118°).
 *    - Decelerates rapidly to crawl speed (~1.8 m/s).
 *    - Narrow road clearance triggers 3-point reverse K-turn; wide clearance executes continuous turnaround arc.
 * 3. Dynamic Obstacle Evasion & Headway Braking:
 *    - Proximity distance sensors continuously measure forward and side clearances.
 *    - Proportional analog braking ramps down speed smoothly, stopping safely at 5.0m buffer.
 *    - Smooth S-curve lane shift if adjacent clearance is open (> 11m).
 * 4. Solid Destination Arrival & Park Hold:
 *    - Terminal arrival zone enforces forceful deceleration to a complete standstill.
 *    - Latches permanently into 'ARRIVED' status with 100% holding brake.
 */
export class AutoDriveController {
  /**
   * @param {object} options
   * @param {import('../navigation/NavigationSystem.js').NavigationSystem} [options.navigationSystem]
   * @param {number} [options.cruiseSpeedMps] target cruise speed (default ~50 km/h)
   * @param {number} [options.lookaheadM] pure-pursuit lookahead distance
   * @param {number} [options.arrivalRadiusM] distance to destination for stop
   * @param {object} [options.ego] ego vehicle reference
   */
  constructor({
    navigationSystem = null,
    cruiseSpeedMps = 13.9,
    lookaheadM = 16.0,
    arrivalRadiusM = 7.0,
    ego = null,
  } = {}) {
    this.navigationSystem = navigationSystem;
    this.cruiseSpeedMps = cruiseSpeedMps;
    this.lookaheadM = lookaheadM;
    this.arrivalRadiusM = arrivalRadiusM;
    this.ego = ego;

    this.enabled = false;
    this.status = 'IDLE'; // IDLE | CRUISING | UTURN_DECEL | UTURN_TURNING | K_TURN_FORWARD_1 | K_TURN_STOP_1 | K_TURN_REVERSE_2 | K_TURN_STOP_2 | K_TURN_FORWARD_3 | ARRIVED | BLOCKED
    this._isArrived = false;

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
    this._uTurnTurnDirection = -1;
    this._kTurnTimer = 0;

    // Obstacle evasion, dynamic lane shifting & overtaking
    this.isEvading = false;
    this.isOvertaking = false;
    this._overtakeTimer = 0;
    this.evasionProgress = 1.0;
    this.evasiveShift = 0;
    this.targetEvasiveShift = 0;
    this._evasionCooldown = 0;
    this.laneWidthM = 3.5;
    this._lateralShift = 0;

    // Obstacle tracking (from real proximity distance sensors)
    this._lastObstacleDist = 50.0;
    this._isBlocked = false;
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
      this._isArrived = false;
      this.status = 'CRUISING';
    }
    return { enabled: this.enabled, status: this.status };
  }

  reset() {
    this.status = 'IDLE';
    this._isArrived = false;
    this._closestSegIdx = 0;
    this._steerSmooth = 0;
    this._prevHeadingError = 0;
    this._arrivedTimer = 0;
    this._maxCurveDev = 0;
    this.uTurnActive = false;
    this._uTurnTimer = 0;
    this._kTurnTimer = 0;
    this.isEvading = false;
    this.isOvertaking = false;
    this._overtakeTimer = 0;
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
      isOvertaking: this.isOvertaking,
      currentLaneIndex: this.targetEvasiveShift > 0 ? 1 : 0,
      targetLaneIndex: this.targetEvasiveShift > 0 ? 1 : 0,
      laneChangeProgress: this.evasionProgress,
      lateralShift: this._lateralShift,
      obstacleDistanceM: this._lastObstacleDist,
      isBlocked: this._isBlocked,
    };
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
   * @param {object} sensorData ego sensor readings (proximityReadings, cameraReadings)
   * @param {object} egoState { position, headingRad, speedMps } from simulated GPS / odometry
   * @returns {{ throttle: number, steering: number, brake: number }}
   */
  update(dt, sensorData = {}, egoState = null) {
    // ── LATCHED ARRIVAL / PARKED STATE ──────────────────────────────
    if (this._isArrived) {
      this.status = 'ARRIVED';
      return { throttle: 0, steering: 0, brake: 1.0 };
    }

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

    // ── 1. PROXIMITY SENSOR READINGS (Continuous Analog Headway) ─────
    const prox = sensorData.proximityReadings?.proximityM || {};
    const rawFront = prox.front ?? 50.0;
    const cornerMin = Math.min(prox['front-left'] ?? 50.0, prox['front-right'] ?? 50.0);
    const fwdDist = cornerMin < 4.0 ? Math.min(rawFront, cornerMin) : rawFront;
    this._lastObstacleDist = fwdDist;

    const leftDist = prox.left ?? prox['side-left'] ?? 50.0;
    const rightDist = prox.right ?? prox['side-right'] ?? 50.0;
    const frontLeftDist = prox['front-left'] ?? 50.0;
    const frontRightDist = prox['front-right'] ?? 50.0;
    const rearDist = prox.rear ?? 50.0;
    const cam = sensorData.cameraReadings;

    // Check if we have a destination route or are in camera free-cruising
    const navState = this.navigationSystem?.getNavState?.();
    const hasRoute = !!(navState?.hasCheckpoint && navState?.route?.waypoints?.length >= 2);
    const waypoints = hasRoute ? navState.route.waypoints : null;

    let targetX = 0;
    let targetZ = 0;
    let distToDestination = 999;
    let closestPt = null;
    this._maxCurveDev = 0;
    this._distToTurn = 999;

    // Front bumper position (effective steering axle reference)
    const bumperX = egoPos.x + egoFwdX * 2.1;
    const bumperZ = egoPos.z + egoFwdZ * 2.1;

    // ── 2. DESTINATION ROUTE TRACKING OR CAMERA FREE CRUISE ───────────
    if (hasRoute) {
      const finalWp = waypoints[waypoints.length - 1];
      distToDestination = Math.hypot(finalWp.x - egoPos.x, finalWp.z - egoPos.z);

      // Project front bumper onto route polyline
      const proj = this._projectEgoOntoPolyline({ x: bumperX, z: bumperZ }, waypoints);
      closestPt = proj.closestPt;
      const segIdx = proj.segIdx;

      // ── TERMINAL ARRIVAL & SOLID STOP ──────────────────────────────
      // Reached destination checkpoint or end of route polyline
      const atPolylineEnd = proj.segIdx >= waypoints.length - 2 && distToDestination < 10.0;
      if (distToDestination <= this.arrivalRadiusM || atPolylineEnd) {
        this._arrivedTimer += dt;
        if (egoSpeed <= 0.40 || distToDestination < 2.8 || this._arrivedTimer > 0.40) {
          this.status = 'ARRIVED';
          this._isArrived = true;
          this.enabled = false;
          this._arrivedTimer = 0;
          return { throttle: 0, steering: 0, brake: 1.0 };
        }
        // Forceful deceleration within arrival radius
        return { throttle: 0, steering: 0, brake: 1.0 };
      }
      this._arrivedTimer = 0;

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
      // On straights: 5.0 to 13.0m for stability.
      // On approaching turns: shrink to 3.5 - 4.8m so the vehicle faithfully hugs the lane arc.
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

      // ── 3. HEADING-AWARE U-TURN & 3-POINT K-TURN ─────────────────────
      const isTurnaroundNeeded = fwdDot < -0.2 && Math.abs(headingErrorToTarget) > 2.05;

      if (isTurnaroundNeeded && !this.uTurnActive) {
        this.uTurnActive = true;
        this.status = 'UTURN_DECEL';
        this._uTurnTurnDirection = Math.sign(headingErrorToTarget) || -1;
        this._kTurnTimer = 0;
      }

      if (this.uTurnActive) {
        // Phase 0: Rapid deceleration to crawl speed before initiating turn
        if (this.status === 'UTURN_DECEL') {
          if (egoSpeed > 0.8) {
            this._steerSmooth = clamp(this._uTurnTurnDirection * 0.25, -1.0, 1.0);
            return { throttle: 0, steering: this._steerSmooth, brake: 0.95 };
          }
          // Strictly use 3-point K-turn on standard roads to prevent driving off the asphalt
          this.status = 'K_TURN_FORWARD_1';
          this._kTurnTimer = 0;
        }

        // ── 3-POINT TURN: PHASE 1 (Forward turn toward opposite curb) ──
        if (this.status === 'K_TURN_FORWARD_1') {
          this._kTurnTimer += dt;
          const steer = clamp(this._uTurnTurnDirection * 1.0, -1.0, 1.0);
          this._steerSmooth = steer;

          const angleTurned = Math.PI - Math.abs(headingErrorToTarget);
          // Strictly enforce road boundaries using camera and distance sensors:
          // Stop forward movement if:
          // 1. Front camera detects curb/road edge < 1.7m ahead
          // 2. Camera detects vehicle is getting near road edge
          // 3. Proximity sensor fwdDist < 2.5m
          // 4. Sufficient angle turned (>= 0.95 rad / 55°)
          // 5. Hard time cap of 1.35s (at ~1.0 m/s crawl, max 1.35m travel)
          const curbAhead = cam?.distToCurbAheadM != null && cam.distToCurbAheadM < 1.7;
          const nearEdge = (cam?.isNearRoadEdge || cam?.distToRightEdgeM < 1.1 || cam?.distToLeftEdgeM < 1.1) && this._kTurnTimer > 0.3;
          const obstAhead = fwdDist < 2.5;
          const turnedEnough = angleTurned > 0.95;
          const timeOut = this._kTurnTimer > 1.35;

          if (curbAhead || nearEdge || obstAhead || turnedEnough || timeOut) {
            this.status = 'K_TURN_STOP_1';
            this._kTurnTimer = 0.30; // pause for gear shift to reverse
            return { throttle: 0, steering: steer, brake: 1.0 };
          }
          const throttle = egoSpeed < 1.0 ? 0.30 : 0.05;
          const brake = egoSpeed > 1.3 ? 0.50 : 0;
          return { throttle, steering: steer, brake };
        }

        // Stop & shift to reverse
        if (this.status === 'K_TURN_STOP_1') {
          this._kTurnTimer -= dt;
          if (this._kTurnTimer <= 0) {
            this.status = 'K_TURN_REVERSE_2';
            this._kTurnTimer = 1.30; // strict reverse cap to stay within rear boundary
          }
          return { throttle: 0, steering: clamp(this._uTurnTurnDirection * 1.0, -1.0, 1.0), brake: 1.0 };
        }

        // Phase 2: Reverse with counter-steering
        if (this.status === 'K_TURN_REVERSE_2') {
          this._kTurnTimer -= dt;
          const revSteer = clamp(-this._uTurnTurnDirection * 1.0, -1.0, 1.0);
          this._steerSmooth = revSteer;

          const alignedWithTarget = Math.abs(headingErrorToTarget) < 0.62;
          const rearObst = rearDist < 2.4;
          const rearRoadEdge = cam && (!cam.isOnRoad || cam.isNearRoadEdge);
          const timeOut = this._kTurnTimer <= 0;

          if (alignedWithTarget || rearObst || rearRoadEdge || timeOut) {
            this.status = 'K_TURN_STOP_2';
            this._kTurnTimer = 0.30; // pause for gear shift to forward
            return { throttle: 0, steering: revSteer, brake: 1.0 };
          }
          return { throttle: -0.28, steering: revSteer, brake: 0 };
        }

        // Stop & shift to forward
        if (this.status === 'K_TURN_STOP_2') {
          this._kTurnTimer -= dt;
          if (this._kTurnTimer <= 0) {
            this.status = 'K_TURN_FORWARD_3';
          }
          return { throttle: 0, steering: 0, brake: 1.0 };
        }

        // Phase 3: Roll forward into target lane with camera lane following
        if (this.status === 'K_TURN_FORWARD_3') {
          let steer = clamp(2.4 * headingErrorToTarget, -0.65, 0.65);
          if (cam && cam.detected && cam.lateralOffsetM != null) {
            steer += (cam.headingErrorRad || 0) * 0.15 - clamp(cam.lateralOffsetM, -1.5, 1.5) * 0.08;
          }
          this._steerSmooth = steer;

          if (Math.abs(headingErrorToTarget) < 0.35 && (cam ? cam.isOnRoad : true)) {
            this.uTurnActive = false;
            this.status = 'CRUISING';
          } else {
            const throttle = egoSpeed < 1.6 ? 0.32 : 0.10;
            const brake = egoSpeed > 2.2 ? 0.35 : 0;
            return { throttle, steering: steer, brake };
          }
        }
      }

      // ── 4. SENSOR-BASED OBSTACLE EVASION & PARALLEL LANE OVERTAKING ──
      const laneW = this.laneWidthM;
      // Multi-lane parallel road verification:
      // Parallel lane on the right requires ample lateral clearance and no immediate right curb
      const rightClear = rightDist > 5.2 && frontRightDist > 9.0 && (cam ? cam.distToRightEdgeM > 2.6 : true);
      const leftClear = leftDist > 5.2 && frontLeftDist > 9.0;

      // When lead obstacle is detected in our lane:
      if (fwdDist < 18.0 && !this.isEvading && !this.isOvertaking && this._evasionCooldown <= 0) {
        if (rightClear) {
          // Multi-lane road: Shift to parallel same-direction lane to the RIGHT (+laneW)
          // Strictly DO NOT shift left into the oncoming opposite lane (-laneW)!
          this.isEvading = true;
          this.isOvertaking = true;
          this.evasionProgress = 0;
          this.targetEvasiveShift = laneW; // Shift RIGHT (+3.5m) into parallel lane
          this._evasionCooldown = 3.0;
          this._overtakeTimer = 0;
          this.status = 'CHANGING_LANE';
        }
      }

      // Track overtaking progress in the parallel lane
      if (this.isOvertaking && this.targetEvasiveShift > 0) {
        this._overtakeTimer += dt;
        if (this.evasionProgress >= 0.7 && this.status !== 'RETURNING_LANE') {
          this.status = 'OVERTAKING';
        }

        // Return to nominal lane after overtaking:
        // 1. Traveled in parallel lane long enough to pass lead obstacle
        // 2. Direct parallel lane ahead is clear
        // 3. Left lane (nominal lane) is clear to merge back
        const passedObstacle = this._overtakeTimer > 2.0;
        const parallelAheadClear = fwdDist > 20.0;
        const returnClear = leftClear && this._evasionCooldown <= 0;

        if (passedObstacle && parallelAheadClear && returnClear) {
          this.targetEvasiveShift = 0; // Return to nominal lane
          this.evasionProgress = 0;
          this.status = 'RETURNING_LANE';
          this._evasionCooldown = 3.5;
        }
      }

      // Smooth S-curve transition for evasive lateral shift
      if (this.evasionProgress < 1.0) {
        this.evasionProgress = clamp(this.evasionProgress + dt / 1.8, 0, 1.0);
        const sCurve = this.evasionProgress * this.evasionProgress * (3 - 2 * this.evasionProgress);
        this._lateralShift = this.evasiveShift + (this.targetEvasiveShift - this.evasiveShift) * sCurve;
        if (this.evasionProgress >= 1.0) {
          this.evasiveShift = this.targetEvasiveShift;
          this._lateralShift = this.targetEvasiveShift;
          if (this.targetEvasiveShift === 0) {
            this.isEvading = false;
            this.isOvertaking = false;
            this.status = 'CRUISING';
          }
        }
      } else {
        this._lateralShift = this.targetEvasiveShift;
      }

      // Pure pursuit target point with evasive shift (0 when cruising nominally)
      const perpX = -tangent.z;
      const perpZ = tangent.x;
      targetX = targetPt.x + perpX * this._lateralShift;
      targetZ = targetPt.z + perpZ * this._lateralShift;
    } else {
      // ── FREE DRIVE / VISION LANE KEEPING MODE (NO CHECKPOINT) ────────
      // Operates solely using Front Camera visual lane tracking & GPS heading
      const lookaheadM = clamp(12.0 + egoSpeed * 0.6, 10.0, 22.0);

      if (cam && cam.detected && cam.lateralOffsetM != null) {
        const camOffset = clamp(cam.lateralOffsetM, -2.5, 2.5);
        const camHeadErr = clamp(cam.headingErrorRad || 0, -0.6, 0.6);
        const targetH = egoHeading + camHeadErr - camOffset * 0.28;
        targetX = bumperX + Math.sin(targetH) * lookaheadM;
        targetZ = bumperZ - Math.cos(targetH) * lookaheadM;
      } else {
        // Maintain forward GPS heading, nudged by side clearance sensors
        let steerBias = 0;
        if (leftDist < 2.5) steerBias += (2.5 - leftDist) * 0.25;
        if (rightDist < 2.5) steerBias -= (2.5 - rightDist) * 0.25;
        const targetH = egoHeading + steerBias;
        targetX = bumperX + Math.sin(targetH) * lookaheadM;
        targetZ = bumperZ - Math.cos(targetH) * lookaheadM;
      }
    }

    // ── 5. PURE PURSUIT STEERING + SENSOR CENTERING FUSION ─────────────
    const adjustedHeading = Math.atan2(targetX - bumperX, -(targetZ - bumperZ));
    let finalHeadingError = wrapPi(adjustedHeading - egoHeading);

    // Cross-track error correction (lateral offset from route polyline at front bumper)
    if (hasRoute && closestPt && !this.uTurnActive) {
      const toBumperX = bumperX - closestPt.x;
      const toBumperZ = bumperZ - closestPt.z;
      const crossTrack = toBumperX * egoRightX + toBumperZ * egoRightZ;
      finalHeadingError -= clamp(crossTrack * 0.26, -0.4, 0.4);
    }

    // Front camera lane centering micro-adjustment when cruising in-lane
    if (!this.isEvading && !this.uTurnActive) {
      if (cam && cam.detected && cam.lateralOffsetM != null) {
        finalHeadingError += (cam.headingErrorRad || 0) * 0.15 - clamp(cam.lateralOffsetM, -1.5, 1.5) * 0.08;
      }
    }

    // Camera road boundary protection: prevent vehicle from brushing curb or leaving asphalt
    if (!this.uTurnActive && cam) {
      if (cam.distToLeftEdgeM < 1.2) {
        finalHeadingError += (1.2 - cam.distToLeftEdgeM) * 0.25;
      }
      if (cam.distToRightEdgeM < 1.2) {
        finalHeadingError -= (1.2 - cam.distToRightEdgeM) * 0.25;
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
    if (!this.uTurnActive && !this.isEvading && !this.isOvertaking && !this._isBlocked) {
      this.status = 'CRUISING';
    }

    // 1. Proactive Lookahead Cornering Deceleration:
    // Decelerate proactively before 90° intersection turns and tight curves
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
      const targetArrivalSpeed = 1.4 + arrivalRatio * (this.cruiseSpeedMps - 1.4);
      targetSpeed = Math.min(targetSpeed, targetArrivalSpeed);
    }

    // Continuous analog proximity headway braking
    let obstacleBrake = 0;
    const isPassingInParallelLane = (this.status === 'OVERTAKING' || this.status === 'CHANGING_LANE') && this.targetEvasiveShift > 0;

    if (fwdDist < 5.0 && !isPassingInParallelLane) {
      // Stopped safely behind obstacle with 5.0m buffer
      this._isBlocked = true;
      this.status = 'BLOCKED';
      targetSpeed = 0;
      obstacleBrake = 1.0;
    } else if (fwdDist < 16.0 && !isPassingInParallelLane) {
      this._isBlocked = true;
      const ratio = clamp((fwdDist - 5.0) / 11.0, 0, 1.0);
      targetSpeed = Math.min(targetSpeed, 1.2 + ratio * 6.0);
      obstacleBrake = (1.0 - ratio) * 0.85;
    } else if (isPassingInParallelLane) {
      this._isBlocked = false;
      // In parallel lane: maintain cruise speed for swift overtake
      targetSpeed = this.cruiseSpeedMps;
      obstacleBrake = 0;
      // If there is an obstacle directly ahead in the parallel lane:
      if (fwdDist < 5.0) {
        targetSpeed = 0;
        obstacleBrake = 1.0;
      } else if (fwdDist < 12.0) {
        const ratio = clamp((fwdDist - 5.0) / 7.0, 0, 1.0);
        targetSpeed = Math.min(targetSpeed, 1.4 + ratio * 5.0);
        obstacleBrake = (1.0 - ratio) * 0.8;
      }
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
      // Start rolling decisively from a dead stop
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
    this.ego = null;
  }
}
