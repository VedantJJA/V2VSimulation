import * as THREE from 'three';
import { SplineUtils } from '../road/SplineUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const BUILDINGS = ConfigDefaults.buildings;
const BUILDING_COLORS = [0x8f8a80, 0xa39a86, 0x6e7c88, 0x9c6f5f, 0x7c8570];

/**
 * Building — a box footprint on the ground, rotatable around Y.
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
    if (!id) id = `b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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

    this.addedOrder = 0;
    this.moveOrder = 0;

    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    this.mesh.name = `building:${id}`;
    this.mesh.position.set(this.position.x, this.position.y + height / 2, this.position.z);
    this.mesh.rotation.y = rotationY;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.userData.building = this;

    this._obb = null;
    this._aabb = null;
  }

  translate(dx, dz) {
    this.position.x += dx;
    this.position.z += dz;
    this.mesh.position.x += dx;
    this.mesh.position.z += dz;
    this._obb = null;
    this._aabb = null;
  }

  setPosition(x, z) {
    this.position.x = x;
    this.position.z = z;
    this.mesh.position.set(x, this.position.y + this.size[2] / 2, z);
    this._obb = null;
    this._aabb = null;
  }

  setRotationY(rotationY) {
    this.rotationY = rotationY;
    this.mesh.rotation.y = rotationY;
    this._obb = null;
    this._aabb = null;
  }

  setSize(size) {
    const [w, d, h] = size;
    if (!(w > 0) || !(d > 0) || !(h > 0)) return;
    this.size = [w, d, h];
    if (this.mesh.geometry) this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.BoxGeometry(w, h, d);
    this.mesh.scale.set(1, 1, 1);
    this.mesh.position.y = this.position.y + h / 2;
    this._obb = null;
    this._aabb = null;
  }

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

  get halfDiagonalM() {
    return Math.hypot(this.size[0], this.size[1]) / 2;
  }
}

/**
 * SpatialGrid — generic uniform XZ broadphase grid.
 */
export class SpatialGrid {
  /**
   * @param {object} options
   * @param {number} [options.cellSize] cell edge in meters (default 20)
   * @param {(item: any) => { minX: number, minZ: number, maxX: number, maxZ: number }} options.getBounds
   */
  constructor({ cellSize = 20, getBounds } = {}) {
    if (typeof getBounds !== 'function') {
      throw new TypeError('SpatialGrid: getBounds(item) => { minX, minZ, maxX, maxZ } is required');
    }
    if (!(cellSize > 0)) throw new RangeError('SpatialGrid: cellSize must be > 0');

    this.cellSize = cellSize;
    this._getBounds = getBounds;
    this._cells = new Map();
    this._itemInfo = new Map();
  }

  get count() {
    return this._itemInfo.size;
  }

  insert(item) {
    if (this._itemInfo.has(item)) {
      throw new Error('SpatialGrid.insert: item already inserted — use update()');
    }
    const bounds = this._getBounds(item) ?? {};
    const { minX, minZ, maxX, maxZ } = bounds;
    if (![minX, minZ, maxX, maxZ].every(Number.isFinite)) {
      throw new TypeError('SpatialGrid.insert: getBounds must return finite { minX, minZ, maxX, maxZ }');
    }

    const cells = this._cellKeys(minX, minZ, maxX, maxZ);
    for (const key of cells) {
      let set = this._cells.get(key);
      if (!set) {
        set = new Set();
        this._cells.set(key, set);
      }
      set.add(item);
    }
    this._itemInfo.set(item, { cells, bounds });
    return this;
  }

  remove(item) {
    const info = this._itemInfo.get(item);
    if (!info) return false;
    for (const key of info.cells) {
      const set = this._cells.get(key);
      if (!set) continue;
      set.delete(item);
      if (set.size === 0) this._cells.delete(key);
    }
    this._itemInfo.delete(item);
    return true;
  }

