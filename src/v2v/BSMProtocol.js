import { clamp, wrapPi } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const BSM = ConfigDefaults.v2v.bsm;

/** Allowed turn-signal values (SAE J2735-inspired, simplified). */
export const TURN_SIGNALS = ['none', 'left', 'right'];

/**
 * BSMProtocol — Basic Safety Message, inspired by SAE J2735 (simplified).
 *
 * encode() runs for EVERY vehicle each tick (pure math, no raycasts) —
 * V2V broadcast is decoupled from the sensor LOD tiers. decode() validates
 * and returns a sanitized copy (or null) — receivers only consume decoded
 * BSMs. All parameters come from ConfigDefaults.v2v.bsm.
 */
export class BSMProtocol {
    static encode(vehicle, motionState, options = {}) {
        const {
            timestampSec = 0,
            dt = 1 / 60,
            lastControlInput = null,
            previousState = null,
            pathPoints = BSM.pathPoints,
            pathIntervalSec = BSM.pathIntervalSec,
        } = options;

        const speed = motionState.speedMps ?? 0;
        const headingRad = motionState.headingRad ?? 0;

        // Finite-difference dynamics (guarded against tiny dt).
        let acceleration = 0;
        let yawRate = 0;
        if (previousState && dt > 1e-3) {
            acceleration = clamp((speed - previousState.speedMps) / dt, -BSM.maxAccelMps2, BSM.maxAccelMps2);
            yawRate = clamp(wrapPi(headingRad - previousState.headingRad) / dt, -BSM.maxYawRateRadS, BSM.maxYawRateRadS);
        }

        // Braking: max of the explicit brake input and observed deceleration.
        const inputBrake = clamp(lastControlInput?.brake ?? 0, 0, 1);
        const decelBrake = acceleration < 0 ? clamp(-acceleration / BSM.brakingDecelScaleMps2, 0, 1) : 0;
        const brakingIntensity = clamp(Math.max(inputBrake, decelBrake), 0, 1);
        const braking = brakingIntensity > 0.05;

        const steering = clamp(lastControlInput?.steering ?? 0, -1, 1);
        const turnSignal =
            steering < -BSM.turnSignalSteering ? 'left' : steering > BSM.turnSignalSteering ? 'right' : 'none';

        return {
            vehicleId: vehicle.id,
            timestampSec,
            position: {
                x: motionState.position.x,
                y: motionState.position.y,
                z: motionState.position.z,
            },
            headingRad,
            speedMps: clamp(speed, -BSM.maxSpeedMps, BSM.maxSpeedMps),
            acceleration,
            yawRate,
            braking,
            brakingIntensity,
            turnSignal,
            vehicleSize: { lengthM: BSM.lengthM, widthM: BSM.widthM },
            pathPrediction: predictPath(
                motionState.position,
                headingRad,
                speed,
                steering,
                pathPoints,
                pathIntervalSec
            ),
        };
    }

    /**
     * Validate a received BSM: returns a sanitized COPY, or null when the
     * message is fundamentally malformed (missing id/position/speed).
     */
    static decode(bsm) {
        if (!bsm || typeof bsm !== 'object') return null;
        if (typeof bsm.vehicleId !== 'string' || bsm.vehicleId.length === 0) return null;
        const position = bsm.position;
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return null;
        if (!Number.isFinite(Number(bsm.speedMps))) return null;

        const headingRad = Number(bsm.headingRad);
        const pathPrediction = Array.isArray(bsm.pathPrediction)
            ? bsm.pathPrediction
                .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.z))
                .slice(0, BSM.maxPathPoints)
                .map((p) => ({
                    x: p.x,
                    z: p.z,
                    tSec: Number.isFinite(p.tSec) ? p.tSec : 0,
                }))
            : [];

        const size = bsm.vehicleSize ?? {};
        return {
            vehicleId: bsm.vehicleId,
            timestampSec: Number.isFinite(bsm.timestampSec) ? bsm.timestampSec : 0,
            position: {
                x: position.x,
                y: Number.isFinite(position.y) ? position.y : 0,
                z: position.z,
            },
            headingRad: Number.isFinite(headingRad) ? wrapPi(headingRad) : 0,
            speedMps: clamp(Number(bsm.speedMps), -BSM.maxSpeedMps, BSM.maxSpeedMps),
            acceleration: clamp(Number(bsm.acceleration) || 0, -BSM.maxAccelMps2, BSM.maxAccelMps2),
            yawRate: clamp(Number(bsm.yawRate) || 0, -BSM.maxYawRateRadS, BSM.maxYawRateRadS),
            braking: !!bsm.braking,
            brakingIntensity: clamp(Number(bsm.brakingIntensity) || 0, 0, 1),
            turnSignal: TURN_SIGNALS.includes(bsm.turnSignal) ? bsm.turnSignal : 'none',
            vehicleSize: {
                lengthM: clamp(Number(size.lengthM) || BSM.lengthM, 1, 20),
                widthM: clamp(Number(size.widthM) || BSM.widthM, 1, 10),
            },
            pathPrediction,
        };
    }
}

/** Bicycle-integrated future positions at fixed intervals (substepped). */
function predictPath(position, headingRad, speed, steering, points, intervalSec) {
    const steerAngle = steering * BSM.steerLockRad;
    const substepsPerPoint = Math.max(1, Math.round(intervalSec / BSM.substepSec));
    const result = [];
    let x = position.x;
    let z = position.z;
    let h = headingRad;
    for (let p = 1; p <= points; p++) {
        for (let s = 0; s < substepsPerPoint; s++) {
            h += (speed / BSM.wheelbaseM) * Math.tan(steerAngle) * BSM.substepSec;
            x += Math.sin(h) * speed * BSM.substepSec;
            z += -Math.cos(h) * speed * BSM.substepSec;
        }
        result.push({ x, z, tSec: p * intervalSec });
    }
    return result;
}