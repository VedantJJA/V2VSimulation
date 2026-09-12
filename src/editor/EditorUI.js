const STYLES_ID = 'editor-ui-styles';
const STYLES = `
  .editor-root { position: fixed; inset: 0; z-index: 40; pointer-events: none;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; color: #dfe4ea;
    user-select: none; font-size: 12px; }
  .editor-root > * { pointer-events: auto; }
  .editor-toolbar { position: absolute; top: 12px; left: 12px; display: flex; gap: 4px;
    padding: 6px; background: rgba(16, 19, 24, 0.92); border: 1px solid #2b313a;
    border-radius: 8px; }
  .editor-toolbar .sep { width: 1px; align-self: stretch; background: #2b313a; margin: 0 4px; }
  .editor-btn { padding: 6px 10px; font: inherit; font-size: 12px; color: #dfe4ea;
    background: #1c2027; border: 1px solid #2b313a; border-radius: 5px; cursor: pointer; }
  .editor-btn:hover { background: #262c35; }
  .editor-btn.active { background: #2f5d8a; border-color: #4a90c9; color: #fff; }
  .editor-btn.run { background: #1f5c40; border-color: #2f8a5c; color: #fff; font-weight: 600; }
  .editor-btn.run:hover { background: #256e4d; }
  .editor-panel { position: absolute; top: 62px; left: 12px; width: 252px;
    background: rgba(16, 19, 24, 0.92); border: 1px solid #2b313a; border-radius: 8px;
    padding: 10px 12px; max-height: calc(100vh - 130px); overflow-y: auto; }
  .editor-panel h3 { margin: 12px 0 6px; font-size: 11px; letter-spacing: 0.08em;
    text-transform: uppercase; color: #8b96a5; font-weight: 600; }
  .editor-panel h3:first-child { margin-top: 2px; }
  .editor-panel label { display: block; margin: 6px 0 2px; color: #aab4c0; }
  .editor-panel select, .editor-panel input[type='number'] { width: 100%; box-sizing: border-box;
    padding: 4px 6px; font: inherit; font-size: 12px; color: #dfe4ea; background: #10141a;
    border: 1px solid #2b313a; border-radius: 4px; }
  .editor-panel input[type='range'] { width: 100%; margin: 6px 0; accent-color: #4a90c9; cursor: pointer; }
  .editor-row { display: flex; gap: 8px; }
  .editor-row > label { flex: 1; }
  .editor-row > div { flex: 1; }
  .editor-hint { margin: 8px 0 0; font-size: 11px; line-height: 1.5; color: #6c7784; }
  .editor-check { display: flex; align-items: center; gap: 8px; margin: 8px 0; cursor: pointer; }
  .editor-check input { accent-color: #4a90c9; }
  .editor-spawn { display: flex; align-items: center; gap: 6px; padding: 5px 6px; margin: 3px 0;
    background: #10141a; border: 1px solid #232a33; border-radius: 4px; font-size: 11px; }
  .editor-spawn .meta { flex: 1; color: #aab4c0; }
  .editor-spawn .meta.ego { color: #ff9d7a; }
  .editor-spawn input { accent-color: #4a90c9; }
  .editor-spawn button { padding: 2px 7px; font: inherit; color: #dfe4ea; background: #1c2027;
    border: 1px solid #2b313a; border-radius: 4px; cursor: pointer; }
  .editor-spawn button:hover { background: #3a2b2b; border-color: #7a4545; }
  .editor-status { position: absolute; bottom: 12px; left: 12px; padding: 6px 10px;
    background: rgba(16, 19, 24, 0.9); border: 1px solid #2b313a; border-radius: 6px;
    color: #9fb0c0; max-width: 560px; }
  .editor-file { display: none; }
`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const TOOL_STATUS = {
  road: 'Click on open ground to start a road…',
  building: 'Drag on open ground to place a building — click a building to select it',
  obstruction: 'Click on a road lane to place an obstruction',
  vehicle: 'Click on a lane to place a vehicle spawn',
};

