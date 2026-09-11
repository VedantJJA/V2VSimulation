import * as THREE from 'three';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ENV = ConfigDefaults.environment;

/**
 * FogController — owns the scene fog (THREE.FogExp2).
 *
 * Deliberately independent of TimeOfDayController: setPreset() never writes
 * fog, so whatever is configured here survives every preset switch. Create
 * it AFTER the initial setPreset() call (main.js does).
 */
export class FogController {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {object} [options]
   * @param {number | import('three').Color} [options.color]
   * @param {number} [options.density]
   */
  constructor(engine, { color = ENV.fogColorHex, density = ENV.fogDensityDefault } = {}) {
    this._sceneManager = engine.sceneManager;
    this.fog = new THREE.FogExp2(color, density);
    this._sceneManager.setFog(this.fog);
  }

  /** Exponential fog density (visibility ≈ 1/density). Clamped ≥ 0. */
  setDensity(value) {
    const density = Number(value);
    this.fog.density = Number.isFinite(density) ? Math.max(0, density) : 0;
    return this;
  }

  getDensity() {
    return this.fog.density;
  }

  get density() {
    return this.fog ? this.fog.density : 0;
  }

  /** Set the fog color (hex number, css string, or THREE.Color). */
  setColor(color) {
    this.fog.color.set(color);
    return this;
  }

  getColor() {
    return this.fog.color;
  }

  /** Teardown: detach from the scene. */
  dispose() {
    if (this._sceneManager) this._sceneManager.setFog(null);
    this.fog = null;
    this._sceneManager = null;
  }
}