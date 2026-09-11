/**
 * SpatialGrid — generic uniform XZ broadphase grid.
 *
 * Deliberately building-agnostic (and three.js-free): items are ANY object,
 * bounded by the `getBounds(item) => { minX, minZ, maxX, maxZ }` callback
 * supplied at construction. The sensor system (later phase) can drop its own
 * items into a grid with a different getBounds without touching this file.
 *
 * Semantics:
 * - insert(item): adds across every cell the item's bounds touch. Throws on
 *   double-insert (use update()).
 * - remove(item): detaches; returns whether the item was present.
 * - update(item): remove + insert — call after an item moves.
 * - queryAABB(box): items whose bounds actually intersect `box`
 *   (cell overlap is necessary, exact AABB intersection is the filter).
 * - queryRadius(center, radius): items whose bounds come within `radius`
 *   of the center (closest-point-on-AABB test), not just cell overlap.
 *
 * Cells are keyed "cx,cz" with floor division, so negative coordinates work.
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
    /** @type {Map<string, Set<any>>} */
    this._cells = new Map();
    /** @type {Map<any, { cells: string[], bounds: object }>} */
    this._itemInfo = new Map();
  }

  /** Number of items currently indexed. */
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

  /** @returns {boolean} whether the item was indexed. */
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

  /** Re-index an item after it moved (remove + insert). */
  update(item) {
    if (!this._itemInfo.has(item)) return this.insert(item);
    this.remove(item);
    return this.insert(item);
  }

  has(item) {
    return this._itemInfo.has(item);
  }

  /** Items whose bounds intersect { minX, minZ, maxX, maxZ }. */
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

  /**
   * Items whose bounds come within `radius` of `center` (anything with
   * .x/.z — THREE.Vector3 or a plain {x, z}).
   */
  queryRadius(center, radius) {
    const x = center.x;
    const z = center.z;
    const radiusSq = radius * radius;
    const result = [];
    for (const item of this._candidates(x - radius, z - radius, x + radius, z + radius)) {
      const b = this._itemInfo.get(item).bounds;
      // Closest point on the item's AABB to the query center.
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

  /** Deduped items across every cell the box touches. */
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