/**
 * MathUtils — small, dependency-free math + input helpers.
 * (Renamed from utils/helpers.js in Phase 11; the API is unchanged.)
 */

/** Clamp value into [min, max]. */
export function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
}

/** Linear interpolation. */
export function lerp(a, b, t) {
    return a + (b - a) * t;
}

/**
 * Frame-rate-independent exponential damping: approaches `target` at rate
 * `lambda` per second. damp(x, target, 0, dt) === x.
 */
export function damp(current, target, lambda, dt) {
    return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Wrap an angle in radians into (−π, π]. */
export function wrapPi(angle) {
    const TAU = Math.PI * 2;
    return ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

/**
 * True when a keyboard event targets a text field or anything inside the
 * lil-gui panel — key handlers (vehicle controls, camera toggle) should
 * ignore such events so typing never drives the game.
 */
export function isTypingTarget(event) {
    const target = event.target;
    if (!target) return false;
    if (target.tagName === 'TEXTAREA' || target.isContentEditable) return true;
    if (target.tagName === 'INPUT') {
        const type = (target.type || '').toLowerCase();
        if (type === 'text' || type === 'search' || type === 'password' || type === 'email') {
            return true;
        }
    }
    return false;
}

/**
 * Deterministic seeded PRNG (mulberry32) — stable traffic scatter and
 * reproducible noise across reloads.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}