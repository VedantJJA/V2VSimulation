import * as THREE from 'three';

/**
 * Building — a box footprint on the ground, rotatable around Y.
 *
 * Data: { id, position (ground point), size: [w, d, h], rotationY }.
 * The mesh is a plain BoxGeometry standing on position.y; rendering details
 * (windows, roofs, instancing) are later-phase upgrades.
 *
 * Collision support:
 * - getOBB(): oriented bounding box of the XZ footprint. All buildings sit
 *   on the ground, so 2D XZ overlap implies 3D overlap — heights are carried
 *   for future use, not tested.
 * - getAABB(): axis-aligned XZ bounds — the broadphase shape handed to
 *   SpatialGrid via BuildingManager.
 *
 * Mutating positions must go through BuildingManager.moveBuilding (or
 * translate() + manager re-stamp): the broadphase and recency stamps live
 * in the manager, not here.
 */
export class Building {
  /**
   * @param {object} options
   * @param {string} options.id
   * @param {THREE.Vector3 | number[]} options.position ground point
   * @param {[number, number, number]} options.size [width, depth, height] in meters
   * @param {number} [options.rotationY]
   * @param {THREE.Material} [options.material] shared material from BuildingManager
   */
  constructor({ id, position, size, rotationY = 0, material = null }) {
    if (!id) throw new TypeError('Building: id is required');
    const [width, depth, height] = size;
    if (!(width > 0) || !(depth > 0) || !(height > 0)) {
      throw new RangeError('Building: size must be [w, d, h] with all values > 0');
    }

    this.id = id;
    this.position = position.isVector3
      ? position.clone()
      : new THREE.Vector3(position[0], position[1] ?? 0, position[2] ?? 0);
    this.size = [width, depth, height];
    this.rotationY = rotationY;

    // Recency stamps — maintained by BuildingManager, read by
    // CollisionResolver to pick the "more recently moved" victim.
    this.addedOrder = 0;
    this.moveOrder = 0;

    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    this.mesh.name = `building:${id}`;
    this.mesh.position.set(this.position.x, this.position.y + height / 2, this.position.z);
    this.mesh.rotation.y = rotationY;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    this._obb = null;
    this._aabb = null;
  }

  /**
   * Translate in the XZ plane (mesh follows, OBB/AABB caches invalidate).
   * Prefer BuildingManager.moveBuilding, which also refreshes the
   * SpatialGrid and stamps recency.
   */
  translate(dx, dz) {
    this.position.x += dx;
    this.position.z += dz;
    this.mesh.position.x += dx;
    this.mesh.position.z += dz;
    this._obb = null;
    this._aabb = null;
  }

  /**
   * OBB for overlap tests (cached until moved):
   * { center: Vector3, axisX: Vector3, axisZ: Vector3 (unit), halfW, halfD, height }
   * axisX/axisZ are the local +X/+Z axes rotated by rotationY (three's
   * Y-rotation convention: +X → (cos, 0, −sin), +Z → (sin, 0, cos)).
   */
  getOBB() {
    if (!this._obb) {
      const cos = Math.cos(this.rotationY);
      const sin = Math.sin(this.rotationY);
      this._obb = {
        center: new THREE.Vector3(this.position.x, this.position.y, this.position.z),
        axisX: new THREE.Vector3(cos, 0, -sin),
        axisZ: new THREE.Vector3(sin, 0, cos),
        halfW: this.size[0] / 2,
        halfD: this.size[1] / 2,
        height: this.size[2],
      };
    }
    return this._obb;
  }

  /** Axis-aligned XZ bounds { minX, minZ, maxX, maxZ } (cached until moved). */
  getAABB() {
    if (this._aabb) return this._aabb;
    const obb = this.getOBB();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x = obb.center.x + sx * obb.halfW * obb.axisX.x + sz * obb.halfD * obb.axisZ.x;
        const z = obb.center.z + sx * obb.halfW * obb.axisX.z + sz * obb.halfD * obb.axisZ.z;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    this._aabb = { minX, minZ, maxX, maxZ };
    return this._aabb;
  }

  /** Half diagonal of the XZ footprint — worst-case broadphase expansion. */
  get halfDiagonalM() {
    return Math.hypot(this.size[0], this.size[1]) / 2;
  }
}