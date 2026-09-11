import { clamp, wrapPi } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const SAFETY = ConfigDefaults.v2v.safety;
const DEG2RAD = Math.PI / 180;

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

/**
 * SafetyApplications — consumes delivered BSMs and produces alerts
 * (ICW / BSW / EEBL). Pure geometry over BSMs, so it works for every
 * vehicle regardless of LOD tier. See the Phase 10 file notes for the full
 * model description; all thresholds come from ConfigDefaults.v2v.safety.
 */
export class SafetyApplications {
    /**
     * @param {object} options
     * @param {import('../road/RoadNetwork.js').RoadNetwork} options.network
     */
    constructor({
        network,
        intersectionMinSegments = SAFETY.intersectionMinSegments,
        icwRadiusM = SAFETY.icwRadiusM,
        icwHorizonSec = SAFETY.icwHorizonSec,
        icwTimeToleranceSec = SAFETY.icwTimeToleranceSec,
        icwNodeProximityM = SAFETY.icwNodeProximityM,
        bswRadiusM = SAFETY.bswRadiusM,
        bswRearBearingRad = SAFETY.bswRearBearingDeg * DEG2RAD,
        eebRadiusM = SAFETY.eebRadiusM,
        eebBrakingThreshold = SAFETY.eebBrakingThreshold,
        eebBearingRad = SAFETY.eebBearingDeg * DEG2RAD,
        eebLateralM = SAFETY.eebLateralM,
        maxAlerts = SAFETY.maxAlerts,
    } = {}) {
        if (!network) throw new TypeError('SafetyApplications: network is required');
        this._icwRadiusM = icwRadiusM;
        this._icwHorizonSec = icwHorizonSec;
        this._icwTimeToleranceSec = icwTimeToleranceSec;
        this._icwNodeProximityM = icwNodeProximityM;
        this._bswRadiusM = bswRadiusM;
        this._bswRearBearingRad = bswRearBearingRad;
        this._eebRadiusM = eebRadiusM;
        this._eebBrakingThreshold = eebBrakingThreshold;
        this._eebBearingRad = eebBearingRad;
        this._eebLateralM = eebLateralM;
        this._maxAlerts = maxAlerts;

        // True intersections (≥3 legs) — the ICW conflict nodes.
        this._nodes = network
            .getIntersectionNodeIds()
            .filter((id) => network.getSegmentsAtNode(id).length >= intersectionMinSegments)
            .map((id) => {
                const node = network.getNode(id);
                return { id, x: node.position.x, z: node.position.z };
            });
    }

