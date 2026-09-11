import GUI from 'lil-gui';
import { ConfigDefaults } from '../state/ConfigDefaults.js';

const ENV = ConfigDefaults.environment;

/**
 * ControlPanel — lil-gui master panel.
 *
 * Permanent folders (created at construction):
 *   • Environment — time-of-day preset dropdown + fog density slider
 *
 * Session folders (created/destroyed per simulation session):
 *   • Roads debug — per-segment lane count ± buttons, rebuild triggers
 *   • Map — load JSON file, switch to editor, load built-in maps
 *   • Sensors — ray visualizer toggle, front camera toggle, GPU toggle
 *   • Traffic — LOD promote-N slider, spawn-NPCs button, tier counter
 *
 * All tunables originate from ConfigDefaults at construction; the panel
 * mutates LIVE instances, never ConfigDefaults itself.
 */
export class ControlPanel {
  /**
   * @param {object} options
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../environment/TimeOfDayController.js').TimeOfDayController} options.timeOfDay
   * @param {import('../environment/FogController.js').FogController} options.fog
   */
  constructor({ bus, timeOfDay, fog }) {
    this._bus = bus;
    this._timeOfDay = timeOfDay;
    this._fog = fog;

    this._gui = new GUI({ title: 'Controls' });

    // ---- Environment (permanent) ----
    const envFolder = this._gui.addFolder('Environment');
    const initialFogDensity = (fog.getDensity ? fog.getDensity() : fog.density) ?? ENV.fogDensityDefault;
    this._envState = {
      preset: timeOfDay.getPreset(),
      fogDensity: initialFogDensity,
    };
    envFolder
      .add(this._envState, 'preset', ['dawn', 'day', 'night'])
      .name('Time of day')
      .onChange((value) => {
        this._timeOfDay.setPreset(value);
        this._fog.setDensity(this._envState.fogDensity); // re-apply fog after preset
      });
    envFolder
      .add(this._envState, 'fogDensity', 0, ENV.fogDensityMax, ENV.fogDensityStep)
      .name('Fog density')
      .onChange((value) => this._fog.setDensity(value));
    envFolder.open();

    // Session folders — lazily created, tracked for removal.
    this._roadsFolder = null;
    this._mapFolder = null;
    this._sensorsFolder = null;
    this._trafficFolder = null;
    this._sensorReadoutController = null;
    this._gpuSensorsToggle = null;
  }

  // ---- Roads debug folder ---------------------------------------------------

  addRoadsDebugFolder({ network, meshBuilder, markingBuilder, intersectionBuilder, buildingManager, collisionResolver }) {
    this.removeRoadsFolder();
    const folder = this._gui.addFolder('Roads (debug)');

    for (const segmentId of network.segmentIds) {
      const segment = network.getSegment(segmentId);
      if (!segment) continue;

      const segFolder = folder.addFolder(segmentId);
      const state = {
        lanesForward: segment.lanesForward,
        lanesBackward: segment.lanesBackward,
      };

      const rebuild = () => {
        segment.lanesForward = state.lanesForward;
        segment.lanesBackward = state.lanesBackward;
        meshBuilder.rebuild(segment);
        markingBuilder.rebuild(segment);
        // Rebuild intersections at both endpoints.
        for (const nodeId of [segment.startNodeId, segment.endNodeId]) {
          intersectionBuilder.rebuild(nodeId, network);
        }
        // Resolve building collisions.
        collisionResolver.resolveForSegment(segment, buildingManager);
        collisionResolver.resolveOverlaps(buildingManager);
      };

      segFolder.add(state, 'lanesForward', 0, 4, 1).name('Fwd lanes').onChange(rebuild);
      segFolder.add(state, 'lanesBackward', 0, 4, 1).name('Bwd lanes').onChange(rebuild);
      segFolder.close();
    }

    folder.close();
    this._roadsFolder = folder;
  }

  removeRoadsFolder() {
    if (this._roadsFolder) {
      this._roadsFolder.destroy();
      this._roadsFolder = null;
    }
  }

  // ---- Map folder -----------------------------------------------------------

  addMapFolder({ onLoadMapFile, onEditMap, builtInMaps = [] }) {
    this.removeMapFolder();
    const folder = this._gui.addFolder('Map');

    // Load JSON file.
    const fileState = { load: () => {} };
    fileState.load = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const data = JSON.parse(/** @type {string} */ (reader.result));
            onLoadMapFile(data);
          } catch (e) {
            console.error('[ControlPanel] Failed to parse map JSON:', e);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    };
    folder.add(fileState, 'load').name('Load map file…');

