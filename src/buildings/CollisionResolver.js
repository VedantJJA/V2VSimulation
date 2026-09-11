import { SplineUtils } from '../road/SplineUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const BUILDINGS = ConfigDefaults.buildings;

/**
 * CollisionResolver — keeps buildings out of road corridors and apart from
 * each other (two passes: corridor pushes with margin, then
 * overlap-removal by recency). Resolution is monotonic: buildings only
 * move away. See the Phase 3 file notes for the full model; thresholds
 * come from ConfigDefaults.buildings.
 */
export class CollisionResolver {
  /**
   * @param {object} [options]
   * @param {number} [options.marginM]
   * @param {number} [options.buildingOverlapThresholdM]
   * @param {number} [options.footprintSampleSpacingM]
   */
  constructor({
    marginM = BUILDINGS.collisionMarginM,
    buildingOverlapThresholdM = BUILDINGS.overlapThresholdM,
    footprintSampleSpacingM = BUILDINGS.footprintSampleSpacingM,
  } = {}) {
    this.marginM = marginM;
    this.buildingOverlapThresholdM = buildingOverlapThresholdM;
    this.footprintSampleSpacingM = footprintSampleSpacingM;
  }

  /**
   * 2D OBB overlap depth via SAT over both boxes' axes (XZ plane).
   * @returns {number} 0 when separated, else the minimum-translation depth in meters.
   */
  static obbOverlapDepth2D(a, b) {
    const dx = b.center.x - a.center.x;
    const dz = b.center.z - a.center.z;
    const axes = [a.axisX, a.axisZ, b.axisX, b.axisZ];

    let minOverlap = Infinity;
    for (const axis of axes) {
      const nx = axis.x;
      const nz = axis.z;
      const extentA =
        a.halfW * Math.abs(a.axisX.x * nx + a.axisX.z * nz) +
        a.halfD * Math.abs(a.axisZ.x * nx + a.axisZ.z * nz);
      const extentB =
        b.halfW * Math.abs(b.axisX.x * nx + b.axisX.z * nz) +
        b.halfD * Math.abs(b.axisZ.x * nx + b.axisZ.z * nz);
      const separation = Math.abs(dx * nx + dz * nz);
      const overlap = extentA + extentB - separation;
      if (overlap <= 0) return 0; // separated on this axis
      if (overlap < minOverlap) minOverlap = overlap;
    }
    return minOverlap;
  }