    /**
     * @param {import('../vehicles/Vehicle.js').Vehicle} vehicle receiver
     * @param {object} ownBsm receiver's own BSM
     * @param {Array<{ id, distanceM, los, bsm }>} neighbors delivered neighbors
     * @returns {Array<{ type, severity, vehicleId, distanceM, description }>}
     */
    evaluate(vehicle, ownBsm, neighbors) {
        const alerts = [];
        if (!neighbors || neighbors.length === 0) return alerts;

        const heading = ownBsm.headingRad;
        const forwardX = Math.sin(heading);
        const forwardZ = -Math.cos(heading);
        const rightX = Math.cos(heading);
        const rightZ = Math.sin(heading);
        const ownNodes = this._approachingNodes(ownBsm.position.x, ownBsm.position.z, forwardX, forwardZ);

        for (const neighbor of neighbors) {
            const bsm = neighbor.bsm;
            const distanceM = neighbor.distanceM;
            const dx = bsm.position.x - ownBsm.position.x;
            const dz = bsm.position.z - ownBsm.position.z;

            // ---- EEBL: hard braking ahead, same/adjacent lane ------------------
            if (bsm.brakingIntensity > this._eebBrakingThreshold && distanceM <= this._eebRadiusM) {
                const ahead = dx * forwardX + dz * forwardZ;
                const lateral = Math.abs(dx * rightX + dz * rightZ);
                const bearing = Math.abs(wrapPi(Math.atan2(dx, -dz) - heading));
                if (ahead > 0 && bearing < this._eebBearingRad && lateral <= this._eebLateralM) {
                    const severity = distanceM < 40 ? 'critical' : distanceM < 70 ? 'warning' : 'info';
                    alerts.push({
                        type: 'eebl',
                        severity,
                        vehicleId: bsm.vehicleId,
                        distanceM,
                        description: `Hard braking ahead: ${bsm.vehicleId} at ${Math.round(distanceM)} m (intensity ${bsm.brakingIntensity.toFixed(1)})`,
                    });
                }
            }

            // ---- BSW: NLOS vehicle in a rear quarter, close ----------------------
            if (distanceM <= this._bswRadiusM && !neighbor.los) {
                const bearingSigned = wrapPi(Math.atan2(dx, -dz) - heading);
                if (Math.abs(bearingSigned) > this._bswRearBearingRad) {
                    alerts.push({
                        type: 'bsw',
                        severity: 'warning',
                        vehicleId: bsm.vehicleId,
                        distanceM,
                        description: `Blind spot (${bearingSigned > 0 ? 'rear-right' : 'rear-left'}, NLOS): ${bsm.vehicleId} at ${Math.round(distanceM)} m`,
                    });
                }
            }

            // ---- ICW: shared approaching intersection + predicted path conflict --
            if (ownNodes.length > 0) {
                const otherForwardX = Math.sin(bsm.headingRad);
                const otherForwardZ = -Math.cos(bsm.headingRad);
                const shared = this._sharedNode(
                    ownNodes,
                    bsm.position.x,
                    bsm.position.z,
                    otherForwardX,
                    otherForwardZ
                );
                if (shared) {
                    const conflict = this._pathConflict(ownBsm, bsm);
                    if (
                        conflict &&
                        Math.hypot(conflict.x - shared.x, conflict.z - shared.z) <= this._icwNodeProximityM
                    ) {
                        const severity =
                            conflict.ttcSec < 1.5 ? 'critical' : conflict.ttcSec < 3.0 ? 'warning' : 'info';
                        alerts.push({
                            type: 'icw',
                            severity,
                            vehicleId: bsm.vehicleId,
                            distanceM,
                            description: `Intersection conflict with ${bsm.vehicleId} at ${shared.id} in ~${conflict.ttcSec.toFixed(1)} s (${Math.round(distanceM)} m away)`,
                        });
                    }
                }
            }
        }

        alerts.sort(
            (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.distanceM - b.distanceM
        );
        return alerts.slice(0, this._maxAlerts);
    }

    /** Intersection nodes within icwRadiusM that the vehicle heads toward. */
    _approachingNodes(x, z, forwardX, forwardZ) {
        const result = [];
        for (const node of this._nodes) {
            const dx = node.x - x;
            const dz = node.z - z;
            const distance = Math.hypot(dx, dz);
            if (distance > this._icwRadiusM || distance < 1e-3) continue;
            if ((dx * forwardX + dz * forwardZ) / distance > 0.2) result.push(node);
        }
        return result;
    }

    /** First node from `ownNodes` the other vehicle also approaches. */
    _sharedNode(ownNodes, ox, oz, forwardX, forwardZ) {
        const otherNodes = this._approachingNodes(ox, oz, forwardX, forwardZ);
        for (const node of ownNodes) {
            if (otherNodes.includes(node)) return node;
        }
        return null;
    }

    /**
     * Earliest predicted-path conflict: both paths extended to the ICW horizon
     * (pathPrediction + constant-velocity extrapolation), pairwise 2D segment
     * intersection, arrival times interpolated. Colinear paths never count.
     */
    _pathConflict(a, b) {
        const pathA = this._buildPath(a);
        const pathB = this._buildPath(b);
        let best = null;
        for (let i = 0; i < pathA.length - 1; i++) {
            for (let j = 0; j < pathB.length - 1; j++) {
                const crossing = this._segmentIntersection(pathA[i], pathA[i + 1], pathB[j], pathB[j + 1]);
                if (!crossing) continue;
                const tA = pathA[i].tSec + (pathA[i + 1].tSec - pathA[i].tSec) * crossing.s;
                const tB = pathB[j].tSec + (pathB[j + 1].tSec - pathB[j].tSec) * crossing.t;
                if (Math.abs(tA - tB) > this._icwTimeToleranceSec) continue;
                const ttcSec = Math.min(tA, tB);
                if (!best || ttcSec < best.ttcSec) {
                    best = { ttcSec, x: crossing.x, z: crossing.z };
                }
            }
        }
        return best;
    }

    /** [position, ...pathPrediction, extrapolation to the horizon]. */
    _buildPath(bsm) {
        const points = [
            { x: bsm.position.x, z: bsm.position.z, tSec: 0 },
            ...(bsm.pathPrediction ?? []),
        ];
        const last = points[points.length - 1];
        const speed = Math.max(0, bsm.speedMps);
        const remaining = Math.max(0, this._icwHorizonSec - (last.tSec ?? 0));
        const forwardX = Math.sin(bsm.headingRad);
        const forwardZ = -Math.cos(bsm.headingRad);
        points.push({
            x: last.x + forwardX * speed * remaining,
            z: last.z + forwardZ * speed * remaining,
            tSec: (last.tSec ?? 0) + remaining,
        });
        return points;
    }

    /** 2D segment intersection: null, or { x, z, s (on A), t (on B) }. */
    _segmentIntersection(p1, p2, p3, p4) {
        const d1x = p2.x - p1.x;
        const d1z = p2.z - p1.z;
        const d2x = p4.x - p3.x;
        const d2z = p4.z - p3.z;
        const denominator = d1x * d2z - d1z * d2x;
        if (Math.abs(denominator) < 1e-9) return null; // parallel / colinear
        const ex = p3.x - p1.x;
        const ez = p3.z - p1.z;
        const s = (ex * d2z - ez * d2x) / denominator;
        const t = (ex * d1z - ez * d1x) / denominator;
        if (s < 0 || s > 1 || t < 0 || t > 1) return null;
        return { x: p1.x + s * d1x, z: p1.z + s * d1z, s, t };
    }
}