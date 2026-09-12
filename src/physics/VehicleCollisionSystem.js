import * as THREE from 'three';
import { ConfigDefaults } from '../state/ConfigDefaults.js';
import { SplineUtils } from '../road/SplineUtils.js';

const VEHICLE_PROXY_HALF = ConfigDefaults.vehicle.vehicleProxyHalf;

/**
 * VehicleCollisionSystem — runtime collision detection and response.
 *
 * Prevents vehicles from phasing through:
 * 1. Buildings (using 2D OBB SAT against BuildingManager's spatial grid).
 * 2. Other vehicles (Ego vs NPC, NPC vs NPC).
 * 3. Road obstructions (barriers and cones).
 */
export class VehicleCollisionSystem {
  /**
   * @param {object} options
   * @param {import('../vehicles/Vehicle.js').Vehicle[]} options.vehicles
   * @param {import('../buildings/BuildingManager.js').BuildingManager} options.buildingManager
   * @param {import('../road/RoadNetwork.js').RoadNetwork} [options.network]
   */
  constructor({ vehicles, buildingManager, network = null }) {
    this.vehicles = vehicles;
    this.buildingManager = buildingManager;
    this.network = network;
  }

  /** Run collision resolution for all vehicles this tick. */
  update() {
    if (!this.vehicles || this.vehicles.length === 0) return;

    // 1. Vehicle vs Buildings
    if (this.buildingManager) {
      for (const vehicle of this.vehicles) {
        if (!vehicle || !vehicle.motionModel) continue;
        this._resolveVehicleBuilding(vehicle);
      }
    }

    // 2. Vehicle vs Vehicle (Ego vs NPC, NPC vs NPC)
    for (let i = 0; i < this.vehicles.length; i++) {
      const vA = this.vehicles[i];
      if (!vA || !vA.motionModel) continue;
      for (let j = i + 1; j < this.vehicles.length; j++) {
        const vB = this.vehicles[j];
        if (!vB || !vB.motionModel) continue;
        this._resolveVehicleVehicle(vA, vB);
      }
    }

    // 3. Vehicle vs Guardrails
    if (this.network) {
      for (const vehicle of this.vehicles) {
        if (!vehicle || !vehicle.motionModel) continue;
        this._resolveVehicleGuardrails(vehicle);
      }
    }

    // 4. Vehicle vs Obstructions
    if (this.network) {
      for (const vehicle of this.vehicles) {
        if (!vehicle || !vehicle.motionModel) continue;
        this._resolveVehicleObstructions(vehicle);
      }
    }
  }

  /**
   * Build 2D OBB from vehicle's current transform.
   * @param {import('../vehicles/Vehicle.js').Vehicle} vehicle
   */
  _getVehicleOBB(vehicle) {
    const state = vehicle.motionModel.getState();
    const heading = state.headingRad;
    const sin = Math.sin(heading);
    const cos = Math.cos(heading);

    return {
      center: { x: state.position.x, z: state.position.z },
      axisX: { x: cos, z: sin },    // right
      axisZ: { x: sin, z: -cos },   // forward
      halfW: VEHICLE_PROXY_HALF.width,
      halfL: VEHICLE_PROXY_HALF.length,
    };
  }

  /** Resolve vehicle collision against nearby buildings. */
  _resolveVehicleBuilding(vehicle) {
    const vObb = this._getVehicleOBB(vehicle);
    const radius = Math.hypot(vObb.halfW, vObb.halfL);

    // Broadphase query
    const candidates = this.buildingManager.queryAABB({
      minX: vObb.center.x - radius,
      maxX: vObb.center.x + radius,
      minZ: vObb.center.z - radius,
      maxZ: vObb.center.z + radius,
    });

    for (const building of candidates) {
      const bObb = building.getOBB();
      // Test 2D SAT between vehicle and building
      const overlap = this._testOBBOverlap(
        vObb.center,
        [vObb.axisX, vObb.axisZ],
        [vObb.halfW, vObb.halfL],
        { x: bObb.center.x, z: bObb.center.z },
        [
          { x: bObb.axisX.x, z: bObb.axisX.z },
          { x: bObb.axisZ.x, z: bObb.axisZ.z },
        ],
        [bObb.halfW, bObb.halfD]
      );

      if (overlap) {
        // Push vehicle out of building
        const state = vehicle.motionModel.getState();
        state.position.x += overlap.normal.x * (overlap.depth + 0.03);
        state.position.z += overlap.normal.z * (overlap.depth + 0.03);

        // Adjust speed if moving into the building wall
        if (state.speedMps !== undefined) {
          const fwdX = Math.sin(state.headingRad);
          const fwdZ = -Math.cos(state.headingRad);
          const dot = fwdX * overlap.normal.x + fwdZ * overlap.normal.z;
          if (dot < 0) {
            // Glancing collision or direct head-on
            if (dot < -0.6) {
              state.speedMps = -state.speedMps * 0.15; // bounce back slightly
            } else {
              state.speedMps *= 0.5; // drag along wall
            }
          }
        }

        // Apply visual transform immediately
        if (typeof vehicle._applyTransform === 'function') {
          vehicle._applyTransform(state);
        }
      }
    }
  }

