import * as THREE from 'three';
import { buildRibbonGeometry } from '../utils/GeometryUtils.js';
import { mulberry32 } from '../utils/MathUtils.js';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ROAD = ConfigDefaults.road;

/** Asphalt surface height above the ground plane (z-fighting avoidance). */
export const ROAD_SURFACE_Y = ROAD.roadSurfaceYM;
/** Meters per asphalt texture repetition — UVs are computed in tile units. */
export const ASPHALT_TILE_M = ROAD.asphaltTileM;

/**
 * RoadMeshBuilder — asphalt ribbon meshes, one per segment.
 *
 * rebuild(segment) keeps the Mesh, swaps geometry, and disposes only the OLD
 * geometry — the shared material/texture are never touched.
 * (Lane-count changes should also rebuild markings + intersections.)
 */
export class RoadMeshBuilder {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this._sceneManager = engine.sceneManager;
    const maxAnisotropy = Math.min(8, engine.renderer.capabilities.getMaxAnisotropy());
    this.asphaltTexture = createAsphaltTexture(maxAnisotropy);
    this.asphaltMaterial = new THREE.MeshStandardMaterial({
      map: this.asphaltTexture,
      roughness: 0.94,
      metalness: 0.0,
    });
    /** @type {Map<string, THREE.Mesh>} */
    this._meshes = new Map();
  }

  build(segment) {
    if (this._meshes.has(segment.id)) return this.rebuild(segment);
    const mesh = new THREE.Mesh(this._buildGeometry(segment), this.asphaltMaterial);
    mesh.name = `road:${segment.id}`;
    mesh.receiveShadow = true;
    this._sceneManager.add(mesh);
    this._meshes.set(segment.id, mesh);
    return mesh;
  }

  /**
   * Rebuild after lane counts (or lane width) changed: new geometry in,
   * old geometry disposed, mesh object and material untouched.
   */
  rebuild(segment) {
    const mesh = this._meshes.get(segment.id);
    if (!mesh) return this.build(segment);
    const oldGeometry = mesh.geometry;
    mesh.geometry = this._buildGeometry(segment);
    oldGeometry.dispose();
    return mesh;
  }

  getMesh(segmentId) {
    return this._meshes.get(segmentId);
  }

  dispose(segment) {
    const mesh = this._meshes.get(segment.id);
    if (!mesh) return;
    this._sceneManager.remove(mesh);
    mesh.geometry.dispose();
    this._meshes.delete(segment.id);
  }

  disposeAll() {
    for (const mesh of [...this._meshes.values()]) {
      this._sceneManager.remove(mesh);
      mesh.geometry.dispose();
    }
    this._meshes.clear();
    this.asphaltMaterial.dispose();
    this.asphaltTexture.dispose();
  }

  _buildGeometry(segment) {
    return buildRibbonGeometry(segment.getCurve(), {
      offsetLeftM: segment.halfWidthBackwardM,
      offsetRightM: segment.halfWidthForwardM,
      y: ROAD_SURFACE_Y,
      spacingM: ROAD.sampleSpacingM,
      uvTileM: ASPHALT_TILE_M,
    });
  }
}

/** Procedural asphalt: dark base + grayscale speckle (deterministic seed). */
function createAsphaltTexture(maxAnisotropy = 8) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = ROAD.asphaltBaseCss;
  ctx.fillRect(0, 0, size, size);

  const random = mulberry32(ROAD.asphaltSeed);
  for (let i = 0; i < ROAD.asphaltSpeckles; i++) {
    const shade = 26 + Math.floor(random() * 34);
    ctx.fillStyle = `rgb(${shade}, ${shade + 2}, ${shade + 5})`;
    const s = random() < 0.8 ? 1 : 2;
    ctx.fillRect(Math.floor(random() * size), Math.floor(random() * size), s, s);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  return texture;
}