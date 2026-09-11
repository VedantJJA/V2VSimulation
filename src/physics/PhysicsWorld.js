import * as CANNON from 'cannon-es';
import { ConfigDefaults } from '../state/ConfigDefaults.js';
import { DEFAULT_Y } from '../utils/Constants.js';

const PHYSICS = ConfigDefaults.physics;

/**
 * PhysicsWorld — owns the CANNON.World and steps it at a fixed rate
 * (accumulator, capped substeps; the Engine clamps dt). Contains an
 * infinite static ground plane at `groundY` (DEFAULT_Y — road surfaces are
 * roadSurfaceYM above it). Static bodies for buildings/roads arrive with
 * the terrain phase.
 */
export class PhysicsWorld {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {object} [options]
   * @param {number} [options.gravityY]
   * @param {number} [options.fixedStepSec]
   * @param {number} [options.maxSubSteps]
   * @param {number} [options.groundY] height of the infinite ground plane
   */
  constructor(
    engine,
    {
      gravityY = PHYSICS.gravityY,
      fixedStepSec = PHYSICS.fixedStepSec,
      maxSubSteps = PHYSICS.maxSubSteps,
      groundY = DEFAULT_Y,
    } = {}
  ) {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, gravityY, 0) });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.defaultContactMaterial.friction = PHYSICS.contactFriction;

    this.fixedStepSec = fixedStepSec;
    this.maxSubSteps = maxSubSteps;
    this._accumulator = 0;

    // Static infinite ground plane (normal +Y after rotating −90° about X).
    this._groundBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
    this._groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
    this._groundBody.position.set(0, groundY, 0);
    this.world.addBody(this._groundBody);

    // Registered FIRST among the Phase-4 systems (see main.js ordering note).
    this._unsubscribeUpdate = engine.addUpdate((dt) => this.update(dt));
  }

  /** Advance the accumulator and run fixed substeps. */
  update(dt) {
    this._accumulator += dt;
    let steps = 0;
    while (this._accumulator >= this.fixedStepSec && steps < this.maxSubSteps) {
      this.world.step(this.fixedStepSec);
      this._accumulator -= this.fixedStepSec;
      steps += 1;
    }
    if (steps === this.maxSubSteps) {
      this._accumulator = 0; // shed backlog after a long stall
    }
  }

  addBody(body) {
    this.world.addBody(body);
    return body;
  }

  removeBody(body) {
    this.world.removeBody(body);
    return body;
  }

  /** Unregister from the loop and drop all bodies. */
  dispose() {
    this._unsubscribeUpdate();
    this._unsubscribeUpdate = null;
    for (const body of [...this.world.bodies]) this.world.removeBody(body);
  }
}