  /** Resolve vehicle vs vehicle overlap. */
  _resolveVehicleVehicle(vA, vB) {
    const sA = vA.motionModel.getState();
    const sB = vB.motionModel.getState();

    const dx = sB.position.x - sA.position.x;
    const dz = sB.position.z - sA.position.z;
    const distSq = dx * dx + dz * dz;
    const maxRadius = VEHICLE_PROXY_HALF.length * 2;
    if (distSq > maxRadius * maxRadius) return;

    const obbA = this._getVehicleOBB(vA);
    const obbB = this._getVehicleOBB(vB);

    const overlap = this._testOBBOverlap(
      obbA.center,
      [obbA.axisX, obbA.axisZ],
      [obbA.halfW, obbA.halfL],
      obbB.center,
      [obbB.axisX, obbB.axisZ],
      [obbB.halfW, obbB.halfL]
    );

    if (overlap) {
      // Push each vehicle apart by half the depth
      const push = (overlap.depth + 0.02) * 0.5;
      sA.position.x += overlap.normal.x * push;
      sA.position.z += overlap.normal.z * push;
      sB.position.x -= overlap.normal.x * push;
      sB.position.z -= overlap.normal.z * push;

      // Transfer momentum / slow down both
      if (sA.speedMps !== undefined && sB.speedMps !== undefined) {
        const avg = (sA.speedMps + sB.speedMps) * 0.4;
        sA.speedMps = avg;
        sB.speedMps = avg;
      }

      if (typeof vA._applyTransform === 'function') vA._applyTransform(sA);
      if (typeof vB._applyTransform === 'function') vB._applyTransform(sB);
    }
  }

  /** Resolve vehicle collision against steel guardrails along road edges. */
  _resolveVehicleGuardrails(vehicle) {
    const state = vehicle.motionModel.getState();
    const vPos = state.position;
    const vHalfW = VEHICLE_PROXY_HALF.width;

    for (const segment of this.network.segments.values()) {
      const mode = segment.guardRails ?? 'none';
      if (mode === 'none') continue;

      const curve = segment.getCurve();
      const length = segment.lengthM;
      if (length < 1.0) continue;

      // Quick broadphase check around segment midpoint
      const mid = curve.getPointAt(0.5);
      const approxRadius = length * 0.6 + segment.roadWidthM + 4.0;
      if (Math.hypot(vPos.x - mid.x, vPos.z - mid.z) > approxRadius) continue;

      // Find nearest parameter t on curve
      const samples = Math.max(8, Math.ceil(length / 4));
      let bestDistSq = Infinity;
      let bestT = 0;
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const pt = curve.getPointAt(t);
        const dSq = (vPos.x - pt.x) ** 2 + (vPos.z - pt.z) ** 2;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestT = t;
        }
      }

      // Local refinement
      const dt = 1.0 / samples;
      let tMin = Math.max(0, bestT - dt);
      let tMax = Math.min(1, bestT + dt);
      for (let step = 0; step < 4; step++) {
        const t1 = tMin + (tMax - tMin) * 0.33;
        const t2 = tMin + (tMax - tMin) * 0.67;
        const p1 = curve.getPointAt(t1);
        const p2 = curve.getPointAt(t2);
        const d1 = (vPos.x - p1.x) ** 2 + (vPos.z - p1.z) ** 2;
        const d2 = (vPos.x - p2.x) ** 2 + (vPos.z - p2.z) ** 2;
        if (d1 < d2) tMax = t2;
        else tMin = t1;
      }
      const u = (tMin + tMax) * 0.5;
      const frame = SplineUtils.computeFrame(curve, u);