/**
 * EditorUI — the editor's DOM chrome (hand-rolled, distinct from the
 * simulation's lil-gui panel, which stays top-right for environment tweaks):
 *
 * - Toolbar (top-left): tool buttons, Top/Orbit camera presets, and the
 *   session actions Save / Load / Run Simulation.
 * - Side panel (left): per-tool context — segment lane counts (road),
 *   new-building height + gizmo mode (building), blocking mode
 *   (obstruction), ego flag + spawn list (vehicle).
 * - Status line (bottom-left): live hints from the tools.
 *
 * Save downloads RoadSerializer output; Load parses a map file into the
 * editor via MapEditor.loadMap; Run Simulation hands the in-memory
 * serialized map back to main's mode controller.
 */
export class EditorUI {
  /** @param {import('./MapEditor.js').MapEditor} editor */
  constructor(editor) {
    this.editor = editor;

    if (!document.getElementById(STYLES_ID)) {
      const style = el('style');
      style.id = STYLES_ID;
      style.textContent = STYLES;
      document.head.appendChild(style);
    }

    this._root = el('div', 'editor-root');
    document.body.appendChild(this._root);

    this._toolButtons = {};
    this._viewButtons = {};
    this._root.append(this._buildToolbar(), this._buildPanel(), this._buildStatus());

    this._fileInput = el('input', 'editor-file');
    this._fileInput.type = 'file';
    this._fileInput.accept = 'application/json,.json';
    this._fileInput.addEventListener('change', () => this._onLoadFile());
    this._root.appendChild(this._fileInput);
  }

  // ---- chrome ------------------------------------------------------------

  _buildToolbar() {
    const bar = el('div', 'editor-toolbar');

    const tools = [
      ['road', 'Road'],
      ['building', 'Building'],
      ['obstruction', 'Obstruction'],
      ['vehicle', 'Vehicle'],
    ];
    for (const [name, label] of tools) {
      const button = el('button', 'editor-btn', label);
      button.addEventListener('click', () => this.editor.setTool(name));
      this._toolButtons[name] = button;
      bar.append(button);
    }

    bar.append(el('div', 'sep'));

    for (const [name, label] of [
      ['top', 'Top'],
      ['orbit', 'Orbit'],
    ]) {
      const button = el('button', 'editor-btn', label);
      button.addEventListener('click', () => {
        this.editor.setView(name);
        for (const other of Object.values(this._viewButtons)) other.classList.remove('active');
        button.classList.add('active');
      });
      this._viewButtons[name] = button;
      bar.append(button);
    }

    bar.append(el('div', 'sep'));

    const undoButton = el('button', 'editor-btn', '↺ Undo');
    undoButton.title = 'Undo last change (Ctrl+Z)';
    undoButton.addEventListener('click', () => this.editor.undo());
    const saveButton = el('button', 'editor-btn', 'Save');
    saveButton.addEventListener('click', () => this._save());
    const loadButton = el('button', 'editor-btn', 'Load');
    loadButton.addEventListener('click', () => this._fileInput.click());
    const runButton = el('button', 'editor-btn run', 'Run Simulation ▸');
    runButton.addEventListener('click', () => this.editor.runSimulation());

    bar.append(undoButton, saveButton, loadButton, runButton);
    return bar;
  }

