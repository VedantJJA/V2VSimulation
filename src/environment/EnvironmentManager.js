import * as THREE from 'three';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ENV = ConfigDefaults.environment;

/**
 * Lighting — Owns directional sun light (with shadow map) and hemisphere fill light.
 */
export class Lighting {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this._sceneManager = engine.sceneManager;
    this._sceneManager.removePhase0Lights();

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
    this._sceneManager.add(this.sunLight.target);

    this.hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    this.hemisphereLight.name = 'hemisphereLight';
    this._sceneManager.add(this.hemisphereLight);
  }

  applyPreset({ sun, hemisphere }) {
    this.sunLight.color.set(sun.color);
    this.sunLight.intensity = sun.intensity;
    this.sunLight.position.set(sun.position[0], sun.position[1], sun.position[2]);

    this.hemisphereLight.color.set(hemisphere.skyColor);
    this.hemisphereLight.groundColor.set(hemisphere.groundColor);
    this.hemisphereLight.intensity = hemisphere.intensity;
  }

  dispose() {
    this._sceneManager.remove(this.sunLight, this.sunLight.target, this.hemisphereLight);
    this.sunLight.dispose?.();
    this.sunLight = null;
    this.hemisphereLight = null;
    this._sceneManager = null;
  }
}

const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 bottomColor;
  uniform float exponent;
  varying vec3 vWorldPosition;

  void main() {
    vec3 direction = normalize(vWorldPosition - cameraPosition);
    float h = direction.y;
    float up = pow(clamp(h, 0.0, 1.0), exponent);
    vec3 color = mix(horizonColor, topColor, up);
    float down = pow(clamp(-h, 0.0, 1.0), exponent);
    color = mix(color, bottomColor, down);
    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * SkyController — Gradient sky dome centered dynamically on camera.
 */
export class SkyController {
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this._sceneManager = engine.sceneManager;
    this._camera = engine.camera;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x4a90d9) },
        horizonColor: { value: new THREE.Color(0xcfe5f2) },
        bottomColor: { value: new THREE.Color(0x2a333f) },
        exponent: { value: 0.7 },
      },
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(ENV.skyDomeRadiusM, ENV.skyDomeSegments, ENV.skyDomeRings),
      this.material
    );
    this.mesh.name = 'skyDome';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this._sceneManager.add(this.mesh);

    this._unsubscribeUpdate = engine.addUpdate(() => this.update());
  }

  update() {
    this.mesh.position.copy(this._camera.position);
  }

  applyPreset({ topColor, horizonColor, exponent }) {
    this.setColors(topColor, horizonColor, exponent);
  }

  setColors(topColor, horizonColor, exponent) {
    const uniforms = this.material.uniforms;
    uniforms.topColor.value.set(topColor);
    uniforms.horizonColor.value.set(horizonColor);
    if (exponent !== undefined) uniforms.exponent.value = exponent;
    const bottom = new THREE.Color(horizonColor).lerp(new THREE.Color(0x000000), 0.65);
    uniforms.bottomColor.value.copy(bottom);
  }

  dispose() {
    this._unsubscribeUpdate?.();
    this._sceneManager.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh = null;
    this.material = null;
    this._sceneManager = null;
    this._camera = null;
  }
}

const PRESETS = {
  dawn: {
    sun: { color: 0xff9a4d, intensity: 1.8, position: [-110, 22, 60] },
    hemisphere: { skyColor: 0xe8c9a8, groundColor: 0x453226, intensity: 1.15 },
    sky: { topColor: 0x2f4a78, horizonColor: 0xffa457, exponent: 2.2 },
  },
  day: {
    sun: { color: 0xfff2df, intensity: 3.0, position: [80, 120, 40] },
    hemisphere: { skyColor: 0xbdd0de, groundColor: 0x3b342c, intensity: 2.2 },
    sky: { topColor: 0x4a90d9, horizonColor: 0xcfe5f2, exponent: 0.7 },
  },
  night: {
    sun: { color: 0x8fa8ff, intensity: 0.45, position: [50, 80, -70] },
    hemisphere: { skyColor: 0x2a3350, groundColor: 0x10131c, intensity: 0.6 },
    sky: { topColor: 0x05070f, horizonColor: 0x1c2742, exponent: 1.6 },
  },
};

/**
 * TimeOfDayController — Manages time-of-day presets and applies them across lighting and sky.
 */
export class TimeOfDayController {
  constructor({ lighting, sky, bus = null, initialPreset = 'day' } = {}) {
    if (!lighting) throw new TypeError('TimeOfDayController: requires Lighting instance');
    if (!sky) throw new TypeError('TimeOfDayController: requires SkyController instance');

    this._lighting = lighting;
    this._sky = sky;
    this._bus = bus;
    this._presetName = null;

    this.setPreset(initialPreset);
  }

  get presetNames() {
    return Object.keys(PRESETS);
  }

  setPreset(name) {
    const preset = PRESETS[name];
    if (!preset) throw new Error(`TimeOfDayController: unknown preset "${name}"`);

    this._presetName = name;
    this._lighting.applyPreset(preset);
    this._sky.applyPreset(preset.sky);

    if (this._bus) this._bus.emit('time-of-day:changed', { name, preset });
    return this;
  }

  getPreset() {
    return this._presetName;
  }

  dispose() {
    this._lighting = null;
    this._sky = null;
    this._bus = null;
  }
}

/**
 * FogController — Controls scene exponential fog.
 */
export class FogController {
  constructor(engine, { color = ENV.fogColorHex, density = ENV.fogDensityDefault } = {}) {
    this._sceneManager = engine.sceneManager;
    this.fog = new THREE.FogExp2(color, density);
    this._sceneManager.setFog(this.fog);
  }

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

  setColor(color) {
    this.fog.color.set(color);
    return this;
  }

  getColor() {
    return this.fog.color;
  }

  dispose() {
    this._sceneManager.setFog(null);
    this.fog = null;
    this._sceneManager = null;
  }
}
