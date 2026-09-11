import * as THREE from 'three';

const PREVIEW_LINE_MATERIAL = new THREE.LineBasicMaterial({ color: 0xffd24a });
const SNAP_MARKER_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0x4ac9ff,
  transparent: true,
  opacity: 0.85,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const SNAP_MARKER_GEOMETRY = new THREE.RingGeometry(1.6, 2.3, 24);
SNAP_MARKER_GEOMETRY.rotateX(-Math.PI / 2);

const START_HINT = 'Click on open ground to start a road…';
const EXTEND_HINT = 'Click to extend the road — Esc or right-click to finish the chain';
const SNAP_HINT = ' → snaps to the highlighted node';

/**
 * RoadDrawTool — chain drawing for roads.
 *
 * Click 1 places the start node. Each further click creates a segment from
 * the previous node to the clicked point and continues the chain from there
 * (so a polyline of clicks = a chain of connected segments). Clicking near
 * an EXISTING node reuses it (RoadNetwork node-snapping) — that's how
 * intersections form; the snap ring highlights the candidate. Esc or a
 * right-click (without an orbit drag) finishes the chain.
 *
 * Straight segments only (two-point control polylines); curved control
 * points are a later upgrade — RoadSegment already supports them.
 */
export class RoadDrawTool {
  constructor(editor) {
    this.editor = editor;
    this._chainNode = null;
    this._inScene = false;

    this._previewLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      PREVIEW_LINE_MATERIAL
    );
    this._previewLine.name = 'editor:road-preview';
    this._previewLine.visible = false;
    this._previewLine.frustumCulled = false;

    this._snapMarker = new THREE.Mesh(SNAP_MARKER_GEOMETRY, SNAP_MARKER_MATERIAL);
    this._snapMarker.name = 'editor:node-snap-marker';
    this._snapMarker.visible = false;
  }

  onEnable() {
    this._addToScene();
    this.editor.ui.setStatus(this._chainNode ? EXTEND_HINT : START_HINT);
  }

  onDisable() {
    this._removeFromScene();
    this._chainNode = null;
  }

  onPointerDown(event, point) {
    if (!point || !this.editor.network) return;
    const snapped = this.editor.findNodeNear(point);
    const node = snapped ?? this.editor.network.addNode(point);

    if (!this._chainNode) {
      this._chainNode = node;
      this.editor.ui.setStatus(EXTEND_HINT);
    } else if (node !== this._chainNode) {
      // addSegment snaps both endpoints to existing nodes — shared nodes
      // become intersections, with pads handled by IntersectionBuilder.
      this.editor.createRoadSegment(this._chainNode.position, node.position);
      this._chainNode = node; // keep drawing from the new end
      this.editor.ui.setStatus(EXTEND_HINT);
    }
    this._updatePreview(point);
  }

  onPointerMove(event, point) {
    if (point) {
      const near = this.editor.findNodeNear(point);
      if (near) {
        this._snapMarker.position.set(near.position.x, 0.25, near.position.z);
        this._snapMarker.visible = true;
      } else {
        this._snapMarker.visible = false;
      }
    }
    this._updatePreview(point);
  }

  onCancel() {
    this._chainNode = null;
    this._previewLine.visible = false;
    this.editor.ui.setStatus(START_HINT);
  }

  _updatePreview(point) {
    if (!this._chainNode || !point) return;
    const a = this._chainNode.position;
    this._previewLine.geometry.setFromPoints([
      new THREE.Vector3(a.x, 0.3, a.z),
      new THREE.Vector3(point.x, 0.3, point.z),
    ]);
    this._previewLine.visible = true;
  }

  _addToScene() {
    if (this._inScene) return;
    this.editor.sceneManager.add(this._previewLine, this._snapMarker);
    this._inScene = true;
  }

  _removeFromScene() {
    if (!this._inScene) return;
    this.editor.sceneManager.remove(this._previewLine, this._snapMarker);
    this._inScene = false;
  }
}