    // Edit map button.
    if (onEditMap) {
      folder.add({ edit: onEditMap }, 'edit').name('✏️ Edit map');
    }

    // Built-in maps.
    for (const map of builtInMaps) {
      const loadBuiltIn = async () => {
        try {
          const resp = await fetch(map.url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          onLoadMapFile(data);
        } catch (e) {
          console.error(`[ControlPanel] Failed to load built-in map '${map.name}':`, e);
        }
      };
      folder.add({ load: loadBuiltIn }, 'load').name(`📦 ${map.name}`);
    }

    folder.close();
    this._mapFolder = folder;
  }

  removeMapFolder() {
    if (this._mapFolder) {
      this._mapFolder.destroy();
      this._mapFolder = null;
    }
  }

  // ---- Sensors folder -------------------------------------------------------

  addSensorsFolder({ visualizer, frontCamera, gpuSensors = null }) {
    this.removeSensorsFolder();
    const folder = this._gui.addFolder('Sensors');

    // Ray visualizer toggle.
    const vizState = { showRays: visualizer.enabled ?? visualizer.visible ?? false };
    folder.add(vizState, 'showRays').name('Show rays').onChange((v) => {
      if (typeof visualizer.setEnabled === 'function') visualizer.setEnabled(v);
      else visualizer.enabled = v;
    });

    // Front camera toggle.
    const camState = { frontCamera: frontCamera.enabled ?? false };
    folder.add(camState, 'frontCamera').name('Front camera').onChange((v) => {
      if (typeof frontCamera.setEnabled === 'function') frontCamera.setEnabled(v);
      else frontCamera.enabled = v;
    });

    // GPU sensors toggle (only when WebGPU is available).
    if (gpuSensors) {
      const gpuState = { gpuSensors: false };
      this._gpuSensorsToggle = folder.add(gpuState, 'gpuSensors').name('GPU sensors').onChange((v) => {
        gpuSensors.onToggle(v);
      });
    }

    // Sensor readout (preformatted text).
    const readoutState = { readout: '' };
    this._sensorReadoutController = folder.add(readoutState, 'readout').name('Readout').disable();
    // Make it a larger text display.
    const readoutEl = this._sensorReadoutController.domElement;
    if (readoutEl) {
      const inputEl = readoutEl.querySelector('input');
      if (inputEl) {
        inputEl.style.fontFamily = 'monospace';
        inputEl.style.fontSize = '10px';
      }
    }

    folder.open();
    this._sensorsFolder = folder;
  }

  removeSensorsFolder() {
    if (this._sensorsFolder) {
      this._sensorsFolder.destroy();
      this._sensorsFolder = null;
      this._sensorReadoutController = null;
      this._gpuSensorsToggle = null;
    }
  }

  /**
   * Update the sensor readout text (called at ~10 Hz from main.js).
   * @param {string} text
   */
  setSensorReadout(text) {
    if (!this._sensorReadoutController) return;
    this._sensorReadoutController.object.readout = text;
    this._sensorReadoutController.updateDisplay();
  }

  /**
   * Programmatically set the GPU sensors toggle (e.g. when the GPU backend
   * is disabled at runtime due to an error).
   * @param {boolean} enabled
   */
  updateGpuSensorsToggle(enabled) {
    if (!this._gpuSensorsToggle) return;
    this._gpuSensorsToggle.object.gpuSensors = enabled;
    this._gpuSensorsToggle.updateDisplay();
  }

  // ---- Traffic folder -------------------------------------------------------

  addTrafficFolder({ lodManager, onSpawnNpcs }) {
    this.removeTrafficFolder();
    const folder = this._gui.addFolder('Traffic / V2V');

    const state = {
      promoteN: lodManager.promoteNearestN,
      spawnCount: 50,
    };

    folder
      .add(state, 'promoteN', 0, ConfigDefaults.lod.promoteNearestNMax, 1)
      .name('Promote N NPCs')
      .onChange((v) => lodManager.setPromoteNearestN(v));

    folder.add(state, 'spawnCount', 10, 200, 10).name('Spawn count');
    folder
      .add({ spawn: () => onSpawnNpcs(state.spawnCount) }, 'spawn')
      .name('🚗 Spawn NPCs');

    folder.close();
    this._trafficFolder = folder;
  }

  removeTrafficFolder() {
    if (this._trafficFolder) {
      this._trafficFolder.destroy();
      this._trafficFolder = null;
    }
  }

  // ---- Lifecycle ------------------------------------------------------------

  dispose() {
    this._gui.destroy();
  }
}