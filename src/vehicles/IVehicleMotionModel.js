/**
 * IVehicleMotionModel — the contract every vehicle motion model fulfils.
 * (JSDoc-only interface; there is no runtime code in this module.)
 *
 * @typedef {Object} VehicleControlInput
 * @property {number} throttle  -1..1 — engine command; negative = reverse.
 * @property {number} steering  -1..1 — normalized steering; +1 = full RIGHT lock,
 *                       -1 = full left lock (matches the compass-heading
 *                       convention: positive steering increases headingRad).
 * @property {number} brake     0..1  — 1 = locked wheels / full braking.
 *
 * @typedef {Object} VehicleMotionState
 * @property {import('three').Vector3} position chassis-center position
 *                      (y = ride height above the driving surface).
 * @property {number} headingRad compass yaw: 0 = −Z, positive = clockwise
 *                      (right) seen from above. forward = (sin h, 0, −cos h).
 * @property {number} speedMps   signed forward speed (negative = reversing).
 *
 * @typedef {Object} IVehicleMotionModel
 * @property {(dt: number, input: VehicleControlInput) => VehicleMotionState} update
 *           Advances the simulation by dt, applies the control input, and
 *           returns the (stable-reference) motion state. Implementations may
 *           defer actual integration to an external system (e.g. a physics
 *           world stepping at a fixed rate) — update() must still return the
 *           freshest available state.
 * @property {() => VehicleMotionState} getState current state without stepping.
 * @property {() => void} [dispose] release external resources (physics bodies).
 *
 * Implementations: KinematicBicycleModel (NPCs / arcade ego),
 * PhysicsVehicleModel (cannon-es raycast vehicle, default for the ego).
 *
 * Rendering contract (handled by Vehicle): meshes are modelled facing −Z and
 * placed with mesh.position = state.position, mesh.rotation.y = −headingRad.
 *
 * @module vehicles/IVehicleMotionModel
 */

export {};  