/**
 * Terrain — procedural ground geometry.
 *
 * NOT IMPLEMENTED — future. The flat Phase-0 ground plane (SceneManager's
 * placeholder) is still the driving surface. This module survives Phase
 * 11's stub cleanup because procedural terrain is a genuine planned
 * feature; until it lands, it exposes honest flat-world behavior so
 * callers can integrate against the final API early.
 *
 * Planned responsibilities (from the Phase 0 design):
 * - Noise-displaced heightfield mesh, chunked when needed.
 * - A three-mesh-bvh over the geometry for ray casts and collision.
 * - Replaces the flat ground and supplies PhysicsWorld ground bodies.
 *
 * @module world/Terrain
 */

export const TERRAIN_STATUS = 'NOT IMPLEMENTED — future (flat ground active)';

export class Terrain {
  constructor() {
    /** Flat world until procedural generation lands. */
    this.isImplemented = false;
  }

  /** Ground height at (x, z) — 0 everywhere while flat. */
  heightAt(x, z) {
    return 0;
  }

  /** Ground normal at (x, z) — straight up while flat. */
  normalAt(x, z) {
    return { x: 0, y: 1, z: 0 };
  }
}
