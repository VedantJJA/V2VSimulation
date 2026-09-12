import * as THREE from 'three';
import { SplineUtils } from './SplineUtils.js';
import { MARKING_Y } from './LaneMarkingBuilder.js';
import { ASPHALT_TILE_M } from './RoadMeshBuilder.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ROAD = ConfigDefaults.road;

export const INTERSECTION_PAD_Y = MARKING_Y + ROAD.padLiftM;
export const CONNECTOR_Y = INTERSECTION_PAD_Y + ROAD.connectorLiftM;

/**
 * IntersectionBuilder — Cities: Skylines style road node & intersection system.
 *
 * Architecture:
 * 1. Degree-2 Node (2 roads):
 *    - Continuous road flow. If straight, roads meet flush.
 *    - If an angular turn, connects cross-sections via smooth quadratic Bézier ribbons.
 * 2. Multi-Road Junctions (3 or 4 roads) — Cities: Skylines Corner Fillets:
 *    - Incoming approaches are sorted cyclically by angle.
 *    - Between every adjacent pair of roads, dynamic curved corner fillets (curb radius)
 *      are computed based on the angle between them (R = W / (2 * tan(theta/2))).
 *    - Smooth Bézier corner curb arcs form the outer perimeter of the intersection asphalt.
 *    - Transverse stop lines, zebra crosswalks, and approach centerlines stop cleanly at the junction boundary.
 * 3. Roundabouts:
 *    - Circular roadway, raised grass island, concrete truck apron, entry yield teeth.
 *
 * Performance Optimized:
 * - Markings are batched into single buffer geometries per intersection.
 * - Unified geometry helper primitives with zero redundant allocations.
 */
export class IntersectionBuilder {
  /**
   * @param {object} options
   * @param {import('../core/Engine.js').Engine} options.engine
   * @param {THREE.Material} options.asphaltMaterial
   */
  constructor({ engine, asphaltMaterial }) {
    if (!asphaltMaterial) {
      throw new TypeError('IntersectionBuilder: requires asphaltMaterial owned by RoadMeshBuilder');
    }
    this._sceneManager = engine.sceneManager;
    this._asphaltMaterial = asphaltMaterial;
    /** @type {Map<string, THREE.Group>} */
    this._groups = new Map();

    this._whiteMaterial = new THREE.MeshStandardMaterial({
      color: 0xf2f4f6,
      roughness: 0.9,
    });
    this._yellowMaterial = new THREE.MeshStandardMaterial({
      color: 0xf5c542,
      roughness: 0.9,
    });
    this._grassMaterial = new THREE.MeshStandardMaterial({
      color: 0x386638,
      roughness: 0.95,
    });
    this._apronMaterial = new THREE.MeshStandardMaterial({
      color: 0x8a9096,
      roughness: 0.8,
    });
    this._curbMaterial = new THREE.MeshStandardMaterial({
      color: 0xc8cdd2,
      roughness: 0.75,
    });
  }

  buildAll(network) {
    for (const nodeId of network.nodeIds) {
      if (network.getSegmentsAtNode(nodeId).length >= 2) this.buildAtNode(network, nodeId);
    }
  }

  buildAtNode(network, nodeId) {
    if (this._groups.has(nodeId)) return this.rebuildAtNode(network, nodeId);
    const node = network.getNode(nodeId);
    const segments = network.getSegmentsAtNode(nodeId);
    if (!segments || segments.length < 2) return null;

    const group = new THREE.Group();
    group.name = `intersection:${nodeId}`;

    // Case 1: Degree-2 Node (Continuous road bend)
    if (segments.length === 2) {
      const segA = segments[0];
      const segB = segments[1];
      const dirA = segA.startNodeId === node.id
        ? segA.getCurve().getTangentAt(0)
        : segA.getCurve().getTangentAt(1).clone().negate();
      const dirB = segB.startNodeId === node.id
        ? segB.getCurve().getTangentAt(0)
        : segB.getCurve().getTangentAt(1).clone().negate();

      const dot = dirA.x * dirB.x + dirA.z * dirB.z;

      // If bend > 8° (dot > -0.99), build smooth Bézier connecting ribbon
      if (dot > -0.99) {
        const bezierGroup = this._buildDegree2BezierConnection(node, segA, segB, dirA, dirB);
        if (bezierGroup) group.add(bezierGroup);
      }

      this._sceneManager.add(group);
      this._groups.set(nodeId, group);
      return group;
    }

    // Case 2: Multi-Road Junctions (Cities: Skylines curved corner fillets or roundabout)
    if (node.intersectionType === 'roundabout') {
      const roundaboutMesh = this._buildRoundaboutGeometry(node, segments);
      if (roundaboutMesh) group.add(roundaboutMesh);

      const markingsMesh = this._buildRoundaboutMarkings(node, segments);
      if (markingsMesh) group.add(markingsMesh);
    } else {
      // Cities: Skylines style intersection with curved corner fillets
      const junctionMesh = this._buildFilletJunction(node, segments);
      if (junctionMesh) group.add(junctionMesh);

      const markingsMesh = this._buildFilletJunctionMarkings(node, segments);
      if (markingsMesh) group.add(markingsMesh);
    }

    this._sceneManager.add(group);
    this._groups.set(nodeId, group);
    return group;
  }