  _buildPanel() {
    const panel = el('div', 'editor-panel');

    // ---- Road ---------------------------------------------------------------
    this._roadSection = el('div');
    this._roadSection.append(el('h3', null, 'Road'));

    // Road Drawing Mode (Bézier vs Straight)
    this._roadSection.append(el('label', null, 'Draw Mode'));
    const modeRow = el('div', 'editor-row');
    this._bezierModeBtn = el('button', 'editor-btn active', 'Bézier Curve');
    this._bezierModeBtn.style.flex = '1';
    this._straightModeBtn = el('button', 'editor-btn', 'Straight');
    this._straightModeBtn.style.flex = '1';

    this._bezierModeBtn.addEventListener('click', () => {
      this.editor.tools.road.setMode('bezier');
      this._bezierModeBtn.classList.add('active');
      this._straightModeBtn.classList.remove('active');
    });
    this._straightModeBtn.addEventListener('click', () => {
      this.editor.tools.road.setMode('straight');
      this._straightModeBtn.classList.add('active');
      this._bezierModeBtn.classList.remove('active');
    });
    modeRow.append(this._bezierModeBtn, this._straightModeBtn);
    this._roadSection.appendChild(modeRow);

    this._roadSection.append(el('label', null, 'Selected Segment'));
    this._segmentSelect = el('select');
    this._segmentSelect.addEventListener('change', () => this.editor.selectSegment(this._segmentSelect.value));
    this._roadSection.appendChild(this._segmentSelect);

    // Balanced Lanes Slider (1 to 4 lanes per side)
    const lanesLabel = el('label', null, 'Lanes (per direction)');
    this._lanesValueText = el('span', null, ' (1 lane each side)');
    this._lanesValueText.style.color = '#8b96a5';
    lanesLabel.appendChild(this._lanesValueText);
    this._roadSection.appendChild(lanesLabel);

    this._lanesSlider = el('input');
    this._lanesSlider.type = 'range';
    this._lanesSlider.min = '1';
    this._lanesSlider.max = '4';
    this._lanesSlider.step = '1';
    this._lanesSlider.value = '1';
    this._lanesSlider.addEventListener('input', () => this._applyBalancedLanes());
    this._roadSection.appendChild(this._lanesSlider);

    // Guard Rails Dropdown
    this._roadSection.append(el('label', null, 'Guard Rails'));
    this._guardRailSelect = el('select');
    for (const [val, lbl] of [
      ['none', 'None'],
      ['both', 'Both Edges'],
      ['left', 'Left Edge Only'],
      ['right', 'Right Edge Only'],
    ]) {
      const opt = el('option', null, lbl);
      opt.value = val;
      this._guardRailSelect.appendChild(opt);
    }
    this._guardRailSelect.addEventListener('change', () => {
      const segId = this._segmentSelect.value;
      const mode = this._guardRailSelect.value;
      this.editor.defaultGuardRails = mode;
      if (segId) this.editor.setSegmentGuardRails(segId, mode);
    });
    this._roadSection.appendChild(this._guardRailSelect);

    // Intersection Style Dropdown (Square vs Roundabout)
    this._roadSection.append(el('label', null, 'Intersection Style'));
    this._intersectionTypeSelect = el('select');
    for (const [val, lbl] of [
      ['square', 'Square / Box Junction'],
      ['roundabout', 'Roundabout (Circle)'],
    ]) {
      const opt = el('option', null, lbl);
      opt.value = val;
      this._intersectionTypeSelect.appendChild(opt);
    }
    this._intersectionTypeSelect.addEventListener('change', () => {
      const seg = this.editor.getSelectedSegment();
      const style = this._intersectionTypeSelect.value;
      this.editor.defaultIntersectionType = style;
      if (seg) {
        this.editor.setNodeIntersectionType(seg.startNodeId, style);
        this.editor.setNodeIntersectionType(seg.endNodeId, style);
      }
    });
    this._roadSection.appendChild(this._intersectionTypeSelect);

    this._roadSection.append(el('p', 'editor-hint',
      'Esc / right-click ends a chain. Click near an existing node to connect. 2 roads = continuous bend; 3+ roads = Square or Roundabout junction.'));

    // ---- Building -----------------------------------------------------------
    this._buildingSection = el('div');
    this._buildingSection.append(el('h3', null, 'Building'));
    this._buildingSection.append(el('label', null, 'New building height (m)'));
    const heightInput = el('input');
    heightInput.type = 'number';
    heightInput.min = '2';
    heightInput.max = '80';
    heightInput.step = '1';
    heightInput.value = '12';
    heightInput.addEventListener('change', () => {
      const value = Number(heightInput.value);
      this.editor.tools.building.newBuildingHeightM = Number.isFinite(value) ? value : 12;
    });
    this._buildingSection.appendChild(heightInput);

    this._buildingSection.append(el('label', null, 'Gizmo (W / E / R)'));
    this._gizmoSelect = el('select');
    for (const [value, label] of [['translate', 'Move (W)'], ['rotate', 'Rotate (E)'], ['scale', 'Scale (R)']]) {
      const option = el('option', null, label);
      option.value = value;
      this._gizmoSelect.appendChild(option);
    }
    this._gizmoSelect.addEventListener('change', () => this.editor.gizmoManager.setMode(this._gizmoSelect.value));
    this._buildingSection.appendChild(this._gizmoSelect);

    const deleteBuildingBtn = el('button', 'editor-btn', 'Delete Selected Building');
    deleteBuildingBtn.style.marginTop = '8px';
    deleteBuildingBtn.style.width = '100%';
    deleteBuildingBtn.addEventListener('click', () => {
      const attached = this.editor.gizmoManager.attached;
      if (attached?.userData?.building) {
        this.editor.removeBuilding(attached.userData.building);
      }
    });
    this._buildingSection.appendChild(deleteBuildingBtn);

    this._buildingSection.append(el('p', 'editor-hint',
      'Click or drag on open ground to place. Click a building to select it. Drag gizmo handles or use W: Move, E: Rotate, R: Scale, Del: Delete.'));

    // ---- Obstruction --------------------------------------------------------
    this._obstructionSection = el('div');
    this._obstructionSection.append(el('h3', null, 'Obstruction'));
    this._obstructionSection.append(el('label', null, 'Blocking'));
    const blockingSelect = el('select');
    for (const [value, label] of [['partial', 'Cone (partial)'], ['full', 'Barrier (full)']]) {
      const option = el('option', null, label);
      option.value = value;
      blockingSelect.appendChild(option);
    }
    blockingSelect.addEventListener('change', () => {
      this.editor.tools.obstruction.blocking = blockingSelect.value;
    });
    this._obstructionSection.appendChild(blockingSelect);

    // ---- Vehicle ------------------------------------------------------------
    this._vehicleSection = el('div');
    this._vehicleSection.append(el('h3', null, 'Vehicles'));
    const egoCheckLabel = el('label', 'editor-check');
    this._egoCheckBox = el('input');
    this._egoCheckBox.type = 'checkbox';
    egoCheckLabel.append(this._egoCheckBox, el('span', null, 'place next spawn as ego'));
    this._egoCheckBox.addEventListener('change', () => {
      this.editor.tools.vehicle.placeAsEgo = this._egoCheckBox.checked;
    });
    this._vehicleSection.appendChild(egoCheckLabel);

    this._spawnList = el('div');
    this._vehicleSection.append(this._spawnList, el('p', 'editor-hint',
      'Ego is exclusive — marking a new one demotes the previous. These become live vehicles in Simulation mode.'));

    panel.append(this._roadSection, this._buildingSection, this._obstructionSection, this._vehicleSection);
    return panel;
  }

