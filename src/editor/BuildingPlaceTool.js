import * as THREE from 'three';

const DRAG_PREVIEW_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x8a93a5,
  transparent: true,
  opacity: 0.45,
});
const PREVIEW_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
const MIN_FOOTPRINT_M = 2;
const MIN_HEIGHT_M = 2;

const PLACE_HINT = 'Click or drag on open ground to place a building — click an existing building to select it';
const SELECTED_HINT =
  'Building selected — drag gizmo handles or press W (Move) / E (Rotate) / R (Scale). Press Delete to remove.';

/**
 * BuildingPlaceTool — click or drag placement + selection.
 *
 * Click or drag on open ground: places a building (drag shapes the footprint).
 * Click an existing building: selects it and attaches the gizmo.
 * When a building is selected, clicking open ground deselects it without placing.
 */
export class BuildingPlaceTool {
  constructor(editor) {
    this.editor = editor;
    /** Height for the NEXT placed building (wired to the panel input). */
    this.newBuildingHeightM = 12;
    this._dragStart = null;
    this._inScene = false;
    this._wasDeselecting = false;

    this._previewMesh = new THREE.Mesh(PREVIEW_BOX_GEOMETRY, DRAG_PREVIEW_MATERIAL);
    this._previewMesh.name = 'editor:building-preview';
    this._previewMesh.visible = false;
    this._previewMesh.frustumCulled = false;
  }

  onEnable() {
    this._addToScene();
    this.editor.ui.setStatus(PLACE_HINT);
  }

  onDisable() {
    this._removeFromScene();
    this._dragStart = null;
    this._previewMesh.visible = false;
  }

  onPointerDown(event, point) {
    if (!point) return;

    const building = this.editor.pickBuilding(event);
    if (building) {
      this.editor.selectBuilding(building);
      this.editor.ui.setStatus(SELECTED_HINT);
      this._dragStart = null;
      this._wasDeselecting = false;
      return;
    }

    const hadSelection = !!this.editor.gizmoManager.attached;
    if (hadSelection) {
      this.editor.deselectBuilding();
      this.editor.ui.setStatus(PLACE_HINT);
      this._wasDeselecting = true;
    } else {
      this._wasDeselecting = false;
    }

    this._dragStart = point.clone();
  }

  onPointerMove(event, point) {
    if (!this._dragStart || !point) return;
    const dist = Math.hypot(point.x - this._dragStart.x, point.z - this._dragStart.z);
    if (dist > 1.5) {
      this._wasDeselecting = false;
      this._updatePreview(point);
    }
  }

  onPointerUp(event, point) {
    if (!this._dragStart || !point) {
      this._dragStart = null;
      this._previewMesh.visible = false;
      return;
    }
    const dist = Math.hypot(point.x - this._dragStart.x, point.z - this._dragStart.z);
    const wasDeselect = this._wasDeselecting && dist < 1.5;
    const start = this._dragStart;
    this._dragStart = null;
    this._previewMesh.visible = false;

    if (wasDeselect) return;

    let width, depth, center;
    if (dist < 1.5) {
      // Single click placement: default 10m x 10m footprint
      width = 10;
      depth = 10;
      center = start;
    } else {
      const fp = this._footprint(start, point);
      width = fp.size[0];
      depth = fp.size[1];
      center = fp.center;
    }

    const height = Math.max(MIN_HEIGHT_M, this.newBuildingHeightM);
    const building = this.editor.addBuilding({
      position: [center.x, 0, center.z],
      size: [width, depth, height],
      rotationY: 0,
    });
    if (building) this.editor.ui.setStatus(SELECTED_HINT);
  }

  onCancel() {
    this._dragStart = null;
    this._previewMesh.visible = false;
    this.editor.ui.setStatus(PLACE_HINT);
  }

  _updatePreview(point) {
    const { center, size } = this._footprint(this._dragStart, point);
    const height = Math.max(MIN_HEIGHT_M, this.newBuildingHeightM);
    this._previewMesh.visible = true;
    this._previewMesh.scale.set(size[0], height, size[1]);
    this._previewMesh.position.set(center.x, height / 2, center.z);
  }

  /** Axis-aligned footprint from the drag: { center, size: [w, d] }. */
  _footprint(a, b) {
    const width = Math.max(MIN_FOOTPRINT_M, Math.abs(b.x - a.x));
    const depth = Math.max(MIN_FOOTPRINT_M, Math.abs(b.z - a.z));
    const center = new THREE.Vector3((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
    return { center, size: [width, depth] };
  }

  _addToScene() {
    if (this._inScene) return;
    this.editor.sceneManager.add(this._previewMesh);
    this._inScene = true;
  }

  _removeFromScene() {
    if (!this._inScene) return;
    this.editor.sceneManager.remove(this._previewMesh);
    this._inScene = false;
  }
}