  rebuildAtNode(network, nodeId) {
    const existing = this._groups.get(nodeId);
    if (existing) {
      this._disposeGroup(existing);
      this._groups.delete(nodeId);
    }
    return this.buildAtNode(network, nodeId);
  }

  rebuildAll(network) {
    this.disposeAll();
    this.buildAll(network);
  }

  getGroup(nodeId) {
    return this._groups.get(nodeId) || null;
  }

  disposeAll() {
    for (const group of this._groups.values()) {
      this._disposeGroup(group);
    }
    this._groups.clear();
    this._whiteMaterial.dispose();
    this._yellowMaterial.dispose();
    this._grassMaterial.dispose();
    this._apronMaterial.dispose();
    this._curbMaterial.dispose();
  }

  // ---------------------------------------------------------------------------
  // Cities: Skylines Intersection System (Curved Corner Fillets)
  // ---------------------------------------------------------------------------

  /**
   * Builds an authentic Cities: Skylines style intersection:
   * - Computes cyclical approach order.
   * - Creates smooth corner fillets (curb radii) between adjacent roads.
   * - Generates unified asphalt mesh conforming to the fillets.
   */
  _buildFilletJunction(node, segments) {
    const group = new THREE.Group();
    group.name = `intersection:${node.id}:fillet-junction`;

    // 1. Gather approach cross-sections
    const approaches = segments.map((seg) => {
      const atStart = seg.startNodeId === node.id;
      const dir = atStart
        ? seg.getCurve().getTangentAt(0)
        : seg.getCurve().getTangentAt(1).clone().negate();
      const angle = Math.atan2(dir.z, dir.x);
      const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
      const hwFwd = seg.halfWidthForwardM;
      const hwBwd = seg.halfWidthBackwardM;
      const roadW = seg.roadWidthM;

      return {
        segment: seg,
        dir,
        perp,
        angle,
        hwFwd,
        hwBwd,
        roadW,
        atStart,
      };
    });

    // Sort approaches cyclically (counter-clockwise around node)
    approaches.sort((a, b) => a.angle - b.angle);

    const N = approaches.length;
    const boundaryPoints = [];
    const curbLines = []; // Array of corner fillet point arrays
    const cy = node.position.y + INTERSECTION_PAD_Y;

    // 2. Compute corner fillets between adjacent approaches (i and next)
    for (let i = 0; i < N; i++) {
      const appA = approaches[i];
      const nextIdx = (i + 1) % N;
      const appB = approaches[nextIdx];

      // Angle between approach A and approach B
      let dAngle = appB.angle - appA.angle;
      if (dAngle < 0) dAngle += Math.PI * 2;

      // Setback distance along each approach
      const maxW = Math.max(appA.roadW, appB.roadW);
      const setbackA = Math.min(Math.max(maxW * 0.75, 4.5), appA.segment.lengthM * 0.35);
      const setbackB = Math.min(Math.max(maxW * 0.75, 4.5), appB.segment.lengthM * 0.35);

      // Mouth cross-sections:
      // In Three.js: right edge of road A is +perp, left edge of road B is -perp
      const pMouthA_right = node.position.clone().addScaledVector(appA.dir, setbackA).addScaledVector(appA.perp, appA.hwFwd + 0.1);
      const pMouthA_left = node.position.clone().addScaledVector(appA.dir, setbackA).addScaledVector(appA.perp, -(appA.hwBwd + 0.1));

      const pMouthB_right = node.position.clone().addScaledVector(appB.dir, setbackB).addScaledVector(appB.perp, appB.hwFwd + 0.1);
      const pMouthB_left = node.position.clone().addScaledVector(appB.dir, setbackB).addScaledVector(appB.perp, -(appB.hwBwd + 0.1));

      // Fillet between Right of Road A and Left of Road B
      // Dynamic curb fillet radius (Cities: Skylines formula)
      const halfAngle = Math.max(0.15, dAngle * 0.5);
      const baseR = (maxW * 0.45) / Math.tan(halfAngle);
      const filletRadius = THREE.MathUtils.clamp(baseR, 2.5, 9.0);

      // 2D Ray intersection control point for the corner fillet
      const dirTowardsNodeA = appA.dir.clone().negate();
      const dirTowardsNodeB = appB.dir.clone().negate();
      const cornerCtrl = this._intersectRays2D(
        pMouthA_right,
        dirTowardsNodeA,
        pMouthB_left,
        dirTowardsNodeB,
        node.position
      );

      // Generate curved corner fillet vertices (quadratic Bézier arc)
      const cornerArc = [];
      const filletSteps = 6;
      for (let s = 0; s <= filletSteps; s++) {
        const u = s / filletSteps;
        const it = 1 - u;
        const px = it * it * pMouthA_right.x + 2 * it * u * cornerCtrl.x + u * u * pMouthB_left.x;
        const pz = it * it * pMouthA_right.z + 2 * it * u * cornerCtrl.z + u * u * pMouthB_left.z;
        const pt = new THREE.Vector3(px, cy, pz);
        cornerArc.push(pt);
        boundaryPoints.push(pt);
      }
      curbLines.push(cornerArc);

      // Add road B mouth cross-section transition
      boundaryPoints.push(pMouthB_right.clone().setY(cy));
    }

    // 3. Triangulate intersection asphalt polygon
    // Radial sort boundary points to form a clean perimeter
    boundaryPoints.sort((a, b) => {
      const angA = Math.atan2(a.z - node.position.z, a.x - node.position.x);
      const angB = Math.atan2(b.z - node.position.z, b.x - node.position.x);
      return angA - angB;
    });

    const asphaltMesh = this._createAsphaltPolygon(node, boundaryPoints, `intersection:${node.id}:asphalt`);
    if (asphaltMesh) group.add(asphaltMesh);

    // 4. Concrete Curb Rim Highlights along the corner fillets
    const curbPositions = [];
    const curbIndices = [];
    const curbY = cy + 0.03;
    const curbW = 0.28;

    for (const arc of curbLines) {
      this._addPolylineRibbon(arc, curbW, curbY, curbPositions, curbIndices);
    }

    if (curbPositions.length > 0) {
      const curbGeo = new THREE.BufferGeometry();
      curbGeo.setAttribute('position', new THREE.Float32BufferAttribute(curbPositions, 3));
      curbGeo.setIndex(curbIndices);
      curbGeo.computeVertexNormals();
      const curbMesh = new THREE.Mesh(curbGeo, this._curbMaterial);
      curbMesh.name = `intersection:${node.id}:curbs`;
      group.add(curbMesh);
    }

    return group;
  }

