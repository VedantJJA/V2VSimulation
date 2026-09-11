/**
 * TimeOfDayController — time-of-day preset table + application logic.
 *
 * Owns NO three.js objects. It is pure orchestration:
 * - Lighting owns the actual light instances and applies the sun/hemisphere
 *   values pushed by this controller.
 * - SkyController owns the gradient dome and applies the sky colors.
 *
 * Preset schema:
 *   sun        { color, intensity, position: [x, y, z] }   key light (sun or moon)
 *   hemisphere { skyColor, groundColor, intensity }         ambient fill
 *   sky        { topColor, horizonColor, exponent }         gradient dome
 *
 * Deliberately does NOT define or touch fog. FogController is fully
 * independent: setPreset() never writes scene.fog, so fog settings survive
 * every preset switch. (Construct FogController after the initial setPreset()
 * call — see main.js.)
 *
 * EventBus:
 *   'time-of-day:changed' → { name, preset }   emitted after every apply.
 *
 * Values are plain data (hex numbers, arrays) so the table stays serialisable
 * and a later debug panel can tweak presets live.
 */
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
    // The "sun" is the moon: cool, dim, high.
    sun: { color: 0x8fa8ff, intensity: 0.45, position: [50, 80, -70] },
    hemisphere: { skyColor: 0x2a3350, groundColor: 0x10131c, intensity: 0.6 },
    sky: { topColor: 0x05070f, horizonColor: 0x1c2742, exponent: 1.6 },
  },
};

export class TimeOfDayController {
  /**
   * @param {object} options
   * @param {import('./Lighting.js').Lighting} options.lighting
   * @param {import('./SkyController.js').SkyController} options.sky
   * @param {import('../core/EventBus.js').EventBus} [options.bus]
   * @param {string} [options.initialPreset] applied immediately (default 'day')
   */
  constructor({ lighting, sky, bus = null, initialPreset = 'day' } = {}) {
    if (!lighting) throw new TypeError('TimeOfDayController: requires a Lighting instance');
    if (!sky) throw new TypeError('TimeOfDayController: requires a SkyController instance');

    this._lighting = lighting;
    this._sky = sky;
    this._bus = bus;
    this._presetName = null;

    this.setPreset(initialPreset);
  }

  /** Names of all available presets, in definition order. */
  get presetNames() {
    return Object.keys(PRESETS);
  }

  /**
   * Switch to a preset. Applies lighting + sky values immediately (same
   * frame — no transition), stores the name, and emits on the bus.
   * Never touches fog.
   * @param {string} name 'dawn' | 'day' | 'night'
   */
  setPreset(name) {
    const preset = PRESETS[name];
    if (!preset) {
      throw new Error(
        `TimeOfDayController.setPreset: unknown preset "${name}". Available: ${this.presetNames.join(', ')}`
      );
    }

    this._presetName = name;
    this._lighting.applyPreset(preset);
    this._sky.applyPreset(preset.sky);

    if (this._bus) this._bus.emit('time-of-day:changed', { name, preset });
    return this;
  }

  /** @returns {string} the name of the currently active preset. */
  getPreset() {
    return this._presetName;
  }

  /** Drop references (HMR / teardown). */
  dispose() {
    this._lighting = null;
    this._sky = null;
    this._bus = null;
    this._presetName = null;
  }
}