  update(item) {
    if (!this._itemInfo.has(item)) return this.insert(item);
    this.remove(item);
    return this.insert(item);
  }

  has(item) {
    return this._itemInfo.has(item);
  }

  queryAABB({ minX, minZ, maxX, maxZ }) {
    const result = [];
    for (const item of this._candidates(minX, minZ, maxX, maxZ)) {
      const b = this._itemInfo.get(item).bounds;
      if (b.maxX >= minX && b.minX <= maxX && b.maxZ >= minZ && b.minZ <= maxZ) {
        result.push(item);
      }
    }
    return result;
  }

  queryRadius(center, radius) {
    const x = center.x;
    const z = center.z;
    const radiusSq = radius * radius;
    const result = [];
    for (const item of this._candidates(x - radius, z - radius, x + radius, z + radius)) {
      const b = this._itemInfo.get(item).bounds;
      const cx = Math.max(b.minX, Math.min(x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz <= radiusSq) result.push(item);
    }
    return result;
  }

  clear() {
    this._cells.clear();
    this._itemInfo.clear();
  }

  _candidates(minX, minZ, maxX, maxZ) {
    const candidates = new Set();
    const cs = this.cellSize;
    const cx0 = Math.floor(minX / cs);
    const cx1 = Math.floor(maxX / cs);
    const cz0 = Math.floor(minZ / cs);
    const cz1 = Math.floor(maxZ / cs);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const set = this._cells.get(`${cx},${cz}`);
        if (set) {
          for (const item of set) candidates.add(item);
        }
      }
    }
    return candidates;
  }

  _cellKeys(minX, minZ, maxX, maxZ) {
    const cs = this.cellSize;
    const keys = [];
    for (let cx = Math.floor(minX / cs); cx <= Math.floor(maxX / cs); cx++) {
      for (let cz = Math.floor(minZ / cs); cz <= Math.floor(maxZ / cs); cz++) {
        keys.push(`${cx},${cz}`);
      }
    }
    return keys;
  }
}

/**
 * CollisionResolver — keeps buildings out of road corridors and apart from each other.
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
      if (overlap <= 0) return 0;
      if (overlap < minOverlap) minOverlap = overlap;
    }
    return minOverlap;
  }

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

  resolveForSegment(segment, buildingManager) {
    const footprint = this.computeRoadFootprint(segment);
    const margin = this.marginM;
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

      const vx = building.position.x - frame.position.x;
      const vz = building.position.z - frame.position.z;
      const distance = Math.hypot(vx, vz);
      let ux, uz;
      if (distance < 1e-4) {
        ux = frame.right.x;
        uz = frame.right.z;
      } else {
        ux = vx / distance;
        uz = vz / distance;
      }

      const side = vx * frame.right.x + vz * frame.right.z;
      const halfWidth = side >= 0 ? footprint.halfWidthRightM : footprint.halfWidthLeftM;

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

  resolveOverlaps(buildingManager) {
    const threshold = this.buildingOverlapThresholdM;
    const removals = [];
    const snapshot = buildingManager.getAll();
    const expansion = buildingManager.maxHalfDiagonalM + threshold;

    for (const building of snapshot) {
      if (!buildingManager.has(building)) continue;
      const aabb = building.getAABB();
      const neighbors = buildingManager.queryAABB({
        minX: aabb.minX - expansion,
        minZ: aabb.minZ - expansion,
        maxX: aabb.maxX + expansion,
        maxZ: aabb.maxZ + expansion,
      });

      for (const other of neighbors) {
        if (other === building) continue;
        if (other.id <= building.id) continue;
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

        if (victim === building) break;
      }
    }
    return removals;
  }

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

/**
 * BuildingManager — owns all Building instances and their meshes.
 */