  /**
   * Approximate road footprint of a segment at its CURRENT lane counts:
   * sampled centerline frames + per-side half-widths.
   */
  computeRoadFootprint(segment, { spacingM = this.footprintSampleSpacingM } = {}) {
    const curve = segment.getCurve();
    const length = curve.getLength();
    const sampleCount = Math.max(8, Math.ceil(length / spacingM) + 1);

    const halfWidthLeftM = segment.halfWidthBackwardM;
    const halfWidthRightM = segment.halfWidthForwardM;
    const maxHalf = Math.max(halfWidthLeftM, halfWidthRightM);

    const frames = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

    for (let i = 0; i < sampleCount; i++) {
      const t = i / (sampleCount - 1);
      const frame = SplineUtils.computeFrame(curve, t);
      frames.push({ t, position: frame.position, tangent: frame.tangent, right: frame.right });
      const x = frame.position.x;
      const z = frame.position.z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    return {
      segmentId: segment.id,
      lengthM: length,
      sampleSpacingM: spacingM,
      halfWidthLeftM,
      halfWidthRightM,
      frames,
      bounds: {
        minX: minX - maxHalf,
        maxX: maxX + maxHalf,
        minZ: minZ - maxHalf,
        maxZ: maxZ + maxHalf,
      },
    };
  }

  /**
   * Pass 1: push every building that intrudes into the segment's corridor
   * (pavement + margin). Returns (and logs) the push list.
   */
  resolveForSegment(segment, buildingManager) {
    const footprint = this.computeRoadFootprint(segment);
    const margin = this.marginM;

    // Expand by margin + worst-case building radius so buildings whose
    // CENTERS lie outside the footprint box still get found.
    const expansion = margin + buildingManager.maxHalfDiagonalM;
    const candidates = buildingManager.queryAABB({
      minX: footprint.bounds.minX - expansion,
      minZ: footprint.bounds.minZ - expansion,
      maxX: footprint.bounds.maxX + expansion,
      maxZ: footprint.bounds.maxZ + expansion,
    });

    const pushes = [];
    for (const building of candidates) {
      if (!buildingManager.has(building)) continue;

      const frame = this._nearestFrame(footprint, building.position);
      if (!frame) continue;

      // Push direction: nearest centerline sample → building center.
      const vx = building.position.x - frame.position.x;
      const vz = building.position.z - frame.position.z;
      const distance = Math.hypot(vx, vz);
      let ux, uz;
      if (distance < 1e-4) {
        // Building center sits ON the centerline — push to the right side.
        ux = frame.right.x;
        uz = frame.right.z;
      } else {
        ux = vx / distance;
        uz = vz / distance;
      }

      // Which side of the road? (Right = forward-travel side.)
      const side = vx * frame.right.x + vz * frame.right.z;
      const halfWidth = side >= 0 ? footprint.halfWidthRightM : footprint.halfWidthLeftM;

      // Building's OBB half-extent along the push direction.
      const obb = building.getOBB();
      const obbExtent =
        obb.halfW * Math.abs(ux * obb.axisX.x + uz * obb.axisX.z) +
        obb.halfD * Math.abs(ux * obb.axisZ.x + uz * obb.axisZ.z);

      const penetration = halfWidth + margin - (distance - obbExtent);
      if (penetration <= 0) continue;

      const fromX = building.position.x;
      const fromZ = building.position.z;
      buildingManager.moveBuilding(building, ux * penetration, uz * penetration);

      console.log(
        `[CollisionResolver] push: building "${building.id}" is ${penetration.toFixed(1)} m inside the ` +
        `road "${segment.id}" corridor (incl. ${margin.toFixed(1)} m margin) → translated ` +
        `${penetration.toFixed(1)} m to (${building.position.x.toFixed(1)}, ${building.position.z.toFixed(1)}), ` +
        `was (${fromX.toFixed(1)}, ${fromZ.toFixed(1)})`
      );
      pushes.push({
        id: building.id,
        segmentId: segment.id,
        distanceM: penetration,
        toX: building.position.x,
        toZ: building.position.z,
      });
    }
    return pushes;
  }

  /**
   * Pass 2: remove the more-recently-moved building of every pair that
   * still overlaps deeper than the threshold. Returns (and logs) removals.
   */
  resolveOverlaps(buildingManager) {
    const threshold = this.buildingOverlapThresholdM;
    const removals = [];
    const snapshot = buildingManager.getAll();

    // Query expansion: neighbors can be up to maxHalfDiagonalM in radius.
    const expansion = buildingManager.maxHalfDiagonalM + threshold;

    for (const building of snapshot) {
      if (!buildingManager.has(building)) continue; // already removed this pass
      const aabb = building.getAABB();
      const neighbors = buildingManager.queryAABB({
        minX: aabb.minX - expansion,
        minZ: aabb.minZ - expansion,
        maxX: aabb.maxX + expansion,
        maxZ: aabb.maxZ + expansion,
      });

      for (const other of neighbors) {
        if (other === building) continue;
        if (other.id <= building.id) continue; // visit each unordered pair once
        if (!buildingManager.has(other)) continue;

        const depth = CollisionResolver.obbOverlapDepth2D(building.getOBB(), other.getOBB());
        if (depth <= threshold) continue;

        const { victim, reason } = this._pickVictim(building, other);
        const survivor = victim === building ? other : building;
        buildingManager.remove(victim);

        console.log(
          `[CollisionResolver] remove: building "${victim.id}" overlaps "${survivor.id}" by ` +
          `${depth.toFixed(1)} m (threshold ${threshold} m) — ${reason}`
        );
        removals.push({ removed: victim.id, kept: survivor.id, depthM: depth });

        if (victim === building) break; // `building` is gone; stop scanning its pairs
      }
    }
    return removals;
  }

  /** Lane-change hook: footprint pushes first, then overlap removal. */
  onSegmentLanesChanged(segment, buildingManager) {
    const pushes = this.resolveForSegment(segment, buildingManager);
    const removals = this.resolveOverlaps(buildingManager);
    if (pushes.length > 0 || removals.length > 0) {
      console.log(
        `[CollisionResolver] segment "${segment.id}" lane change resolved: ` +
        `${pushes.length} building(s) pushed, ${removals.length} removed`
      );
    }
    return { pushes, removals };
  }

  _nearestFrame(footprint, position) {
    let best = null;
    let bestDistSq = Infinity;
    for (const frame of footprint.frames) {
      const dx = position.x - frame.position.x;
      const dz = position.z - frame.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        best = frame;
      }
    }
    return best;
  }

  /**
   * Removal policy: the more-recently-moved building loses; if neither was
   * ever moved, the later-added one loses.
   */
  _pickVictim(a, b) {
    if (a.moveOrder !== b.moveOrder) {
      const victim = a.moveOrder > b.moveOrder ? a : b;
      const survivor = victim === a ? b : a;
      return {
        victim,
        reason: `"${victim.id}" was pushed more recently (move order ${victim.moveOrder} vs ${survivor.moveOrder})`,
      };
    }
    const victim = a.addedOrder >= b.addedOrder ? a : b;
    const survivor = victim === a ? b : a;
    return {
      victim,
      reason: `neither was pushed — removed the later-added "${victim.id}" (add order ${victim.addedOrder} vs ${survivor.addedOrder})`,
    };
  }
}