  /**
   * Crisp Stop Lines, Zebra Crosswalks, and Centerline Dividers for Multi-Road Junction.
   */
  _buildFilletJunctionMarkings(node, segments) {
    const whitePositions = [];
    const whiteIndices = [];
    const yellowPositions = [];
    const yellowIndices = [];
    const y = node.position.y + CONNECTOR_Y;

    for (const seg of segments) {
      const atStart = seg.startNodeId === node.id;
      const dir = atStart
        ? seg.getCurve().getTangentAt(0)
        : seg.getCurve().getTangentAt(1).clone().negate();
      const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();

      const hwFwd = seg.halfWidthForwardM;
      const hwBwd = seg.halfWidthBackwardM;
      const roadW = seg.roadWidthM;
      const mouthDist = Math.min(Math.max(roadW * 0.75, 4.5), seg.lengthM * 0.35);

      const incomingWidth = atStart ? hwBwd : hwFwd;
      const outgoingWidth = atStart ? hwFwd : hwBwd;
      const mouthCenter = node.position.clone().addScaledVector(dir, mouthDist);

      // 1. Pedestrian Zebra Crosswalk
      this._addCrosswalk(mouthCenter, dir, perp, incomingWidth, outgoingWidth, y, whitePositions, whiteIndices);

      // 2. Solid White Stop Line across inbound lane(s)
      const stopCenter = mouthCenter.clone().addScaledVector(dir, 0.5);
      this._addQuad(stopCenter, stopCenter.clone().addScaledVector(perp, -incomingWidth), 0.45, y, whitePositions, whiteIndices);

      // 3. Centerline divider ending at stop bar
      if (seg.lanesForward > 0 && seg.lanesBackward > 0) {
        const segEndPoint = SplineUtils.lateralAt(seg.getCurve(), atStart ? 0 : 1, 0);
        this._addQuad(segEndPoint, stopCenter, ROAD.markingLineWidthM * 1.5, y, yellowPositions, yellowIndices);
      }
    }

    const group = new THREE.Group();
    group.name = `intersection:${node.id}:markings`;

    if (whitePositions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(whitePositions, 3));
      geo.setIndex(whiteIndices);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, this._whiteMaterial));
    }

    if (yellowPositions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(yellowPositions, 3));
      geo.setIndex(yellowIndices);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, this._yellowMaterial));
    }

    return group.children.length > 0 ? group : null;
  }

  // ---------------------------------------------------------------------------
  // Degree-2 Continuous Bézier Road Bend
  // ---------------------------------------------------------------------------

  _buildDegree2BezierConnection(node, segA, segB, dirA, dirB) {
    const group = new THREE.Group();
    group.name = `intersection:${node.id}:bezier-bend`;

    const W_A = segA.roadWidthM;
    const W_B = segB.roadWidthM;
    const SA = Math.min(Math.max(W_A * 0.85, 4.0), segA.lengthM * 0.35, segB.lengthM * 0.35);
    const SB = Math.min(Math.max(W_B * 0.85, 4.0), segA.lengthM * 0.35, segB.lengthM * 0.35);

    const tA = segA.startNodeId === node.id ? (SA / segA.lengthM) : (1.0 - SA / segA.lengthM);
    const tB = segB.startNodeId === node.id ? (SB / segB.lengthM) : (1.0 - SB / segB.lengthM);

    const frameA = SplineUtils.computeFrame(segA.getCurve(), tA);
    const frameB = SplineUtils.computeFrame(segB.getCurve(), tB);

    const centerA = frameA.position.clone();
    const centerB = frameB.position.clone();
    const bisector = new THREE.Vector3().addVectors(dirA, dirB).normalize();

    const edgeA_fwd = centerA.clone().addScaledVector(frameA.right, segA.halfWidthForwardM);
    const edgeA_bwd = centerA.clone().addScaledVector(frameA.right, -segA.halfWidthBackwardM);
    const edgeB_fwd = centerB.clone().addScaledVector(frameB.right, segB.halfWidthForwardM);
    const edgeB_bwd = centerB.clone().addScaledVector(frameB.right, -segB.halfWidthBackwardM);

    const isAfwdInner = edgeA_fwd.clone().sub(node.position).dot(bisector) > edgeA_bwd.clone().sub(node.position).dot(bisector);
    const innerEdgeA = isAfwdInner ? edgeA_fwd : edgeA_bwd;
    const outerEdgeA = isAfwdInner ? edgeA_bwd : edgeA_fwd;

    const isBfwdInner = edgeB_fwd.clone().sub(node.position).dot(bisector) > edgeB_bwd.clone().sub(node.position).dot(bisector);
    const innerEdgeB = isBfwdInner ? edgeB_fwd : edgeB_bwd;
    const outerEdgeB = isBfwdInner ? edgeB_bwd : edgeB_fwd;

    const toNodeA = dirA.clone().negate();
    const toNodeB = dirB.clone().negate();

    const controlOuter = this._intersectRays2D(outerEdgeA, toNodeA, outerEdgeB, toNodeB, node.position);
    const controlInner = this._intersectRays2D(innerEdgeA, toNodeA, innerEdgeB, toNodeB, node.position);
    const controlCenter = node.position.clone();

    // 1. Curved asphalt ribbon
    const padMesh = this._buildCurvedAsphaltRibbon(
      innerEdgeA, outerEdgeA, controlInner, controlOuter, innerEdgeB, outerEdgeB,
      node.position, `intersection:${node.id}:bend-asphalt`
    );
    if (padMesh) group.add(padMesh);

    // 2. Continuous markings
    const whitePositions = [];
    const whiteIndices = [];
    const yellowPositions = [];
    const yellowIndices = [];
    const y = node.position.y + CONNECTOR_Y;

    if (segA.lanesForward > 0 && segA.lanesBackward > 0 && segB.lanesForward > 0 && segB.lanesBackward > 0) {
      this._addBezierRibbon(centerA, controlCenter, centerB, ROAD.markingLineWidthM, y, yellowPositions, yellowIndices);
    }
    this._addBezierRibbon(outerEdgeA, controlOuter, outerEdgeB, ROAD.markingLineWidthM, y, whitePositions, whiteIndices);
    this._addBezierRibbon(innerEdgeA, controlInner, innerEdgeB, ROAD.markingLineWidthM, y, whitePositions, whiteIndices);

    // Multi-lane dashed dividers
    const lanes = Math.min(segA.lanesForward + segA.lanesBackward, segB.lanesForward + segB.lanesBackward);
    for (let l = 1; l < lanes; l++) {
      const frac = l / lanes;
      if (Math.abs(frac - 0.5) < 0.05 && (segA.lanesForward > 0 && segA.lanesBackward > 0)) continue;
      const pA = outerEdgeA.clone().lerp(innerEdgeA, frac);
      const pB = outerEdgeB.clone().lerp(innerEdgeB, frac);
      const pCtrl = controlOuter.clone().lerp(controlInner, frac);
      this._addDashedBezierRibbon(pA, pCtrl, pB, ROAD.markingLineWidthM * 0.8, y, whitePositions, whiteIndices);
    }

    if (whitePositions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(whitePositions, 3));
      geo.setIndex(whiteIndices);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, this._whiteMaterial));
    }

    if (yellowPositions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(yellowPositions, 3));
      geo.setIndex(yellowIndices);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, this._yellowMaterial));
    }

    return group;
  }

  // ---------------------------------------------------------------------------
  // Roundabouts
  // ---------------------------------------------------------------------------

  _buildRoundaboutGeometry(node, segments) {
    const group = new THREE.Group();
    group.name = `intersection:${node.id}:roundabout-geo`;

    const maxHw = Math.max(...segments.map((s) => Math.max(s.halfWidthForwardM, s.halfWidthBackwardM)));
    const outerR = Math.max(14.0, maxHw + 7.5);
    const apronR = 6.8;
    const islandR = 5.2;
    const cy = node.position.y + INTERSECTION_PAD_Y;

    // Circulating outer perimeter points
    const points = [];
    const circleSteps = 32;
    for (let i = 0; i < circleSteps; i++) {
      const th = (i / circleSteps) * Math.PI * 2;
      points.push(new THREE.Vector3(
        node.position.x + Math.cos(th) * outerR,
        cy,
        node.position.z + Math.sin(th) * outerR
      ));
    }

    // Approach expansion mouths
    for (const seg of segments) {
      const dir = seg.startNodeId === node.id
        ? seg.getCurve().getTangentAt(0)
        : seg.getCurve().getTangentAt(1).clone().negate();
      const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
      const mouthDist = outerR + 2.8;

      points.push(node.position.clone().addScaledVector(dir, mouthDist).addScaledVector(perp, seg.halfWidthForwardM + 0.4));
      points.push(node.position.clone().addScaledVector(dir, mouthDist).addScaledVector(perp, -(seg.halfWidthBackwardM + 0.4)));
    }

    points.sort((a, b) => {
      const angA = Math.atan2(a.z - node.position.z, a.x - node.position.x);
      const angB = Math.atan2(b.z - node.position.z, b.x - node.position.x);
      return angA - angB;
    });

    const asphaltMesh = this._createAsphaltPolygon(node, points, `intersection:${node.id}:roundabout-asphalt`);
    if (asphaltMesh) group.add(asphaltMesh);

    // Raised grass island
    const islandGeo = new THREE.CylinderGeometry(islandR, islandR, 0.35, 32);
    const islandMesh = new THREE.Mesh(islandGeo, this._grassMaterial);
    islandMesh.position.set(node.position.x, cy + 0.175, node.position.z);
    group.add(islandMesh);

    // Concrete curb ring
    const curbGeo = new THREE.RingGeometry(islandR - 0.2, islandR, 32);
    curbGeo.rotateX(-Math.PI / 2);
    const curbMesh = new THREE.Mesh(curbGeo, this._curbMaterial);
    curbMesh.position.set(node.position.x, cy + 0.355, node.position.z);
    group.add(curbMesh);

    // Truck apron ring
    const apronGeo = new THREE.RingGeometry(islandR, apronR, 32);
    apronGeo.rotateX(-Math.PI / 2);
    const apronMesh = new THREE.Mesh(apronGeo, this._apronMaterial);
    apronMesh.position.set(node.position.x, cy + 0.04, node.position.z);
    group.add(apronMesh);

    return group;
  }

  _buildRoundaboutMarkings(node, segments) {
    const whitePositions = [];
    const whiteIndices = [];
    const yellowPositions = [];
    const yellowIndices = [];
    const y = node.position.y + CONNECTOR_Y;

    const maxHw = Math.max(...segments.map((s) => Math.max(s.halfWidthForwardM, s.halfWidthBackwardM)));
    const outerR = Math.max(14.0, maxHw + 7.5);
    const apronR = 6.8;

    // Circulating lane ring
    const circR = (apronR + outerR) * 0.52;
    const circSteps = 36;
    for (let i = 0; i < circSteps; i += 2) {
      const th0 = (i / circSteps) * Math.PI * 2;
      const th1 = ((i + 1) / circSteps) * Math.PI * 2;
      const p0 = new THREE.Vector3(node.position.x + Math.cos(th0) * circR, y, node.position.z + Math.sin(th0) * circR);
      const p1 = new THREE.Vector3(node.position.x + Math.cos(th1) * circR, y, node.position.z + Math.sin(th1) * circR);
      this._addQuad(p0, p1, ROAD.markingLineWidthM, y, whitePositions, whiteIndices);
    }

    // Approach Yield Markings
    for (const seg of segments) {
      const atStart = seg.startNodeId === node.id;
      const dir = atStart
        ? seg.getCurve().getTangentAt(0)
        : seg.getCurve().getTangentAt(1).clone().negate();
      const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();

      const incomingWidth = atStart ? seg.halfWidthBackwardM : seg.halfWidthForwardM;
      const outgoingWidth = atStart ? seg.halfWidthForwardM : seg.halfWidthBackwardM;
      const yieldCenter = node.position.clone().addScaledVector(dir, outerR);

      // Yield shark-teeth
      const teethCount = Math.max(2, Math.floor(incomingWidth / 0.85));
      for (let i = 0; i < teethCount; i++) {
        const offset = -(0.45 + i * 0.85);
        const toothBase = yieldCenter.clone().addScaledVector(perp, offset);
        const tip = toothBase.clone().addScaledVector(dir, 1.1);
        const b1 = toothBase.clone().addScaledVector(perp, -0.28);
        const b2 = toothBase.clone().addScaledVector(perp, 0.28);
        this._addTriangle(tip, b1, b2, y, whitePositions, whiteIndices);
      }

      // Yield transverse bar
      this._addQuad(yieldCenter, yieldCenter.clone().addScaledVector(perp, -incomingWidth), 0.25, y, whitePositions, whiteIndices);

      // Setback crosswalk
      const crosswalkCenter = yieldCenter.clone().addScaledVector(dir, 3.8);
      this._addCrosswalk(crosswalkCenter, dir, perp, incomingWidth, outgoingWidth, y, whitePositions, whiteIndices);

      // Centerline up to yield line
      if (seg.lanesForward > 0 && seg.lanesBackward > 0) {
        const segEndPoint = SplineUtils.lateralAt(seg.getCurve(), atStart ? 0 : 1, 0);
        this._addQuad(segEndPoint, yieldCenter, ROAD.markingLineWidthM * 1.5, y, yellowPositions, yellowIndices);
      }
    }

    const group = new THREE.Group();
    group.name = `intersection:${node.id}:roundabout-markings`;

    if (whitePositions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(whitePositions, 3));
      geo.setIndex(whiteIndices);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, this._whiteMaterial));
    }

    if (yellowPositions.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(yellowPositions, 3));
      geo.setIndex(yellowIndices);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, this._yellowMaterial));
    }

    return group.children.length > 0 ? group : null;
  }

  // ---------------------------------------------------------------------------
  // Geometry Primitives & Helpers
  // ---------------------------------------------------------------------------

  _createAsphaltPolygon(node, points, name) {
    if (points.length < 3) return null;

    const vertices = [];
    const uvs = [];
    const indices = [];
    const cy = node.position.y + INTERSECTION_PAD_Y;

    // Center hub vertex
    vertices.push(node.position.x, cy, node.position.z);
    uvs.push(node.position.x / ASPHALT_TILE_M, node.position.z / ASPHALT_TILE_M);

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      vertices.push(p.x, cy, p.z);
      uvs.push(p.x / ASPHALT_TILE_M, p.z / ASPHALT_TILE_M);

      const next = (i + 1) % points.length;
      indices.push(0, next + 1, i + 1);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, this._asphaltMaterial);
    mesh.name = name;
    mesh.receiveShadow = true;
    return mesh;
  }

  _buildCurvedAsphaltRibbon(innerA, outerA, ctrlInner, ctrlOuter, innerB, outerB, nodePos, name) {
    const steps = 20;
    const vertices = [];
    const uvs = [];
    const indices = [];
    const y = nodePos.y + INTERSECTION_PAD_Y;

    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const it = 1 - u;

      const pxOuter = it * it * outerA.x + 2 * it * u * ctrlOuter.x + u * u * outerB.x;
      const pzOuter = it * it * outerA.z + 2 * it * u * ctrlOuter.z + u * u * outerB.z;
      const pxInner = it * it * innerA.x + 2 * it * u * ctrlInner.x + u * u * innerB.x;
      const pzInner = it * it * innerA.z + 2 * it * u * ctrlInner.z + u * u * innerB.z;

      vertices.push(pxOuter, y, pzOuter, pxInner, y, pzInner);
      uvs.push(pxOuter / ASPHALT_TILE_M, pzOuter / ASPHALT_TILE_M, pxInner / ASPHALT_TILE_M, pzInner / ASPHALT_TILE_M);

      if (i < steps) {
        const base = i * 2;
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }

    // Outer corner wedge fill to seal outer vertex
    const baseWedge = vertices.length / 3;
    vertices.push(ctrlOuter.x, y, ctrlOuter.z, outerA.x, y, outerA.z, outerB.x, y, outerB.z);
    uvs.push(ctrlOuter.x / ASPHALT_TILE_M, ctrlOuter.z / ASPHALT_TILE_M, outerA.x / ASPHALT_TILE_M, outerA.z / ASPHALT_TILE_M, outerB.x / ASPHALT_TILE_M, outerB.z / ASPHALT_TILE_M);
    const cross = (outerA.z - ctrlOuter.z) * (outerB.x - ctrlOuter.x) - (outerA.x - ctrlOuter.x) * (outerB.z - ctrlOuter.z);
    if (cross > 0) indices.push(baseWedge, baseWedge + 1, baseWedge + 2);
    else indices.push(baseWedge, baseWedge + 2, baseWedge + 1);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, this._asphaltMaterial);
    mesh.name = name;
    mesh.receiveShadow = true;
    return mesh;
  }

  _addCrosswalk(mouthCenter, dir, perp, incomingWidth, outgoingWidth, y, positions, indices) {
    const crosswalkOffsetM = -1.5;
    const crosswalkWidthM = 2.4;
    const stripeLengthM = 1.9;
    const stripeWidthM = 0.5;
    const stripeGapM = 0.45;
    const step = stripeWidthM + stripeGapM;

    const leftBoundary = -incomingWidth + 0.3;
    const rightBoundary = outgoingWidth - 0.3;
    const totalSpan = rightBoundary - leftBoundary;
    if (totalSpan <= 1.0) return;

    // Inner & Outer boundary lines
    const innerCenter = mouthCenter.clone().addScaledVector(dir, crosswalkOffsetM + crosswalkWidthM / 2);
    this._addQuad(innerCenter.clone().addScaledVector(perp, leftBoundary), innerCenter.clone().addScaledVector(perp, rightBoundary), 0.15, y, positions, indices);

    const outerCenter = mouthCenter.clone().addScaledVector(dir, crosswalkOffsetM - crosswalkWidthM / 2);
    this._addQuad(outerCenter.clone().addScaledVector(perp, leftBoundary), outerCenter.clone().addScaledVector(perp, rightBoundary), 0.15, y, positions, indices);

    // Zebra stripes
    const count = Math.floor(totalSpan / step);
    const startOffset = leftBoundary + (totalSpan - (count * step - stripeGapM)) / 2;
    const center = mouthCenter.clone().addScaledVector(dir, crosswalkOffsetM);

    for (let i = 0; i < count; i++) {
      const lat = startOffset + i * step + stripeWidthM / 2;
      const sc = center.clone().addScaledVector(perp, lat);
      const p1 = sc.clone().addScaledVector(dir, -stripeLengthM / 2);
      const p2 = sc.clone().addScaledVector(dir, stripeLengthM / 2);
      this._addQuad(p1, p2, stripeWidthM, y, positions, indices);
    }
  }

  _addQuad(p1, p2, width, y, positions, indices) {
    const dir = new THREE.Vector3().subVectors(p2, p1);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.normalize();
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    const hw = width / 2;
    const base = positions.length / 3;

    positions.push(
      p1.x - perp.x * hw, y, p1.z - perp.z * hw,
      p2.x - perp.x * hw, y, p2.z - perp.z * hw,
      p2.x + perp.x * hw, y, p2.z + perp.z * hw,
      p1.x + perp.x * hw, y, p1.z + perp.z * hw
    );
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  _addBezierRibbon(p0, pCtrl, p1, width, y, positions, indices, steps = 20) {
    const half = width / 2;
    const startIndex = positions.length / 3;

    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const it = 1 - u;

      const px = it * it * p0.x + 2 * it * u * pCtrl.x + u * u * p1.x;
      const pz = it * it * p0.z + 2 * it * u * pCtrl.z + u * u * p1.z;
      const tx = 2 * it * (pCtrl.x - p0.x) + 2 * u * (p1.x - pCtrl.x);
      const tz = 2 * it * (pCtrl.z - p0.z) + 2 * u * (p1.z - pCtrl.z);
      const len = Math.hypot(tx, tz) || 1;
      const nx = -tz / len;
      const nz = tx / len;

      positions.push(px + nx * half, y, pz + nz * half, px - nx * half, y, pz - nz * half);

      if (i < steps) {
        const base = startIndex + i * 2;
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
  }

  _addDashedBezierRibbon(p0, pCtrl, p1, width, y, positions, indices, steps = 20, dashM = 1.5, gapM = 1.5) {
    const chord = p0.distanceTo(p1);
    const approxLen = (chord + p0.distanceTo(pCtrl) + pCtrl.distanceTo(p1)) * 0.5;
    const period = dashM + gapM;
    const dashes = Math.max(1, Math.floor(approxLen / period));

    for (let d = 0; d < dashes; d++) {
      const u0 = (d * period) / approxLen;
      const u1 = Math.min(1.0, (d * period + dashM) / approxLen);
      if (u1 <= u0) break;

      const subSteps = 4;
      const startIndex = positions.length / 3;
      const half = width / 2;

      for (let s = 0; s <= subSteps; s++) {
        const u = u0 + (s / subSteps) * (u1 - u0);
        const it = 1 - u;
        const px = it * it * p0.x + 2 * it * u * pCtrl.x + u * u * p1.x;
        const pz = it * it * p0.z + 2 * it * u * pCtrl.z + u * u * p1.z;
        const tx = 2 * it * (pCtrl.x - p0.x) + 2 * u * (p1.x - pCtrl.x);
        const tz = 2 * it * (pCtrl.z - p0.z) + 2 * u * (p1.z - pCtrl.z);
        const len = Math.hypot(tx, tz) || 1;
        const nx = -tz / len;
        const nz = tx / len;

        positions.push(px + nx * half, y, pz + nz * half, px - nx * half, y, pz - nz * half);

        if (s < subSteps) {
          const base = startIndex + s * 2;
          indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
        }
      }
    }
  }

  _addPolylineRibbon(points, width, y, positions, indices) {
    if (points.length < 2) return;
    const half = width / 2;
    const startIndex = positions.length / 3;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let dir;
      if (i < points.length - 1) {
        dir = new THREE.Vector3().subVectors(points[i + 1], p).normalize();
      } else {
        dir = new THREE.Vector3().subVectors(p, points[i - 1]).normalize();
      }
      const nx = -dir.z;
      const nz = dir.x;

      positions.push(p.x + nx * half, y, p.z + nz * half, p.x - nx * half, y, p.z - nz * half);

      if (i < points.length - 1) {
        const base = startIndex + i * 2;
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
  }

  _addTriangle(p0, p1, p2, y, positions, indices) {
    const base = positions.length / 3;
    positions.push(p0.x, y, p0.z, p1.x, y, p1.z, p2.x, y, p2.z);
    indices.push(base, base + 1, base + 2);
  }

  _intersectRays2D(p1, d1, p2, d2, fallback) {
    const det = -d1.x * d2.z + d1.z * d2.x;
    if (Math.abs(det) < 1e-4) {
      return new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    }
    const dx = p2.x - p1.x;
    const dz = p2.z - p1.z;
    const s = (-dx * d2.z + dz * d2.x) / det;
    const result = new THREE.Vector3(p1.x + s * d1.x, fallback.y, p1.z + s * d1.z);
    const maxDist = 30;
    if (fallback && result.distanceTo(fallback) > maxDist) {
      result.sub(fallback).normalize().multiplyScalar(maxDist).add(fallback);
    }
    return result;
  }

  _disposeGroup(group) {
    for (const child of group.children) {
      if (child.isGroup) {
        for (const sub of child.children) sub.geometry?.dispose();
      } else {
        child.geometry?.dispose();
      }
    }
    this._sceneManager.remove(group);
  }
}