import * as THREE from 'three';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ENV = ConfigDefaults.environment;

/**
 * Lighting — owns the scene's THREE.Light instances (one directional key
 * light with shadows + one hemisphere fill). TimeOfDayController pushes
 * preset values in via applyPreset(); this class never decides values.
 *
 * Constructor retires SceneManager's Phase-0 placeholder lights; the
 * placeholder ground/grid are NOT touched (those wait for Terrain).
 */
export class Lighting {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this._sceneManager = engine.sceneManager;
    this._sceneManager.removePhase0Lights();

    // Key light. Values below are construction placeholders only —
    // TimeOfDayController overwrites all of them on its first setPreset().
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1);
    this.sunLight.name = 'sunLight';
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(ENV.shadowMapSize, ENV.shadowMapSize);
    this.sunLight.shadow.camera.near = ENV.shadowCameraNearM;
    this.sunLight.shadow.camera.far = ENV.shadowCameraFarM;
    this.sunLight.shadow.camera.left = -ENV.shadowCameraExtentM;
    this.sunLight.shadow.camera.right = ENV.shadowCameraExtentM;
    this.sunLight.shadow.camera.top = ENV.shadowCameraExtentM;
    this.sunLight.shadow.camera.bottom = -ENV.shadowCameraExtentM;
    this.sunLight.shadow.bias = ENV.shadowBias;
    this._sceneManager.add(this.sunLight);

    // DirectionalLight aims at `.target` (defaults to the world origin);
    // adding it to the scene means later phases can aim the sun.
    this._sceneManager.add(this.sunLight.target);

    // Fill light — sky / ground bounce.
    this.hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    this.hemisphereLight.name = 'hemisphereLight';
    this._sceneManager.add(this.hemisphereLight);
  }

  /** Apply a TimeOfDayController preset's lighting block. */
  applyPreset({ sun, hemisphere }) {
    this.sunLight.color.set(sun.color);
    this.sunLight.intensity = sun.intensity;
    this.sunLight.position.set(sun.position[0], sun.position[1], sun.position[2]);

    this.hemisphereLight.color.set(hemisphere.skyColor);
    this.hemisphereLight.groundColor.set(hemisphere.groundColor);
    this.hemisphereLight.intensity = hemisphere.intensity;
  }

  /** Teardown: remove lights and free the shadow map. */
  dispose() {
    this._sceneManager.remove(this.sunLight, this.sunLight.target, this.hemisphereLight);
    this.sunLight.dispose?.(); // frees the shadow map
    this.sunLight = null;
    this.hemisphereLight = null;
    this._sceneManager = null;
  }
}