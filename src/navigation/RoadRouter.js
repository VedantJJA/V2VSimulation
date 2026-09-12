import * as THREE from 'three';
import { SplineUtils } from '../road/SplineUtils.js';
import { clamp, wrapPi } from '../utils/MathUtils.js';

/**
 * RoadRouter — Graph-based Dijkstra / A* routing engine for RoadNetwork.
 *
 * Converts the RoadNetwork into a directed navigation graph where:
 * - Graph Nodes represent road endpoints (start/end nodes) or segment points.
 * - Graph Edges represent legal lane travel directions along segments:
 *   - lanesForward > 0 allows travel from startNode to endNode.
 *   - lanesBackward > 0 allows travel from endNode to startNode.
 *   - Route waypoints are aligned with the proper driving lane (not the center divider).
 *   - Generates smooth U-turn turnaround arcs when turning 180° between lanes.
 */
export class RoadRouter {
  /**
   * @param {import('../road/RoadNetwork.js').RoadNetwork} network
   */
  constructor(network) {
    this.network = network;
  }

  /**
   * Find nearest point on any road segment to a world coordinate (X, Z).
   * @param {number} x
   * @param {number} z
   * @returns {{ segment: import('../road/RoadSegment.js').RoadSegment, t: number, point: THREE.Vector3, distance: number } | null}
   */
  findClosestRoadPoint(x, z) {
    if (!this.network || this.network.segments.size === 0) return null;

    let bestSegment = null;
    let bestT = 0;
    let bestPoint = null;
    let bestDistSq = Infinity;

    for (const segment of this.network.segments.values()) {
      const curve = segment.getCurve();
      const length = segment.lengthM;
      const samples = Math.max(8, Math.ceil(length / 4));

      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const pt = curve.getPointAt(t);
        const dSq = (x - pt.x) ** 2 + (z - pt.z) ** 2;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestSegment = segment;
          bestT = t;
          bestPoint = pt;
        }
      }
    }

    if (!bestSegment) return null;

    // Refine t locally around best sample
    const curve = bestSegment.getCurve();
    let tMin = Math.max(0, bestT - 0.1);
    let tMax = Math.min(1, bestT + 0.1);
    for (let step = 0; step < 5; step++) {
      const t1 = tMin + (tMax - tMin) * 0.33;
      const t2 = tMin + (tMax - tMin) * 0.67;
      const p1 = curve.getPointAt(t1);
      const p2 = curve.getPointAt(t2);
      const d1 = (x - p1.x) ** 2 + (z - p1.z) ** 2;
      const d2 = (x - p2.x) ** 2 + (z - p2.z) ** 2;
      if (d1 < d2) {
        tMax = t2;
        bestPoint = p1;
      } else {
        tMin = t1;
        bestPoint = p2;
      }
    }

    return {
      segment: bestSegment,
      t: (tMin + tMax) * 0.5,
      point: bestPoint,
      distance: Math.sqrt(bestDistSq),
    };
  }

  /**
   * Calculate shortest route from start position (x1, z1) to target (x2, z2).
   * @param {{ x: number, z: number }} startPos
   * @param {{ x: number, z: number }} targetPos
   * @param {number|null} [startHeadingRad] current vehicle heading in radians
   * @returns {{ waypoints: Array<{ x: number, y: number, z: number }>, totalDistanceM: number, segments: string[] } | null}
   */
  findRoute(startPos, targetPos, startHeadingRad = null) {
    if (!this.network || this.network.segments.size === 0) return null;

    const startMatch = this.findClosestRoadPoint(startPos.x, startPos.z);
    const targetMatch = this.findClosestRoadPoint(targetPos.x, targetPos.z);

    if (!startMatch || !targetMatch) return null;

    // Case 1: Start and target are on the same road segment
    if (startMatch.segment.id === targetMatch.segment.id) {
      const seg = startMatch.segment;
      const tA = startMatch.t;
      const tB = targetMatch.t;

      const isForward = tB >= tA;
      let isFacingForward = true;
      if (startHeadingRad != null) {
        const tangent = seg.getCurve().getTangentAt(tA);
        const fwdHeading = Math.atan2(tangent.x, -tangent.z);
        isFacingForward = Math.abs(wrapPi(fwdHeading - startHeadingRad)) < Math.PI * 0.55;
      }

      // 1A: Moving along current travel heading
      if (isForward && isFacingForward && seg.lanesForward > 0) {
        const waypoints = this._extractSegmentLaneRange(seg, tA, tB, false);
        return { waypoints, totalDistanceM: Math.abs(tB - tA) * seg.lengthM, segments: [seg.id] };
      } else if (!isForward && !isFacingForward && seg.lanesBackward > 0) {
        const waypoints = this._extractSegmentLaneRange(seg, tA, tB, true);
        return { waypoints, totalDistanceM: Math.abs(tB - tA) * seg.lengthM, segments: [seg.id] };
      } else if (isForward && !isFacingForward && seg.lanesForward > 0 && seg.lanesBackward > 0) {
        // 1B: Facing backward but target is forward → U-turn from reverse to forward lane
        const uTurn = this._generateUTurnArc(seg, tA, true);
        const lanePts = this._extractSegmentLaneRange(seg, tA, tB, false);
        const waypoints = this._cleanWaypoints([...uTurn, ...lanePts]);
        return { waypoints, totalDistanceM: Math.abs(tB - tA) * seg.lengthM + 12, segments: [seg.id] };
      } else if (!isForward && isFacingForward && seg.lanesForward > 0 && seg.lanesBackward > 0) {
        // 1C: Facing forward but target is backward → U-turn from forward to reverse lane
        const uTurn = this._generateUTurnArc(seg, tA, false);
        const lanePts = this._extractSegmentLaneRange(seg, tA, tB, true);
        const waypoints = this._cleanWaypoints([...uTurn, ...lanePts]);
        return { waypoints, totalDistanceM: Math.abs(tB - tA) * seg.lengthM + 12, segments: [seg.id] };
      }
    }

    // Case 2: Multi-segment pathfinding using Dijkstra over the road network topology
    const distMap = new Map();
    const prevMap = new Map();
    const unvisited = new Set(this.network.nodeIds);

    for (const id of this.network.nodeIds) {
      distMap.set(id, Infinity);
    }

    // Seed start node distances from startMatch with heading orientation
    const segA = startMatch.segment;
    let forwardPenalty = 0;
    let backwardPenalty = 0;

    if (startHeadingRad != null) {
      const tangent = segA.getCurve().getTangentAt(startMatch.t);
      const fwdHeading = Math.atan2(tangent.x, -tangent.z);
      const isFacingForward = Math.abs(wrapPi(fwdHeading - startHeadingRad)) < Math.PI * 0.55;
      if (isFacingForward) {
        backwardPenalty = 18.0; // U-turn penalty to turn around into reverse lane
      } else {
        forwardPenalty = 18.0;  // U-turn penalty to turn around into forward lane
      }
    }

    if (segA.lanesForward > 0) {
      const d = (1 - startMatch.t) * segA.lengthM + forwardPenalty;
      distMap.set(segA.endNodeId, d);
      prevMap.set(segA.endNodeId, {
        fromNodeId: null,
        segmentId: segA.id,
        reverse: false,
        startT: startMatch.t,
        needsUTurn: forwardPenalty > 0 && segA.lanesBackward > 0,
      });
    }
    if (segA.lanesBackward > 0) {
      const d = startMatch.t * segA.lengthM + backwardPenalty;
      distMap.set(segA.startNodeId, d);
      prevMap.set(segA.startNodeId, {
        fromNodeId: null,
        segmentId: segA.id,
        reverse: true,
        startT: startMatch.t,
        needsUTurn: backwardPenalty > 0 && segA.lanesForward > 0,
      });
    }

    // Dijkstra main loop
    while (unvisited.size > 0) {
      let currentId = null;
      let smallestDist = Infinity;
      for (const id of unvisited) {
        const d = distMap.get(id);
        if (d < smallestDist) {
          smallestDist = d;
          currentId = id;
        }
      }

      if (!currentId || smallestDist === Infinity) break;
      unvisited.delete(currentId);

      const targetSeg = targetMatch.segment;
      if (currentId === targetSeg.startNodeId || currentId === targetSeg.endNodeId) {
        if (currentId === targetSeg.startNodeId && targetSeg.lanesForward > 0) break;
        if (currentId === targetSeg.endNodeId && targetSeg.lanesBackward > 0) break;
      }

      const connectedSegments = this.network.getSegmentsAtNode(currentId);
      for (const seg of connectedSegments) {
        let neighborId = null;
        let isReverse = false;

        if (seg.startNodeId === currentId && seg.lanesForward > 0) {
          neighborId = seg.endNodeId;
          isReverse = false;
        } else if (seg.endNodeId === currentId && seg.lanesBackward > 0) {
          neighborId = seg.startNodeId;
          isReverse = true;
        }

        if (neighborId && unvisited.has(neighborId)) {
          const newDist = smallestDist + seg.lengthM;
          if (newDist < distMap.get(neighborId)) {
            distMap.set(neighborId, newDist);
            prevMap.set(neighborId, { fromNodeId: currentId, segmentId: seg.id, reverse: isReverse });
          }
        }
      }
    }

    // Determine which target segment endpoint to connect to
    const targetSeg = targetMatch.segment;
    let targetEntryNode = null;
    let targetReverse = false;
    let bestTotalDist = Infinity;

    if (targetSeg.lanesForward > 0 && distMap.has(targetSeg.startNodeId)) {
      const d = distMap.get(targetSeg.startNodeId) + targetMatch.t * targetSeg.lengthM;
      if (d < bestTotalDist) {
        bestTotalDist = d;
        targetEntryNode = targetSeg.startNodeId;
        targetReverse = false;
      }
    }

    if (targetSeg.lanesBackward > 0 && distMap.has(targetSeg.endNodeId)) {
      const d = distMap.get(targetSeg.endNodeId) + (1 - targetMatch.t) * targetSeg.lengthM;
      if (d < bestTotalDist) {
        bestTotalDist = d;
        targetEntryNode = targetSeg.endNodeId;
        targetReverse = true;
      }
    }

    if (!targetEntryNode || bestTotalDist === Infinity) {
      return {
        waypoints: [
          { x: startPos.x, y: 0.1, z: startPos.z },
          { x: targetPos.x, y: 0.1, z: targetPos.z },
        ],
        totalDistanceM: Math.hypot(targetPos.x - startPos.x, targetPos.z - startPos.z),
        segments: [],
      };
    }

    // Backtrack route from targetEntryNode to start
    const routeSegmentChain = [];
    let curr = targetEntryNode;

    while (curr !== null) {
      const step = prevMap.get(curr);
      if (!step) break;
      routeSegmentChain.unshift(step);
      curr = step.fromNodeId;
    }

    const pieces = [];
    const usedSegmentIds = [];

    // 1. Initial segment from startMatch.t to endpoint
    if (routeSegmentChain.length > 0) {
      const firstStep = routeSegmentChain[0];
      const firstSeg = this.network.getSegment(firstStep.segmentId);
      if (firstSeg) {
        usedSegmentIds.push(firstSeg.id);
        const stepPiece = [];
        if (firstStep.needsUTurn) {
          const uTurn = this._generateUTurnArc(firstSeg, startMatch.t, firstStep.reverse);
          stepPiece.push(...uTurn);
        }
        const pts = firstStep.reverse
          ? this._extractSegmentLaneRange(firstSeg, startMatch.t, 0, true)
          : this._extractSegmentLaneRange(firstSeg, startMatch.t, 1, false);
        stepPiece.push(...pts);
        if (stepPiece.length > 0) pieces.push(stepPiece);
      }
    }

    // 2. Intermediate full segments
    for (let i = 1; i < routeSegmentChain.length; i++) {
      const step = routeSegmentChain[i];
      const seg = this.network.getSegment(step.segmentId);
      if (seg) {
        usedSegmentIds.push(seg.id);
        const pts = step.reverse
          ? this._extractSegmentLaneRange(seg, 1, 0, true)
          : this._extractSegmentLaneRange(seg, 0, 1, false);
        if (pts.length > 0) pieces.push(pts);
      }
    }

    // 3. Final target segment from entry node to targetMatch.t
    usedSegmentIds.push(targetSeg.id);
    const finalPts = targetReverse
      ? this._extractSegmentLaneRange(targetSeg, 1, targetMatch.t, true)
      : this._extractSegmentLaneRange(targetSeg, 0, targetMatch.t, false);
    if (finalPts.length > 0) pieces.push(finalPts);

    const waypoints = this._stitchRoutePieces(pieces);

    return {
      waypoints,
      totalDistanceM: bestTotalDist,
      segments: usedSegmentIds,
    };
  }

  /**
   * Stitch consecutive segment waypoints with smooth Bezier fillet arcs at turns.
   * Eliminates raw 90° corners inside intersections.
   */
  _stitchRoutePieces(pieces) {
    if (pieces.length === 0) return [];
    const waypoints = [];

    for (let i = 0; i < pieces.length; i++) {
      const currentPiece = pieces[i];
      if (!currentPiece || currentPiece.length === 0) continue;

      if (waypoints.length === 0) {
        waypoints.push(...currentPiece);
      } else {
        const p0 = waypoints[waypoints.length - 1];
        const pPrev = waypoints[Math.max(0, waypoints.length - 2)];
        const p1 = currentPiece[0];
        const pNext = currentPiece[Math.min(currentPiece.length - 1, 1)];

        const dOutX = p0.x - pPrev.x;
        const dOutZ = p0.z - pPrev.z;
        const lenOut = Math.hypot(dOutX, dOutZ) || 1;
        const tOut = { x: dOutX / lenOut, z: dOutZ / lenOut };

        const dInX = pNext.x - p1.x;
        const dInZ = pNext.z - p1.z;
        const lenIn = Math.hypot(dInX, dInZ) || 1;
        const tIn = { x: dInX / lenIn, z: dInZ / lenIn };

        const dot = tOut.x * tIn.x + tOut.z * tIn.z;
        const dist = Math.hypot(p1.x - p0.x, p1.z - p0.z);

        // If direction turns significantly (> 16° / dot < 0.96)
        if (dot < 0.96) {
          // Trim incoming waypoints back by ~3.2m before intersection node
          let trimmedOutM = 0;
          let pStart = waypoints[waypoints.length - 1];
          while (waypoints.length > 2 && trimmedOutM < 3.2) {
            const popped = waypoints.pop();
            const last = waypoints[waypoints.length - 1];
            trimmedOutM += Math.hypot(popped.x - last.x, popped.z - last.z);
            pStart = last;
          }

          // Trim outgoing piece forward by ~3.2m past intersection node
          let trimmedInM = 0;
          let nextIdx = 0;
          while (nextIdx < currentPiece.length - 2 && trimmedInM < 3.2) {
            const pA = currentPiece[nextIdx];
            const pB = currentPiece[nextIdx + 1];
            trimmedInM += Math.hypot(pB.x - pA.x, pB.z - pA.z);
            nextIdx++;
          }
          const pEnd = currentPiece[nextIdx];

          const chordDist = Math.hypot(pEnd.x - pStart.x, pEnd.z - pStart.z);
          const arm = clamp(chordDist * 0.48, 1.8, 6.0);
          const c0 = pStart;
          const c1 = { x: pStart.x + tOut.x * arm, z: pStart.z + tOut.z * arm };
          const c2 = { x: pEnd.x - tIn.x * arm, z: pEnd.z - tIn.z * arm };
          const c3 = pEnd;

          const numArc = Math.max(6, Math.ceil(chordDist / 1.0));
          for (let step = 1; step < numArc; step++) {
            const u = step / numArc;
            const u1 = 1 - u;
            const bx = u1 * u1 * u1 * c0.x + 3 * u1 * u1 * u * c1.x + 3 * u1 * u * u * c2.x + u * u * u * c3.x;
            const bz = u1 * u1 * u1 * c0.z + 3 * u1 * u1 * u * c1.z + 3 * u1 * u * u * c2.z + u * u * u * c3.z;
            waypoints.push({ x: bx, y: pStart.y ?? 0.1, z: bz });
          }
          waypoints.push(...currentPiece.slice(nextIdx));
        } else {
          waypoints.push(...currentPiece);
        }
      }
    }
    return this._cleanWaypoints(waypoints);
  }

  /**
   * Sample curve along proper driving lane center.
   */
  _extractSegmentLaneRange(segment, t0, t1, isReverse) {
    const curve = segment.getCurve();
    const pts = [];
    const len = segment.lengthM || 20;
    const count = Math.max(4, Math.ceil(len * Math.abs(t1 - t0) * 0.5));

    const laneWidth = segment.laneWidthM || 3.5;
    let lateralOffset = 0;
    if (segment.lanesForward > 0 && segment.lanesBackward > 0) {
      // Right-hand traffic: forward lane is +offset, reverse lane is -offset
      lateralOffset = isReverse ? -laneWidth * 0.5 : laneWidth * 0.5;
    } else if (segment.lanesForward > 1) {
      lateralOffset = laneWidth * 0.5;
    } else if (segment.lanesBackward > 1) {
      lateralOffset = -laneWidth * 0.5;
    }

    for (let i = 0; i <= count; i++) {
      const t = t0 + (t1 - t0) * (i / count);
      const clampedT = Math.max(0, Math.min(1, t));
      const p = lateralOffset !== 0
        ? SplineUtils.lateralAt(curve, clampedT, lateralOffset)
        : curve.getPointAt(clampedT);
      pts.push({ x: p.x, y: p.y ?? 0.1, z: p.z });
    }
    return pts;
  }

  /**
   * Generate a smooth 180° turnaround arc between forward and reverse lanes at a given t.
   */
  _generateUTurnArc(segment, t, fromReverse = false) {
    const curve = segment.getCurve();
    const frame = SplineUtils.computeFrame(curve, clamp(t, 0, 1));
    const laneW = segment.laneWidthM || 3.5;
    const halfW = laneW * 0.5;

    const arc = [];
    const N = 8;
    // Forward reach of the U-turn loop (~4.5 meters)
    const forwardSwing = Math.min(5.5, Math.max(3.5, (segment.lengthM || 20) * 0.12));

    for (let i = 0; i <= N; i++) {
      const alpha = i / N; // 0 to 1
      const theta = alpha * Math.PI; // 0 to PI

      let pt;
      if (!fromReverse) {
        // Turning from forward lane (+halfW) to reverse lane (-halfW)
        const lat = halfW * Math.cos(theta);
        const fwd = Math.sin(theta) * forwardSwing;
        pt = new THREE.Vector3()
          .copy(frame.position)
          .addScaledVector(frame.right, lat)
          .addScaledVector(frame.tangent, fwd);
      } else {
        // Turning from reverse lane (-halfW) to forward lane (+halfW)
        const lat = -halfW * Math.cos(theta);
        const fwd = -Math.sin(theta) * forwardSwing;
        pt = new THREE.Vector3()
          .copy(frame.position)
          .addScaledVector(frame.right, lat)
          .addScaledVector(frame.tangent, fwd);
      }
      arc.push({ x: pt.x, y: 0.1, z: pt.z });
    }
    return arc;
  }

  _cleanWaypoints(waypoints) {
    if (waypoints.length <= 1) return waypoints;
    const res = [waypoints[0]];
    for (let i = 1; i < waypoints.length; i++) {
      const prev = res[res.length - 1];
      const curr = waypoints[i];
      const dSq = (curr.x - prev.x) ** 2 + (curr.z - prev.z) ** 2;
      if (dSq > 0.25) {
        res.push(curr);
      }
    }
    return res;
  }
}