      // Lateral offset from centerline to vehicle position
      const dx = vPos.x - frame.position.x;
      const dz = vPos.z - frame.position.z;
      const lateral = dx * frame.right.x + dz * frame.right.z;

      // Right guardrail collision
      if (mode === 'both' || mode === 'right') {
        const limitRight = segment.halfWidthForwardM + 0.25;
        const vehicleRightEdge = lateral + vHalfW;
        if (vehicleRightEdge > limitRight && lateral > 0 && Math.abs(lateral) < limitRight + 3.5) {
          const penetration = vehicleRightEdge - limitRight;
          state.position.x -= frame.right.x * (penetration + 0.05);
          state.position.z -= frame.right.z * (penetration + 0.05);

          if (state.speedMps !== undefined) {
            state.speedMps *= 0.85; // rail scraping friction
          }
          if (typeof vehicle._applyTransform === 'function') {
            vehicle._applyTransform(state);
          }
        }
      }

      // Left guardrail collision
      if (mode === 'both' || mode === 'left') {
        const limitLeft = -(segment.halfWidthBackwardM + 0.25);
        const vehicleLeftEdge = lateral - vHalfW;
        if (vehicleLeftEdge < limitLeft && lateral < 0 && Math.abs(lateral) < Math.abs(limitLeft) + 3.5) {
          const penetration = limitLeft - vehicleLeftEdge;
          state.position.x += frame.right.x * (penetration + 0.05);
          state.position.z += frame.right.z * (penetration + 0.05);

          if (state.speedMps !== undefined) {
            state.speedMps *= 0.85; // rail scraping friction
          }
          if (typeof vehicle._applyTransform === 'function') {
            vehicle._applyTransform(state);
          }
        }
      }
    }
  }

  /** Resolve vehicle against lane obstacles (cones / barriers). */
  _resolveVehicleObstructions(vehicle) {
    const state = vehicle.motionModel.getState();
    for (const segment of this.network.segments.values()) {
      if (!segment.obstructions || segment.obstructions.length === 0) continue;
      for (const obs of segment.obstructions) {
        const ox = obs.mesh.position.x;
        const oz = obs.mesh.position.z;
        const dist = Math.hypot(state.position.x - ox, state.position.z - oz);
        const radius = obs.blocking === 'full' ? 2.2 : 1.0;
        if (dist < radius) {
          const depth = radius - dist;
          const nx = dist > 1e-4 ? (state.position.x - ox) / dist : 1;
          const nz = dist > 1e-4 ? (state.position.z - oz) / dist : 0;
          state.position.x += nx * (depth + 0.05);
          state.position.z += nz * (depth + 0.05);
          if (state.speedMps !== undefined && state.speedMps > 0) {
            state.speedMps = -state.speedMps * 0.2;
          }
          if (typeof vehicle._applyTransform === 'function') {
            vehicle._applyTransform(state);
          }
        }
      }
    }
  }

  /**
   * 2D SAT overlap test between two oriented boxes.
   * Returns { normal: {x, z}, depth } pointing from B to A, or null if separated.
   */
  _testOBBOverlap(centerA, axesA, halfA, centerB, axesB, halfB) {
    const dx = centerA.x - centerB.x;
    const dz = centerA.z - centerB.z;

    const testAxes = [axesA[0], axesA[1], axesB[0], axesB[1]];
    let minDepth = Infinity;
    let minNormal = null;

    for (const axis of testAxes) {
      const nx = axis.x;
      const nz = axis.z;

      // Project Box A
      const extentA =
        halfA[0] * Math.abs(axesA[0].x * nx + axesA[0].z * nz) +
        halfA[1] * Math.abs(axesA[1].x * nx + axesA[1].z * nz);

      // Project Box B
      const extentB =
        halfB[0] * Math.abs(axesB[0].x * nx + axesB[0].z * nz) +
        halfB[1] * Math.abs(axesB[1].x * nx + axesB[1].z * nz);

      const distance = Math.abs(dx * nx + dz * nz);
      const depth = extentA + extentB - distance;

      if (depth <= 0) return null; // Separated on this axis

      if (depth < minDepth) {
        minDepth = depth;
        // Direction from B to A
        const sign = (dx * nx + dz * nz) >= 0 ? 1 : -1;
        minNormal = { x: nx * sign, z: nz * sign };
      }
    }

    return { normal: minNormal, depth: minDepth };
  }
}