export class BuildingManager {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {object} [options]
   * @param {number} [options.gridCellSizeM]
   */
  constructor(engine, { gridCellSizeM = 25 } = {}) {
    this._sceneManager = engine.sceneManager;
    /** @type {Map<string, Building>} */
    this._buildings = new Map();

    this._spatialGrid = new SpatialGrid({
      cellSize: gridCellSizeM,
      getBounds: (building) => building.getAABB(),
    });

    this._palette = BUILDING_COLORS.map(
      (color) => new THREE.MeshLambertMaterial({ color })
    );

    this._orderSequence = 0;
    this._maxHalfDiagonalM = 0;
  }

  get count() {
    return this._buildings.size;
  }

  get spatialGrid() {
    return this._spatialGrid;
  }

  get maxHalfDiagonalM() {
    return this._maxHalfDiagonalM;
  }

  addBuilding({ id, position, size, rotationY = 0 }) {
    if (!id) {
      id = `b_${Date.now()}_${++this._orderSequence}`;
    }
    if (this._buildings.has(id)) {
      throw new Error(`BuildingManager.addBuilding: duplicate id "${id}"`);
    }

    const paletteIndex = Math.abs(this._hashString(id)) % this._palette.length;
    const material = this._palette[paletteIndex];

    const building = new Building({ id, position, size, rotationY, material });
    building.addedOrder = ++this._orderSequence;
    building.moveOrder = building.addedOrder;

    this._buildings.set(id, building);
    this._spatialGrid.insert(building);
    this._sceneManager.add(building.mesh);

    if (building.halfDiagonalM > this._maxHalfDiagonalM) {
      this._maxHalfDiagonalM = building.halfDiagonalM;
    }
    return building;
  }

  remove(buildingOrId) {
    const id = typeof buildingOrId === 'string' ? buildingOrId : buildingOrId?.id;
    const building = this._buildings.get(id);
    if (!building) return false;

    this._sceneManager.remove(building.mesh);
    building.mesh.geometry.dispose();
    this._spatialGrid.remove(building);
    this._buildings.delete(id);

    if (Math.abs(building.halfDiagonalM - this._maxHalfDiagonalM) < 1e-4) {
      this._recomputeMaxHalfDiagonal();
    }
    return true;
  }

  moveBuilding(building, dx, dz) {
    if (!this._buildings.has(building.id)) return false;
    building.translate(dx, dz);
    building.moveOrder = ++this._orderSequence;
    this._spatialGrid.update(building);
    return true;
  }

  notifyBuildingChanged(building) {
    if (!this._buildings.has(building.id)) return false;
    building.moveOrder = ++this._orderSequence;
    this._spatialGrid.update(building);
    if (building.halfDiagonalM > this._maxHalfDiagonalM) {
      this._maxHalfDiagonalM = building.halfDiagonalM;
    }
    return true;
  }

  get(id) {
    return this._buildings.get(id) ?? null;
  }

  has(buildingOrId) {
    const id = typeof buildingOrId === 'string' ? buildingOrId : buildingOrId?.id;
    return this._buildings.has(id);
  }

  getAll() {
    return Array.from(this._buildings.values());
  }

  queryAABB(box) {
    return this._spatialGrid.queryAABB(box);
  }

  queryRadius(center, radiusM) {
    return this._spatialGrid.queryRadius(center, radiusM);
  }

  disposeAll() {
    for (const building of this._buildings.values()) {
      this._sceneManager.remove(building.mesh);
      building.mesh.geometry.dispose();
    }
    this._buildings.clear();
    this._spatialGrid.clear();
    this._maxHalfDiagonalM = 0;
  }

  dispose() {
    this.disposeAll();
    for (const mat of this._palette) mat.dispose();
    this._palette = [];
    this._sceneManager = null;
  }

  _recomputeMaxHalfDiagonal() {
    let max = 0;
    for (const b of this._buildings.values()) {
      if (b.halfDiagonalM > max) max = b.halfDiagonalM;
    }
    this._maxHalfDiagonalM = max;
  }

  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }
}