  _buildStatus() {
    this._status = el('div', 'editor-status', 'Editor ready');
    return this._status;
  }

  // ---- dynamic state ------------------------------------------------------

  setStatus(text) {
    if (this._status) this._status.textContent = text;
  }

  setGizmoMode(mode) {
    if (this._gizmoSelect) {
      this._gizmoSelect.value = mode;
    }
  }

  setActiveTool(name) {
    for (const [toolName, button] of Object.entries(this._toolButtons)) {
      button.classList.toggle('active', toolName === name);
    }
    this._roadSection.style.display = name === 'road' ? '' : 'none';
    this._buildingSection.style.display = name === 'building' ? '' : 'none';
    this._obstructionSection.style.display = name === 'obstruction' ? '' : 'none';
    this._vehicleSection.style.display = name === 'vehicle' ? '' : 'none';
    if (name && TOOL_STATUS[name]) this.setStatus(TOOL_STATUS[name]);
  }

  /** Re-render the segment controls + spawn list from editor state. */
  refresh() {
    this._refreshSegmentControls();
    this._refreshSpawnList();
  }

  _refreshSegmentControls() {
    const ids = this.editor.network ? this.editor.network.segmentIds : [];
    const selected = this.editor.selectedSegmentId;
    this._segmentSelect.replaceChildren();
    for (const id of ids) {
      const option = el('option', null, id);
      option.value = id;
      this._segmentSelect.appendChild(option);
    }
    if (ids.length === 0) {
      const option = el('option', null, '— none —');
      option.value = '';
      this._segmentSelect.appendChild(option);
      this._segmentSelect.value = '';
      this._lanesSlider.disabled = true;
      this._guardRailSelect.disabled = true;
      this._lanesValueText.textContent = '';
      return;
    }
    this._segmentSelect.value = ids.includes(selected) ? selected : ids[0];

    const segment = this.editor.getSelectedSegment();
    this._lanesSlider.disabled = !segment;
    this._guardRailSelect.disabled = !segment;
    this._intersectionTypeSelect.disabled = !segment;
    if (segment) {
      const lanes = Math.max(1, Math.min(4, Math.max(segment.lanesForward, segment.lanesBackward)));
      this._lanesSlider.value = String(lanes);
      this._lanesValueText.textContent = ` (${lanes} lane${lanes > 1 ? 's' : ''} each side · ${lanes * 2} total)`;
      this._guardRailSelect.value = segment.guardRails || 'none';

      const startNode = this.editor.network?.getNode(segment.startNodeId);
      const endNode = this.editor.network?.getNode(segment.endNodeId);
      const style = (endNode?.intersectionType === 'roundabout' || startNode?.intersectionType === 'roundabout')
        ? 'roundabout'
        : 'square';
      this._intersectionTypeSelect.value = style;
    }
  }

