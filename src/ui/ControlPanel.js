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
    this._cameraFolder = null;
    this._cameraCleanup = null;
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
          intersectionBuilder.rebuildAtNode(network, nodeId);
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

  addSensorsFolder({ visualizer, frontCamera, autoDrive = null }) {
    this.removeSensorsFolder();
    const folder = this._gui.addFolder('Sensors');

    // Auto-drive toggle (at the top for prominence)
    if (autoDrive) {
      const adState = { autoDrive: false };
      this._autoDriveToggle = folder.add(adState, 'autoDrive').name('🤖 Auto Drive [T / 🎮Y]').onChange((v) => {
        autoDrive.onToggle(v);
      });
    }

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

    // Sensor & Telemetry Readout (10 Hz update from main.js)
    const readoutState = { readout: 'Initializing sensors...' };
    this._sensorReadoutController = folder.add(readoutState, 'readout').name('Telemetry').listen().disable();

    folder.open();
    this._sensorsFolder = folder;
  }

  removeSensorsFolder() {
    if (this._sensorsFolder) {
      this._sensorsFolder.destroy();
      this._sensorsFolder = null;
      this._sensorReadoutController = null;
      this._gpuSensorsToggle = null;
      this._autoDriveToggle = null;
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

  /**
   * Programmatically set the auto-drive toggle (e.g. when auto-drive
   * disengages on arrival, or is toggled by hotkey).
   * @param {boolean} enabled
   */
  updateAutoDriveToggle(enabled) {
    if (!this._autoDriveToggle) return;
    this._autoDriveToggle.object.autoDrive = enabled;
    this._autoDriveToggle.updateDisplay();
  }

  // ---- Traffic folder -------------------------------------------------------

  addTrafficFolder({
    lodManager,
    onSpawnNpcs,
    onAddCarAhead = null,
    onAddOncomingCar = null,
    onAddStoppedCar = null,
    onClearTraffic = null,
  }) {
    this.removeTrafficFolder();
    const folder = this._gui.addFolder('Traffic / V2V');

    const state = {
      promoteN: lodManager.promoteNearestN,
      spawnCount: 50,
    };

    if (onAddCarAhead) {
      folder.add({ addAhead: () => onAddCarAhead() }, 'addAhead').name('🚗 + Add Car Ahead [C]');
    }
    if (onAddOncomingCar) {
      folder.add({ addOncoming: () => onAddOncomingCar() }, 'addOncoming').name('⚠️ + Oncoming Car [O]');
    }
    if (onAddStoppedCar) {
      folder.add({ addStopped: () => onAddStoppedCar() }, 'addStopped').name('🛑 + Stopped Car Ahead');
    }

    folder
      .add(state, 'promoteN', 0, ConfigDefaults.lod.promoteNearestNMax, 1)
      .name('Promote N NPCs')
      .onChange((v) => lodManager.setPromoteNearestN(v));

    folder.add(state, 'spawnCount', 10, 200, 10).name('Traffic batch count');
    folder
      .add({ spawn: () => onSpawnNpcs(state.spawnCount) }, 'spawn')
      .name('🚗 Spawn Traffic Batch');

    if (onClearTraffic) {
      folder.add({ clear: () => onClearTraffic() }, 'clear').name('🧹 Clear All Traffic [X]');
    }

    folder.open();
    this._trafficFolder = folder;
  }

  removeTrafficFolder() {
    if (this._trafficFolder) {
      this._trafficFolder.destroy();
      this._trafficFolder = null;
    }
  }

  // ---- Camera folder --------------------------------------------------------

  addCameraFolder({ cameraRig }) {
    this.removeCameraFolder();
    const folder = this._gui.addFolder('Camera View');
    const state = {
      view: cameraRig.mode === 'first' ? 'Cockpit' : '3rd Person',
    };
    const ctrl = folder
      .add(state, 'view', ['3rd Person', 'Cockpit'])
      .name('View Mode')
      .onChange((v) => {
        cameraRig.setMode(v === 'Cockpit' ? 'first' : 'third');
      });

    const onModeChanged = ({ mode }) => {
      state.view = mode === 'first' ? 'Cockpit' : '3rd Person';
      ctrl.updateDisplay();
    };
    this._bus?.on('camera:mode-changed', onModeChanged);
    folder.open();
    this._cameraFolder = folder;
    this._cameraCleanup = () => {
      this._bus?.off('camera:mode-changed', onModeChanged);
    };
  }

  removeCameraFolder() {
    this._cameraCleanup?.();
    this._cameraCleanup = null;
    if (this._cameraFolder) {
      this._cameraFolder.destroy();
      this._cameraFolder = null;
    }
  }

  // ---- Lifecycle ------------------------------------------------------------

  dispose() {
    this.removeCameraFolder();
    this._gui.destroy();
  }
}