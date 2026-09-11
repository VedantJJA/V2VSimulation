import * as THREE from 'three';

const DRAG_PREVIEW_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x8a93a5,
  transparent: true,
  opacity: 0.45,
});
const PREVIEW_BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
const MIN_FOOTPRINT_M = 2;
const MIN_HEIGHT_M = 2;

const PLACE_HINT = 'Drag on open ground to place a building — click a building to select it';
const SELECTED_HINT =
  'Building selected — pick Move/Rotate/Scale in the panel, drag the handles; collision checks run on release';

/**
 * BuildingPlaceTool — click-drag placement + selection.
 *
 * Drag on open ground: the drag rectangle becomes the axis-aligned footprint
 * (height from the panel). Click an existing building instead: selects it and
 * attaches the gizmo; the gizmo's commit path (MapEditor._commitGizmo) syncs
 * the transform into Building data and runs CollisionResolver validation.
 */
export class BuildingPlaceTool {
  constructor(editor) {
    this.editor = editor;
    /** Height for the NEXT placed building (wired to the panel input). */
    this.newBuildingHeightM = 12;
    this._dragStart = null;
    this._inScene = false;

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
  }

  onPointerDown(event, point) {
    if (!point) return;

    const building = this.editor.pickBuilding(event);
    if (building) {
      this.editor.selectBuilding(building);
      this.editor.ui.setStatus(SELECTED_HINT);
      return;
    }

    this.editor.deselectBuilding();
    this._dragStart = point.clone();
    this._updatePreview(point);
  }

  onPointerMove(event, point) {
    if (!this._dragStart || !point) return;
    this._updatePreview(point);
  }

  onPointerUp(event, point) {
    if (!this._dragStart || !point) {
      this._dragStart = null;
      this._previewMesh.visible = false;
      return;
    }
    const { center, size } = this._footprint(this._dragStart, point);
    this._dragStart = null;
    this._previewMesh.visible = false;

    const height = Math.max(MIN_HEIGHT_M, this.newBuildingHeightM);
    const building = this.editor.addBuilding({
      position: [center.x, 0, center.z],
      size: [size[0], size[1], height],
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