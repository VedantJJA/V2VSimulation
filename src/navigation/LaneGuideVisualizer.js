import * as THREE from 'three';
import { clamp, wrapPi } from '../utils/MathUtils.js';
import { ROAD_SURFACE_Y } from '../road/RoadMeshBuilder.js';
import { SplineUtils } from '../road/SplineUtils.js';

/**
 * LaneGuideVisualizer — Tesla FSD-style dynamic 3D road ribbon trajectory visualizer.
 *
 * Direct port of the reference simulator's makeLaneGuideVisualizer:
 * - 48 quad-strip ribbon segments with vertex colors, polygon offset, and additive blending.
 * - Outer left & right high-intensity corridor boundary lines.
 * - Centerline trajectory guide.
 * - Animated Tesla pulse flow effect.
 * - Dynamic color coding:
 *     Cyan: Normal driving / Tesla FSD
 *     Amber: Following lead vehicle, curve governor slowing, caution
 *     Red: Critical collision risk, AEB active
 *     Emerald: Emergency evasive corridor / active lane change
 */
export class LaneGuideVisualizer {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {object} options
   * @param {import('../road/RoadNetwork.js').RoadNetwork} options.network
   * @param {import('../vehicles/Vehicle.js').Vehicle} options.ego
   */
  constructor(engine, { network, ego } = {}) {
    this._engine = engine;
    this._sceneManager = engine.sceneManager;
    this._network = network;
    this.ego = ego;

    this.group = new THREE.Group();
    this.group.name = 'lane-guide:visualizer';
    this.group.userData.isExternalOverlay = true;

    const N_SEGS = 48;
    this.N_SEGS = N_SEGS;
    const N_CROSS = N_SEGS + 1; // 49 cross sections
    const N_VERTS = N_CROSS * 2; // 98 vertices for ribbon

    // 1. Semi-transparent Tesla FSD Road Ribbon (Mesh Quad Strip)
    this.ribbonPos = new Float32Array(N_VERTS * 3);
    this.ribbonCol = new Float32Array(N_VERTS * 3);
    this.ribbonGeo = new THREE.BufferGeometry();
    this.ribbonGeo.setAttribute('position', new THREE.BufferAttribute(this.ribbonPos, 3));
    this.ribbonGeo.setAttribute('color', new THREE.BufferAttribute(this.ribbonCol, 3));

    const indices = [];
    for (let i = 0; i < N_SEGS; i++) {
      const v0 = i * 2;
      const v1 = i * 2 + 1;
      const v2 = (i + 1) * 2;
      const v3 = (i + 1) * 2 + 1;
      indices.push(v0, v2, v1, v1, v2, v3);
    }
    this.ribbonGeo.setIndex(indices);

    this.ribbonMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -6.0,
      polygonOffsetUnits: -6.0,
      side: THREE.DoubleSide,
    });
    this.ribbonMesh = new THREE.Mesh(this.ribbonGeo, this.ribbonMat);
    this.ribbonMesh.renderOrder = 10;
    this.ribbonMesh.frustumCulled = false;
    this.ribbonMesh.userData.isExternalOverlay = true;
    this.group.add(this.ribbonMesh);

    // 2. High-intensity Corridor Outer Edge Lines (Left & Right Boundaries)
    this.edgePosL = new Float32Array(N_CROSS * 3);
    this.edgeColL = new Float32Array(N_CROSS * 3);
    this.edgeGeoL = new THREE.BufferGeometry();
    this.edgeGeoL.setAttribute('position', new THREE.BufferAttribute(this.edgePosL, 3));
    this.edgeGeoL.setAttribute('color', new THREE.BufferAttribute(this.edgeColL, 3));
    this.edgeMatL = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.edgeLineL = new THREE.Line(this.edgeGeoL, this.edgeMatL);
    this.edgeLineL.renderOrder = 11;
    this.edgeLineL.frustumCulled = false;
    this.edgeLineL.userData.isExternalOverlay = true;
    this.group.add(this.edgeLineL);

    this.edgePosR = new Float32Array(N_CROSS * 3);
    this.edgeColR = new Float32Array(N_CROSS * 3);
    this.edgeGeoR = new THREE.BufferGeometry();
    this.edgeGeoR.setAttribute('position', new THREE.BufferAttribute(this.edgePosR, 3));
    this.edgeGeoR.setAttribute('color', new THREE.BufferAttribute(this.edgeColR, 3));
    this.edgeMatR = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.edgeLineR = new THREE.Line(this.edgeGeoR, this.edgeMatR);
    this.edgeLineR.renderOrder = 11;
    this.edgeLineR.frustumCulled = false;
    this.edgeLineR.userData.isExternalOverlay = true;
    this.group.add(this.edgeLineR);

    // 3. Central Trajectory Guide
    this.centerPos = new Float32Array(N_CROSS * 3);
    this.centerCol = new Float32Array(N_CROSS * 3);
    this.centerGeo = new THREE.BufferGeometry();
    this.centerGeo.setAttribute('position', new THREE.BufferAttribute(this.centerPos, 3));
    this.centerGeo.setAttribute('color', new THREE.BufferAttribute(this.centerCol, 3));
    this.centerMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.98,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.centerLine = new THREE.Line(this.centerGeo, this.centerMat);
    this.centerLine.renderOrder = 12;
    this.centerLine.frustumCulled = false;
    this.centerLine.userData.isExternalOverlay = true;
    this.group.add(this.centerLine);

    this._sceneManager.add(this.group);
    this.enabled = true;
  }

  setEgo(ego) {
    this.ego = ego;
  }

  setNetwork(network) {
    this._network = network;
  }

  /**
   * Update the ribbon path based on ego position, road network, and ADAS telemetry.
   *
   * @param {number} timeSec current elapsed simulation time
   * @param {object} [status]
   * @param {'NORMAL' | 'CAUTION' | 'HIGH' | 'CRITICAL'} [status.riskLevel]
   * @param {string} [status.action]
   * @param {boolean} [status.evasive]
   * @param {number} [status.lateralOffsetM]
   * @param {number} [status.targetLateralOffsetM]
   */
  /**
   * Sample points along route polyline at desired lookahead distance.
   * @private
   */
  _samplePolylineAhead(waypoints, bumperPos, lookaheadDist, numSamples) {
    if (!waypoints || waypoints.length < 2) return null;

    // Project vehicle bumper onto polyline to find closest point
    let bestDistSq = Infinity;
    let bestSegIdx = 0;
    let bestPt = waypoints[0];

    for (let i = 0; i < waypoints.length - 1; i++) {
      const p1 = waypoints[i];
      const p2 = waypoints[i + 1];
      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      const lenSq = dx * dx + dz * dz;
      let t = 0;
      if (lenSq > 1e-4) {
        t = clamp(((bumperPos.x - p1.x) * dx + (bumperPos.z - p1.z) * dz) / lenSq, 0, 1);
      }
      const px = p1.x + t * dx;
      const pz = p1.z + t * dz;
      const dSq = (bumperPos.x - px) ** 2 + (bumperPos.z - pz) ** 2;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestSegIdx = i;
        bestPt = { x: px, z: pz };
      }
    }

    const samples = [];
    let currSeg = bestSegIdx;
    let currPt = bestPt;
    let traveled = 0;

    for (let i = 0; i <= numSamples; i++) {
      const targetDist = (i / numSamples) * lookaheadDist;
      let distNeeded = targetDist - traveled;

      while (currSeg < waypoints.length - 1 && distNeeded > 0) {
        const nextPt = waypoints[currSeg + 1];
        const dx = nextPt.x - currPt.x;
        const dz = nextPt.z - currPt.z;
        const segLen = Math.hypot(dx, dz);

        if (segLen >= distNeeded) {
          const factor = distNeeded / (segLen || 1);
          currPt = {
            x: currPt.x + dx * factor,
            z: currPt.z + dz * factor,
          };
          traveled = targetDist;
          distNeeded = 0;
          break;
        } else {
          distNeeded -= segLen;
          traveled += segLen;
          currPt = nextPt;
          currSeg++;
        }
      }

      // Compute tangent at currPt
      let tanX = 0, tanZ = -1;
      if (currSeg < waypoints.length - 1) {
        const pA = waypoints[currSeg];
        const pB = waypoints[currSeg + 1];
        const dX = pB.x - pA.x;
        const dZ = pB.z - pA.z;
        const len = Math.hypot(dX, dZ) || 1;
        tanX = dX / len;
        tanZ = dZ / len;
      } else {
        const pA = waypoints[Math.max(0, waypoints.length - 2)];
        const pB = waypoints[waypoints.length - 1];
        const dX = pB.x - pA.x;
        const dZ = pB.z - pA.z;
        const len = Math.hypot(dX, dZ) || 1;
        tanX = dX / len;
        tanZ = dZ / len;
      }

      samples.push({
        x: currPt.x,
        z: currPt.z,
        tangent: { x: tanX, z: tanZ },
        right: { x: -tanZ, z: tanX },
      });
    }

    return samples;
  }

  /**
   * Update the ribbon path based on ego position, road network, sensors, and telemetry.
   *
   * @param {number} timeSec current elapsed simulation time
   * @param {object} [status]
   */
  update(timeSec, status = {}) {
    if (!this.enabled || !this.ego || !this._network) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const state = this.ego.motionModel.getState();
    const egoSpeed = Math.max(0, state.speedMps || 0);
    const egoPos = state.position;
    const egoHeading = state.headingRad;

    // Lookahead reach (20m at crawl, up to 55m at cruise)
    const lookaheadDist = clamp(18.0 + egoSpeed * 2.2, 20.0, 55.0);

    // Dynamic color coding
    const risk = status.riskLevel || 'NORMAL';
    const action = status.action || 'NORMAL';
    const isUTurn = !!status.uTurnActive;
    const isLaneChanging = !!status.isLaneChanging;
    const isBrakingCritical = risk === 'CRITICAL' || action === 'EMERGENCY_BRAKE' || (status.obstacleDistanceM != null && status.obstacleDistanceM < 5.5);
    const isBrakingCaution = risk === 'HIGH' || risk === 'CAUTION' || action === 'FOLLOW' || (status.obstacleDistanceM != null && status.obstacleDistanceM < 16.0);

    let rBase = 0.05, gBase = 0.88, bBase = 1.00; // Tesla FSD Cyan
    if (isBrakingCritical) {
      rBase = 1.00; gBase = 0.20; bBase = 0.20; // Critical Red
    } else if (isUTurn) {
      rBase = 0.82; gBase = 0.30; bBase = 1.00; // Electric Purple U-turn
    } else if (isLaneChanging) {
      rBase = 0.08; gBase = 0.98; bBase = 0.52; // Emerald Lane Change
    } else if (isBrakingCaution) {
      rBase = 1.00; gBase = 0.68; bBase = 0.20; // Caution Amber
    }

    const N_SEGS = this.N_SEGS;
    const roadElevation = ROAD_SURFACE_Y + 0.07;

    // Forward direction unit vectors
    const fwdX = Math.sin(egoHeading);
    const fwdZ = -Math.cos(egoHeading);
    const rightX = Math.cos(egoHeading);
    const rightZ = Math.sin(egoHeading);

    // Vehicle front bumper point
    const bumperX = egoPos.x + fwdX * 2.1;
    const bumperZ = egoPos.z + fwdZ * 2.1;
    const bumperPos = { x: bumperX, z: bumperZ };

    // Route waypoints from NavigationSystem (if route is active)
    const routeWaypoints = status.routeWaypoints || null;
    const polylineSamples = (routeWaypoints && routeWaypoints.length >= 2)
      ? this._samplePolylineAhead(routeWaypoints, bumperPos, lookaheadDist, N_SEGS)
      : null;

    // Identify nearest road segment if no navigation route is available
    let bestSeg = null;
    let bestDistSq = Infinity;
    let bestT = 0;

    if (!polylineSamples) {
      for (const seg of this._network.segments.values()) {
        const curve = seg.getCurve();
        const len = seg.lengthM;
        const samples = Math.max(6, Math.ceil(len / 15));
        for (let s = 0; s <= samples; s++) {
          const t = s / samples;
          const pt = curve.getPointAt(t);
          const dSq = (pt.x - bumperX) ** 2 + (pt.z - bumperZ) ** 2;
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestSeg = seg;
            bestT = t;
          }
        }
      }
    }

    let activeCurve = bestSeg ? bestSeg.getCurve() : null;
    let segLen = activeCurve ? activeCurve.getLength() : 100;
    let travelDir = 1;
    let targetLaneOffset = 0;

    if (bestSeg && activeCurve) {
      const frame0 = SplineUtils.computeFrame(activeCurve, bestT);
      const dot = fwdX * frame0.tangent.x + fwdZ * frame0.tangent.z;
      travelDir = dot >= 0 ? 1 : -1;

      const laneW = bestSeg.laneWidthM || 3.5;
      const numFwd = bestSeg.lanesForward ?? 1;
      const numBwd = bestSeg.lanesBackward ?? 1;

      const sign = travelDir >= 0 ? 1 : -1;
      const lanesInDir = travelDir >= 0 ? numFwd : numBwd;
      const baseMult = lanesInDir >= 2 ? 1.5 : 0.5;
      targetLaneOffset = sign * baseMult * laneW;
    }

    const currentS = bestT * segLen;

    // ── STAGE 1: COMPUTE SMOOTH CENTERLINE POINTS (Hermite Spline from bumper) ──
    const centerPoints = [];
    const transDist = clamp(8.0 + egoSpeed * 0.6, 7.0, 16.0);

    if (isUTurn) {
      // 180° teardrop turnaround arc originating flush at the front bumper
      const turnDir = status.uTurnTurnDirection || -1;
      const turnRadius = 4.2;
      for (let i = 0; i <= N_SEGS; i++) {
        const frac = i / N_SEGS;
        const angle = frac * Math.PI;
        const arcFwd = Math.sin(angle) * turnRadius;
        const arcLat = turnDir * (1 - Math.cos(angle)) * turnRadius;
        centerPoints.push({
          x: bumperX + fwdX * arcFwd + rightX * arcLat,
          y: roadElevation,
          z: bumperZ + fwdZ * arcFwd + rightZ * arcLat,
        });
      }
    } else if (polylineSamples && polylineSamples.length > 0) {
      // Sample target lane points along polyline
      const latShift = status.lateralShift || 0;
      const targetLanePts = polylineSamples.map((s) => ({
        x: s.x + s.right.x * latShift,
        z: s.z + s.right.z * latShift,
        tanX: s.tangent.x,
        tanZ: s.tangent.z,
      }));

      // Hermite target at transition distance
      // When car is already well-aligned with the lane, use a tight transition (2.5 - 5.0m)
      // so the predicted ribbon hugs the road waypoints tightly without cutting corners!
      const p0 = targetLanePts[0];
      const initialDev = p0 ? Math.hypot(bumperX - p0.x, bumperZ - p0.z) : 0;
      const effectiveTransDist = clamp(2.5 + initialDev * 1.5, 2.5, Math.min(transDist, 6.0));
      const transIdx = clamp(Math.round((effectiveTransDist / lookaheadDist) * N_SEGS), 1, N_SEGS);
      const P1 = targetLanePts[transIdx] || targetLanePts[targetLanePts.length - 1];

      for (let i = 0; i <= N_SEGS; i++) {
        const frac = i / N_SEGS;
        const dAhead = frac * lookaheadDist;

        if (i === 0) {
          centerPoints.push({ x: bumperX, y: roadElevation, z: bumperZ });
        } else if (dAhead <= effectiveTransDist) {
          // Smooth Cubic Hermite Spline from front bumper into lane center
          const u = clamp(dAhead / effectiveTransDist, 0, 1);
          const u2 = u * u;
          const u3 = u2 * u;
          const h00 = 2 * u3 - 3 * u2 + 1;
          const h10 = u3 - 2 * u2 + u;
          const h01 = -2 * u3 + 3 * u2;
          const h11 = u3 - u2;

          const cx = h00 * bumperX + h10 * (effectiveTransDist * fwdX) + h01 * P1.x + h11 * (effectiveTransDist * P1.tanX);
          const cz = h00 * bumperZ + h10 * (effectiveTransDist * fwdZ) + h01 * P1.z + h11 * (effectiveTransDist * P1.tanZ);
          centerPoints.push({ x: cx, y: roadElevation, z: cz });
        } else {
          // Track polyline lane center directly
          const pt = targetLanePts[i] || targetLanePts[targetLanePts.length - 1];
          centerPoints.push({ x: pt.x, y: roadElevation, z: pt.z });
        }
      }
    } else if (activeCurve && bestDistSq < 200) {
      // Free cruise mode: Hermite blend from front bumper into road curve lane
      const latShift = status.lateralShift || 0;
      const totalOffset = targetLaneOffset + latShift;

      const targetS1 = currentS + travelDir * transDist;
      const u1 = clamp(targetS1 / segLen, 0, 1);
      const frame1 = SplineUtils.computeFrame(activeCurve, u1);
      const P1 = {
        x: frame1.position.x + frame1.right.x * totalOffset,
        z: frame1.position.z + frame1.right.z * totalOffset,
        tanX: travelDir * frame1.tangent.x,
        tanZ: travelDir * frame1.tangent.z,
      };

      for (let i = 0; i <= N_SEGS; i++) {
        const frac = i / N_SEGS;
        const dAhead = frac * lookaheadDist;

        if (i === 0) {
          centerPoints.push({ x: bumperX, y: roadElevation, z: bumperZ });
        } else if (dAhead <= transDist) {
          const u = clamp(dAhead / transDist, 0, 1);
          const u2 = u * u;
          const u3 = u2 * u;
          const h00 = 2 * u3 - 3 * u2 + 1;
          const h10 = u3 - 2 * u2 + u;
          const h01 = -2 * u3 + 3 * u2;
          const h11 = u3 - u2;

          const cx = h00 * bumperX + h10 * (transDist * fwdX) + h01 * P1.x + h11 * (transDist * P1.tanX);
          const cz = h00 * bumperZ + h10 * (transDist * fwdZ) + h01 * P1.z + h11 * (transDist * P1.tanZ);
          centerPoints.push({ x: cx, y: roadElevation, z: cz });
        } else {
          const targetS = currentS + travelDir * dAhead;
          const uParam = clamp(targetS / segLen, 0, 1);
          const frame = SplineUtils.computeFrame(activeCurve, uParam);
          centerPoints.push({
            x: frame.position.x + frame.right.x * totalOffset,
            y: roadElevation,
            z: frame.position.z + frame.right.z * totalOffset,
          });
        }
      }
    } else {
      // Kinematic fallback
      for (let i = 0; i <= N_SEGS; i++) {
        const frac = i / N_SEGS;
        const dAhead = frac * lookaheadDist;
        centerPoints.push({
          x: bumperX + fwdX * dAhead,
          y: roadElevation,
          z: bumperZ + fwdZ * dAhead,
        });
      }
    }

    // ── STAGE 2: EXTRUDE RIBBON USING TANGENT-DERIVED NORMAL VECTORS ─────────
    // Normals (rx, rz) are computed strictly perpendicular to the curve's own tangent.
    // This mathematically guarantees no hourglass pinching, bowties, or vertex crossings!
    const rPosArr = this.ribbonGeo.attributes.position.array;
    const rColArr = this.ribbonGeo.attributes.color.array;
    const lPosArr = this.edgeGeoL.attributes.position.array;
    const lColArr = this.edgeGeoL.attributes.color.array;
    const rEdgePosArr = this.edgeGeoR.attributes.position.array;
    const rEdgeColArr = this.edgeGeoR.attributes.color.array;
    const cPosArr = this.centerGeo.attributes.position.array;
    const cColArr = this.centerGeo.attributes.color.array;

    for (let i = 0; i <= N_SEGS; i++) {
      const frac = i / N_SEGS;
      const cp = centerPoints[i];
      const cx = cp.x;
      const cy = cp.y;
      const cz = cp.z;

      // Local tangent along trajectory
      let tanX = 0, tanZ = -1;
      if (i === 0) {
        tanX = centerPoints[1].x - centerPoints[0].x;
        tanZ = centerPoints[1].z - centerPoints[0].z;
        if (Math.hypot(tanX, tanZ) < 1e-4) {
          tanX = fwdX;
          tanZ = fwdZ;
        }
      } else if (i === N_SEGS) {
        tanX = centerPoints[N_SEGS].x - centerPoints[N_SEGS - 1].x;
        tanZ = centerPoints[N_SEGS].z - centerPoints[N_SEGS - 1].z;
      } else {
        tanX = centerPoints[i + 1].x - centerPoints[i - 1].x;
        tanZ = centerPoints[i + 1].z - centerPoints[i - 1].z;
      }
      const tanLen = Math.hypot(tanX, tanZ) || 1;
      tanX /= tanLen;
      tanZ /= tanLen;

      // Perpendicular right vector: 90° clockwise from tangent
      const rx = -tanZ;
      const rz = tanX;

      // Ribbon half-width with gentle distance taper
      const hw = 0.90 * (1.0 - 0.20 * frac);
      const lx = cx - rx * hw;
      const ly = cy + 0.002;
      const lz = cz - rz * hw;

      const rxPos = cx + rx * hw;
      const ryPos = cy + 0.002;
      const rzPos = cz + rz * hw;

      // Animated Tesla Pulse Flow Effect
      const flowPulse = 0.72 + 0.28 * Math.sin(timeSec * 12.0 - i * 0.48);
      const distFade = clamp(1.0 - Math.pow(frac, 1.15), 0.0, 1.0) * flowPulse;

      // Ribbon Quads
      const vL = (i * 2) * 3;
      const vR = (i * 2 + 1) * 3;

      rPosArr[vL] = lx;     rPosArr[vL + 1] = ly;     rPosArr[vL + 2] = lz;
      rPosArr[vR] = rxPos;  rPosArr[vR + 1] = ryPos;  rPosArr[vR + 2] = rzPos;

      const fillAlpha = distFade * 0.45;
      rColArr[vL] = rBase * fillAlpha;     rColArr[vL + 1] = gBase * fillAlpha;     rColArr[vL + 2] = bBase * fillAlpha;
      rColArr[vR] = rBase * fillAlpha;     rColArr[vR + 1] = gBase * fillAlpha;     rColArr[vR + 2] = bBase * fillAlpha;

      // Left Edge Line
      const idx = i * 3;
      lPosArr[idx] = lx;     lPosArr[idx + 1] = ly;     lPosArr[idx + 2] = lz;
      const edgeAlpha = distFade * 0.90;
      lColArr[idx] = rBase * edgeAlpha;     lColArr[idx + 1] = gBase * edgeAlpha;     lColArr[idx + 2] = bBase * edgeAlpha;

      // Right Edge Line
      rEdgePosArr[idx] = rxPos; rEdgePosArr[idx + 1] = ryPos; rEdgePosArr[idx + 2] = rzPos;
      rEdgeColArr[idx] = rBase * edgeAlpha; rEdgeColArr[idx + 1] = gBase * edgeAlpha; rEdgeColArr[idx + 2] = bBase * edgeAlpha;

      // Centerline Trajectory
      cPosArr[idx] = cx;     cPosArr[idx + 1] = cy + 0.005; cPosArr[idx + 2] = cz;
      const centerAlpha = distFade * 1.00;
      cColArr[idx] = rBase * centerAlpha;     cColArr[idx + 1] = gBase * centerAlpha;     cColArr[idx + 2] = bBase * centerAlpha;
    }

    this.ribbonGeo.attributes.position.needsUpdate = true;
    this.ribbonGeo.attributes.color.needsUpdate = true;
    this.edgeGeoL.attributes.position.needsUpdate = true;
    this.edgeGeoL.attributes.color.needsUpdate = true;
    this.edgeGeoR.attributes.position.needsUpdate = true;
    this.edgeGeoR.attributes.color.needsUpdate = true;
  }

  dispose() {
    this._sceneManager.remove(this.group);
    this.ribbonGeo.dispose();
    this.ribbonMat.dispose();
    this.edgeGeoL.dispose();
    this.edgeMatL.dispose();
    this.edgeGeoR.dispose();
    this.edgeMatR.dispose();
    this.centerGeo.dispose();
    this.centerMat.dispose();
  }
}
