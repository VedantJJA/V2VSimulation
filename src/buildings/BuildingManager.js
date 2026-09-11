import * as THREE from 'three';
import { Building } from './Building.js';
import { SpatialGrid } from './SpatialGrid.js';

const BUILDING_COLORS = [0x8f8a80, 0xa39a86, 0x6e7c88, 0x9c6f5f, 0x7c8570];

/**
 * BuildingManager — owns all Building instances and their meshes.
 *
 * - addBuilding/remove: scene membership + SpatialGrid insert/remove.
 * - moveBuilding: atomic translate + recency stamp + grid update — the
 *   sanctioned path for resolver pushes.
 * - notifyBuildingChanged (Phase 5): the gizmo path — the mesh was moved by
 *   TransformControls, Building setters already applied the data, and this
 *   refreshes the broadphase + recency stamp.
 * - Recency stamps (`addedOrder`, `moveOrder`) drive CollisionResolver's
 *   "remove the more-recently-moved" policy.
 * - maxHalfDiagonalM: worst-case footprint radius, so callers can expand
 *   broadphase queries to catch large buildings whose CENTERS fall outside
 *   the query box.
 *
 * The SpatialGrid instance is exposed (`.spatialGrid`) — later systems
 * (sensors) can reuse the same grid or the same pattern with their own
 * getBounds.
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

    // Shared palette (chosen deterministically per building id) — disposed
    // once in disposeAll, never per building.
    this._materials = BUILDING_COLORS.map(
      (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05 })
    );

    this._order = 0; // monotonic stamp for adds AND moves
    this._buildingSequence = 0;
    this._maxHalfDiagonalM = 0;
  }

  get spatialGrid() {
    return this._spatialGrid;
  }

  get buildingCount() {
    return this._buildings.size;
  }

  /** Worst-case building footprint half-diagonal, for query expansion. */
  get maxHalfDiagonalM() {
    return this._maxHalfDiagonalM;
  }

  /**
   * Create, mesh, and index a building.
   * @param {object} options
   * @param {string} [options.id] auto-generated when omitted
   * @param {THREE.Vector3 | number[]} options.position ground point
   * @param {[number, number, number]} options.size [w, d, h]
   * @param {number} [options.rotationY]
   */
  addBuilding({ id, position, size, rotationY = 0 }) {
    const buildingId = id ?? `building-${++this._buildingSequence}`;
    if (this._buildings.has(buildingId)) {
      throw new Error(`BuildingManager: duplicate building id "${buildingId}"`);
    }
    const building = new Building({
      id: buildingId,
      position,
      size,
      rotationY,
      material: this._materialFor(buildingId),
    });
    building.addedOrder = ++this._order;

    this._buildings.set(buildingId, building);
    this._spatialGrid.insert(building);
    this._maxHalfDiagonalM = Math.max(this._maxHalfDiagonalM, building.halfDiagonalM);
    this._sceneManager.add(building.mesh);
    return building;
  }

  /** Remove by instance or id. @returns {boolean} whether it existed. */
  remove(buildingOrId) {
    const id = typeof buildingOrId === 'string' ? buildingOrId : buildingOrId?.id;
    const building = this._buildings.get(id);
    if (!building) return false;

    this._spatialGrid.remove(building);
    this._sceneManager.remove(building.mesh);
    building.mesh.geometry.dispose(); // per-building geometry; material is shared
    this._buildings.delete(id);
    this._recomputeMaxHalfDiagonal();
    return true;
  }

  /** @param {Building | string} buildingOrId */
  has(buildingOrId) {
    const id = typeof buildingOrId === 'string' ? buildingOrId : buildingOrId?.id;
    return this._buildings.has(id);
  }

  get(buildingId) {
    return this._buildings.get(buildingId);
  }

  /** Snapshot array of all buildings. */
  getAll() {
    return [...this._buildings.values()];
  }

  /** Broadphase passthrough. */
  queryAABB(box) {
    return this._spatialGrid.queryAABB(box);
  }

  /** Broadphase passthrough. */
  queryRadius(center, radiusM) {
    return this._spatialGrid.queryRadius(center, radiusM);
  }

  /**
   * Move a building: translate + recency stamp + broadphase refresh.
   * The sanctioned mutation path for the collision resolver.
   */
  moveBuilding(building, dx, dz) {
    if (!this.has(building)) throw new Error(`BuildingManager: unknown building "${building?.id}"`);
    building.translate(dx, dz);
    building.moveOrder = ++this._order;
    this._spatialGrid.update(building);
  }

  /**
   * Gizmo path (Phase 5): the Building setters already applied the transform
   * to the data; refresh the broadphase + recency and re-check the
   * max-extent cache (scaling can grow a footprint).
   */
  notifyBuildingChanged(building) {
    if (!this.has(building)) throw new Error(`BuildingManager: unknown building "${building?.id}"`);
    building.moveOrder = ++this._order;
    this._spatialGrid.update(building);
    this._maxHalfDiagonalM = Math.max(this._maxHalfDiagonalM, building.halfDiagonalM);
  }

  /** Remove everything and free all shared resources. */
  disposeAll() {
    for (const building of this._buildings.values()) {
      this._sceneManager.remove(building.mesh);
      building.mesh.geometry.dispose();
    }
    this._spatialGrid.clear();
    this._buildings.clear();
    for (const material of this._materials) material.dispose();
    this._maxHalfDiagonalM = 0;
  }

  /** Deterministic palette pick so a building keeps its color across reloads. */
  _materialFor(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0;
    }
    return this._materials[Math.abs(hash) % this._materials.length];
  }

  _recomputeMaxHalfDiagonal() {
    let max = 0;
    for (const building of this._buildings.values()) {
      max = Math.max(max, building.halfDiagonalM);
    }
    this._maxHalfDiagonalM = max;
  }
}