  _refreshSpawnList() {
    this._spawnList.replaceChildren();
    const spawns = this.editor.vehicleSpawns;
    if (spawns.length === 0) {
      this._spawnList.append(el('p', 'editor-hint', 'No vehicle spawns yet — click a lane with the Vehicle tool.'));
      return;
    }
    for (const spawn of spawns) {
      const row = el('div', 'editor-spawn');
      const meta = el('span', `meta${spawn.isEgo ? ' ego' : ''}`,
        `${spawn.segmentId} · lane ${spawn.lane} · ${Math.round(spawn.distanceAlongM)} m${spawn.isEgo ? ' · EGO' : ''}`);

      const egoBox = el('input');
      egoBox.type = 'checkbox';
      egoBox.checked = spawn.isEgo;
      egoBox.title = 'mark as ego';
      egoBox.addEventListener('change', () => this.editor.setVehicleSpawnEgo(spawn.id, egoBox.checked));

      const removeButton = el('button', null, '×');
      removeButton.title = 'remove spawn';
      removeButton.addEventListener('click', () => this.editor.removeVehicleSpawn(spawn.id));

      row.append(meta, egoBox, removeButton);
      this._spawnList.appendChild(row);
    }
  }

  _applyBalancedLanes() {
    const segmentId = this._segmentSelect.value;
    if (!segmentId) return;
    const count = Number(this._lanesSlider.value);
    if (!Number.isFinite(count) || count < 1) return;
    this._lanesValueText.textContent = ` (${count} lane${count > 1 ? 's' : ''} each side · ${count * 2} total)`;
    this.editor.setSegmentLanes(segmentId, count, count);
  }

  setLanes(count) {
    if (!Number.isFinite(count) || count < 1) return;
    this._lanesSlider.value = String(count);
    this._lanesValueText.textContent = ` (${count} lane${count > 1 ? 's' : ''} each side · ${count * 2} total)`;
  }

  // ---- session actions ------------------------------------------------------

  _save() {
    try {
      const data = this.editor.serialize();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'road-map.json';
      link.click();
      URL.revokeObjectURL(url);
      this.setStatus('Saved road-map.json');
    } catch (error) {
      console.error('[EditorUI] save failed:', error);
      this.setStatus('Save failed — see console');
    }
  }

  async _onLoadFile() {
    const file = this._fileInput.files?.[0];
    this._fileInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      this.editor.loadMap(data);
      this.setStatus(`Loaded ${file.name}`);
    } catch (error) {
      console.error('[EditorUI] invalid map file:', error);
      this.setStatus('Failed to load map — see console');
    }
  }

  dispose() {
    this._root?.remove();
    this._root = null;
  }
}