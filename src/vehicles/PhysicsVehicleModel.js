import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { clamp } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const PHYSICS = ConfigDefaults.vehicle.physics;
const WHEELS = PHYSICS.wheel;
const CHASSIS = PHYSICS.chassisHalf;

const WHEEL_INDICES = { FRONT_LEFT: 0, FRONT_RIGHT: 1, REAR_LEFT: 2, REAR_RIGHT: 3 };

/**
 * PhysicsVehicleModel — cannon-es RaycastVehicle fulfilling
 * IVehicleMotionModel. Chassis local axes: +Z forward, +X right, +Y up.
 * Positive engine force drives forward; positive steering turns right.
 * update(dt, input) writes controls (persisted until overwritten) and
 * returns the freshest post-step state; integration happens inside
 * PhysicsWorld's fixed-timestep loop. Heading bridge: world +Z of the
 * chassis → compass yaw via atan2(F.x, −F.z).
 */
export class PhysicsVehicleModel {
  /**
   * @param {object} options
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} options.physicsWorld
   * @param {THREE.Vector3 | number[]} [options.position] spawn (small drop onto the suspension)
   * @param {number} [options.headingRad]
   */
  constructor({
    physicsWorld,
    position = [0, ConfigDefaults.vehicle.physicsSpawnHeightM, 0],
    headingRad = 0,
    massKg = PHYSICS.massKg,
    maxEngineForceN = PHYSICS.maxEngineForceN,
    brakeForcePerWheelN = PHYSICS.brakeForcePerWheelN,
    maxSteerRad = PHYSICS.maxSteerRad,
    steerSpeedFactor = PHYSICS.steerSpeedFactor,
  } = {}) {
    if (!physicsWorld || !physicsWorld.world) {
      throw new TypeError('PhysicsVehicleModel: physicsWorld is required');
    }
    this._world = physicsWorld;
    this._maxEngineForceN = maxEngineForceN;
    this._brakeForcePerWheelN = brakeForcePerWheelN;
    this._maxSteerRad = maxSteerRad;
    this._steerSpeedFactor = steerSpeedFactor;

    this._chassisBody = new CANNON.Body({
      mass: massKg,
      shape: new CANNON.Box(new CANNON.Vec3(CHASSIS.x, CHASSIS.y, CHASSIS.z)),
    });
    this._chassisBody.position.set(
      position.isVector3 ? position.x : position[0],
      position.isVector3 ? position.y : (position[1] ?? ConfigDefaults.vehicle.physicsSpawnHeightM),
      position.isVector3 ? position.z : (position[2] ?? 0)
    );
    // Chassis +Z forward ⇒ world yaw = π − headingRad (heading convention doc).
    this._chassisBody.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.PI - headingRad);
    this._chassisBody.angularDamping = PHYSICS.angularDamping;
    this._chassisBody.linearDamping = PHYSICS.linearDamping;
    this._chassisBody.allowSleep = false;

    this._vehicle = new CANNON.RaycastVehicle({
      chassisBody: this._chassisBody,
      indexRightAxis: 0, // +X
      indexUpAxis: 1,    // +Y
      indexForwardAxis: 2, // +Z
    });

    for (const [x, z] of [
      [WHEELS.trackXM, WHEELS.frontZM],
      [-WHEELS.trackXM, WHEELS.frontZM],
      [WHEELS.trackXM, WHEELS.rearZM],
      [-WHEELS.trackXM, WHEELS.rearZM],
    ]) {
      this._vehicle.addWheel({
        radius: WHEELS.radiusM,
        directionLocal: new CANNON.Vec3(0, -1, 0),
        axleLocal: new CANNON.Vec3(1, 0, 0),
        suspensionStiffness: WHEELS.suspensionStiffness,
        suspensionRestLength: WHEELS.suspensionRestLengthM,
        maxSuspensionTravel: WHEELS.maxSuspensionTravelM,
        maxSuspensionForce: WHEELS.maxSuspensionForce,
        dampingRelaxation: WHEELS.dampingRelaxation,
        dampingCompression: WHEELS.dampingCompression,
        frictionSlip: WHEELS.frictionSlip,
        rollInfluence: WHEELS.rollInfluence,
        customSlidingRotationalSpeed: WHEELS.customSlidingRotationalSpeed,
        useCustomSlidingRotationalSpeed: true,
        chassisConnectionPointLocal: new CANNON.Vec3(x, 0, z),
      });
    }

    // Registers the per-substep update with the world.
    this._vehicle.addToWorld(this._world.world);

    this._forwardLocal = new CANNON.Vec3(0, 0, 1);
    this._forwardWorld = new CANNON.Vec3();
    this._state = {
      position: new THREE.Vector3(
        this._chassisBody.position.x,
        this._chassisBody.position.y,
        this._chassisBody.position.z
      ),
      headingRad,
      speedMps: 0,
    };
  }

  getState() {
    return this._state;
  }

  update(dt, input = {}) {
    // All three controls are (re)written every tick, so stale values from a
    // released key can never linger.
    const steerScale = 1 / (1 + Math.abs(this._state.speedMps) * this._steerSpeedFactor);
    const steer = clamp(input.steering ?? 0, -1, 1) * this._maxSteerRad * steerScale;
    this._vehicle.setSteeringValue(steer, WHEEL_INDICES.FRONT_LEFT);
    this._vehicle.setSteeringValue(steer, WHEEL_INDICES.FRONT_RIGHT);

    const engine = clamp(input.throttle ?? 0, -1, 1) * this._maxEngineForceN;
    this._vehicle.applyEngineForce(engine, WHEEL_INDICES.REAR_LEFT);
    this._vehicle.applyEngineForce(engine, WHEEL_INDICES.REAR_RIGHT);

    const brake = clamp(input.brake ?? 0, 0, 1) * this._brakeForcePerWheelN;
    for (let i = 0; i < 4; i++) this._vehicle.setBrake(brake, i);

    this._readState();
    return this._state;
  }

  /** Pull position / heading / signed speed from the chassis body. */
  _readState() {
    const body = this._chassisBody;
    this._state.position.set(body.position.x, body.position.y, body.position.z);

    body.quaternion.vmult(this._forwardLocal, this._forwardWorld); // world +Z of chassis
    const f = this._forwardWorld;
    this._state.headingRad = Math.atan2(f.x, -f.z); // compass bridge
    this._state.speedMps = body.velocity.x * f.x + body.velocity.y * f.y + body.velocity.z * f.z;
  }

  /** Detach from the world (also removes the chassis body). */
  dispose() {
    this._vehicle.removeFromWorld(this._world.world);
    this._vehicle = null;
    this._chassisBody = null;
    this._world = null;
  }
}