import * as THREE from 'three';

/**
 * SceneManager — the single owner of the THREE.Scene.
 *
 * Exposes add()/remove() (variadic, mirroring Object3D semantics) so no other
 * module ever touches `scene.add` directly, plus setFog()/setBackground() for
 * the scene-level state the environment controllers drive.
 *
 * Phase 0 placeholder environment:
 * - Ground + grid stay until world/World.js calls removePhase0Environment().
 * - The placeholder lights were retired in Phase 1: environment/Lighting.js
 *   owns all lights now (it calls removePhase0Lights() on construction).
 */
export class SceneManager {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14171c);
    // Phase 0 default (linear fog). Phase 1+ replaces this with a FogExp2
    // owned by environment/FogController.js — see setFog().
    this.scene.fog = new THREE.Fog(0x14171c, 140, 420);

    this._phase0Ground = null; // [ground, grid]
    this._phase0Lights = null; // [hemisphereLight, sunLight]
    this._createPhase0Environment();
  }

  /** Add one or more objects to the scene. Returns the object (or the array). */
  add(...objects) {
    this.scene.add(...objects);
    return objects.length === 1 ? objects[0] : objects;
  }

  /** Remove one or more objects from the scene. Returns the object (or the array). */
  remove(...objects) {
    this.scene.remove(...objects);
    return objects.length === 1 ? objects[0] : objects;
  }

  /**
   * Scene-level state setters. Fog/background are scene properties, so they
   * stay owned here even though the controllers decide the values.
   * Pass null to clear.
   */
  setFog(fog) {
    this.scene.fog = fog;
    return fog;
  }

  setBackground(background) {
    this.scene.background = background;
    return background;
  }

  /**
   * PHASE 0 ONLY.
   * Static 500×500 ground, grid overlay, hemisphere + directional light so
   * the scene renders before the world systems exist.
   */
  _createPhase0Environment() {
    // Ground plane — receives shadows from later gameplay objects.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(500, 500),
      new THREE.MeshStandardMaterial({
        color: 0x42474e,
        roughness: 0.95,
        metalness: 0.0,
      })
    );
    ground.name = 'ground';
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;

    // Grid overlay — gives the flat plane visible parallax while orbiting.
    const grid = new THREE.GridHelper(500, 100, 0x71808f, 0x2c3138);
    grid.name = 'grid';
    grid.position.y = 0.02; // avoid z-fighting with the ground
    grid.material.transparent = true;
    grid.material.opacity = 0.55;

    // Sky / ground-bounce fill.
    const hemisphereLight = new THREE.HemisphereLight(0xbdd0de, 0x3b342c, 2.2);
    hemisphereLight.name = 'hemisphereLight';

    // Key light (sun).
    const sunLight = new THREE.DirectionalLight(0xfff2df, 2.6);
    sunLight.name = 'sunLight';
    sunLight.position.set(60, 90, 40);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 300;
    sunLight.shadow.camera.left = -120;
    sunLight.shadow.camera.right = 120;
    sunLight.shadow.camera.top = 120;
    sunLight.shadow.camera.bottom = -120;
    sunLight.shadow.bias = -0.0004;

    this.add(ground, grid, hemisphereLight, sunLight);
    this._phase0Ground = [ground, grid];
    this._phase0Lights = [hemisphereLight, sunLight];
  }

  /**
   * Phase 1 hand-off: retire the placeholder hemisphere + sun lights.
   * environment/Lighting.js owns all lights from now on. Idempotent.
   */
  removePhase0Lights() {
    if (!this._phase0Lights) return;
    for (const object of this._phase0Lights) {
      this._removeAndDispose(object);
    }
    this._phase0Lights = null;
  }

  /**
   * Full hand-off for a later phase: lights + ground + grid.
   * Called by world/World.js once real terrain exists. Idempotent.
   */
  removePhase0Environment() {
    this.removePhase0Lights();
    if (this._phase0Ground) {
      for (const object of this._phase0Ground) {
        this._removeAndDispose(object);
      }
      this._phase0Ground = null;
    }
  }

  /** Remove from the scene, then dispose all GPU resources. */
  _removeAndDispose(object) {
    this.scene.remove(object);
    this._disposeResources(object);
  }

  /** Free geometry / materials / shadow maps of a single object. */
  _disposeResources(object) {
    if (object.geometry) object.geometry.dispose();
    if (object.material) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    }
    object.dispose?.(); // lights: frees shadow maps; meshes: no-op
  }

  /** Deep-dispose every geometry/material in the scene, then clear it. */
  dispose() {
    this.scene.traverse((object) => this._disposeResources(object));
    this.scene.clear();
    this._phase0Ground = null;
    this._phase0Lights = null;
  }
}