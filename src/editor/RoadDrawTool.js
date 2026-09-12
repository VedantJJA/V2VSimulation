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
const BEZIER_APEX_HINT = 'Bézier mode: Click to place curve apex (or click target junction directly)';
const BEZIER_END_HINT = 'Bézier mode: Click to place end node (snaps to junction) — Esc cancels curve';
const SNAP_HINT = ' → snaps to the highlighted node';

/**
 * RoadDrawTool — chain drawing for straight roads and Bézier curves.
 *
 * In 'bezier' mode:
 * - Click 1: Places/selects start node.
 * - Click 2: Places intermediate curve control apex (or connects straight if clicking a node).
 * - Click 3: Places/selects end node, creating a smooth curved road segment.
 *
 * In 'straight' mode:
 * - Click 1: Places/selects start node.
 * - Click 2: Places/selects end node.
 */
export class RoadDrawTool {
  constructor(editor) {
    this.editor = editor;
    this._chainNode = null;
    this._controlPoint = null;
    this._mode = 'bezier'; // 'bezier' | 'straight'
    this._inScene = false;

    this._previewLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      PREVIEW_LINE_MATERIAL
    );
    this._previewLine.name = 'editor:road-preview';
    this._previewLine.visible = false;
    this._previewLine.frustumCulled = false;

    this._snapMarkerMaterial = new THREE.MeshBasicMaterial({
      color: 0x4ac9ff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._snapMarker = new THREE.Mesh(SNAP_MARKER_GEOMETRY, this._snapMarkerMaterial);
    this._snapMarker.name = 'editor:node-snap-marker';
    this._snapMarker.visible = false;
  }

  get mode() {
    return this._mode;
  }

  setMode(mode) {
    if (this._mode === mode) return;
    this._mode = mode;
    this._controlPoint = null;
    if (this._chainNode) {
      this.editor.ui.setStatus(this._mode === 'bezier' ? BEZIER_APEX_HINT : EXTEND_HINT);
    }
  }

  onEnable() {
    this._addToScene();
    this.editor.ui.setStatus(
      this._chainNode
        ? (this._mode === 'bezier' ? BEZIER_APEX_HINT : EXTEND_HINT)
        : START_HINT
    );
  }

  onDisable() {
    this._removeFromScene();
    this._chainNode = null;
    this._controlPoint = null;
  }

  _applyAngleSnap(origin, point) {
    const dx = point.x - origin.x;
    const dz = point.z - origin.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-4) return point;

    const angle = Math.atan2(dz, dx);
    const snapStep = Math.PI / 12; // 15 degrees
    const snappedAngle = Math.round(angle / snapStep) * snapStep;

    return new THREE.Vector3(
      origin.x + distance * Math.cos(snappedAngle),
      point.y,
      origin.z + distance * Math.sin(snappedAngle)
    );
  }

  onPointerDown(event, point) {
    if (!point || !this.editor.network) return;

    let targetPoint = point;
    const snapOrigin = this._controlPoint || (this._chainNode ? this._chainNode.position : null);
    if (snapOrigin && event.shiftKey) {
      targetPoint = this._applyAngleSnap(snapOrigin, point);
    }

    const snapped = this.editor.findNodeNear(targetPoint);

    // Step 1: Place start node
    if (!this._chainNode) {
      if (snapped && !this.editor.network.canConnectNode(snapped.id)) {
        this.editor.ui.setStatus('Cannot start road from junction at maximum capacity (4 roads)');
        return;
      }
      const node = snapped ?? this.editor.network.addNode(targetPoint);
      this._chainNode = node;
      this._controlPoint = null;
      if (node) {
        const segs = this.editor.network.getSegmentsAtNode(node.id);
        if (segs.length > 0) {
          const last = segs[segs.length - 1];
          this.editor.ui.setLanes(last.lanesForward);
        }
      }
      this.editor.ui.setStatus(
        this._mode === 'bezier'
          ? BEZIER_APEX_HINT + ' (Hold Shift to snap angles)'
          : EXTEND_HINT + ' (Hold Shift to snap angles)'
      );
      this._updatePreview(targetPoint);
      return;
    }

    // Step 2 in Bézier mode: Place curve apex (or connect directly if clicked existing node)
    if (this._mode === 'bezier' && !this._controlPoint) {
      if (snapped && snapped !== this._chainNode) {
        // Direct click on another node in Bézier mode: create straight segment
        if (!this.editor.network.canConnectNode(snapped.id)) {
          this.editor.ui.setStatus('Cannot connect: junction at maximum capacity (4 roads)');
          return;
        }
        if (!this.editor.network.canConnectNode(this._chainNode.id)) {
          this.editor.ui.setStatus('Current junction reached maximum capacity (4 roads)');
          this._chainNode = null;
          this._previewLine.visible = false;
          return;
        }
        this.editor.createRoadSegment(this._chainNode.position, snapped.position, []);
        this._chainNode = snapped;
        this._controlPoint = null;
        this.editor.ui.setStatus(BEZIER_APEX_HINT);
        this._updatePreview(targetPoint);
        return;
      }

      // Open point placed as curve control point
      this._controlPoint = targetPoint.clone();
      this.editor.ui.setStatus(BEZIER_END_HINT + ' (Hold Shift to snap angles)');
      this._updatePreview(targetPoint);
      return;
    }

    // Step 3 (or Step 2 in straight mode): Place end node and create road segment
    if (snapped && !this.editor.network.canConnectNode(snapped.id)) {
      this.editor.ui.setStatus('Cannot connect: junction at maximum capacity (4 roads)');
      return;
    }
    if (!this.editor.network.canConnectNode(this._chainNode.id)) {
      this.editor.ui.setStatus('Current junction reached maximum capacity (4 roads)');
      this._chainNode = null;
      this._controlPoint = null;
      this._previewLine.visible = false;
      return;
    }

    const node = snapped ?? this.editor.network.addNode(targetPoint);
    if (node !== this._chainNode) {
      const controlPoints = (this._mode === 'bezier' && this._controlPoint) ? [this._controlPoint] : [];
      this.editor.createRoadSegment(this._chainNode.position, node.position, controlPoints);
      this._chainNode = node;
      this._controlPoint = null;
      this.editor.ui.setStatus(
        this._mode === 'bezier'
          ? BEZIER_APEX_HINT + ' (Hold Shift to snap angles)'
          : EXTEND_HINT + ' (Hold Shift to snap angles)'
      );
    }
    this._updatePreview(targetPoint);
  }

  onPointerMove(event, point) {
    if (point) {
      let targetPoint = point;
      const snapOrigin = this._controlPoint || (this._chainNode ? this._chainNode.position : null);
      if (snapOrigin && event.shiftKey) {
        targetPoint = this._applyAngleSnap(snapOrigin, point);
      }
      const near = this.editor.findNodeNear(targetPoint);
      if (near) {
        const canConnect = this.editor.network.canConnectNode(near.id);
        this._snapMarker.position.set(near.position.x, 0.25, near.position.z);
        this._snapMarkerMaterial.color.setHex(canConnect ? 0x4ac9ff : 0xff4a4a);
        this._snapMarker.visible = true;
        if (!canConnect) {
          this.editor.ui.setStatus('Junction at max capacity (4 roads)');
        } else {
          this.editor.ui.setStatus(
            this._chainNode
              ? (this._controlPoint ? BEZIER_END_HINT : EXTEND_HINT) + SNAP_HINT
              : START_HINT + SNAP_HINT
          );
        }
      } else {
        this._snapMarker.visible = false;
        if (this._chainNode) {
          const baseHint = this._mode === 'bezier'
            ? (this._controlPoint ? BEZIER_END_HINT : BEZIER_APEX_HINT)
            : EXTEND_HINT;
          this.editor.ui.setStatus(
            event.shiftKey
              ? 'Angle snap 15° active — ' + baseHint
              : baseHint + ' (Hold Shift to snap angles)'
          );
        }
      }
      this._updatePreview(targetPoint);
    }
  }

  onCancel() {
    if (this._controlPoint) {
      this._controlPoint = null;
      this.editor.ui.setStatus(BEZIER_APEX_HINT);
      this._updatePreview(this._chainNode.position);
    } else {
      this._chainNode = null;
      this._previewLine.visible = false;
      this.editor.ui.setStatus(START_HINT);
    }
  }

  _updatePreview(point) {
    if (!this._chainNode || !point) return;

    if (this._mode === 'bezier' && this._controlPoint) {
      // Quadratic Bézier curve live preview with 24 samples
      const p0 = this._chainNode.position;
      const p1 = this._controlPoint;
      const p2 = point;
      const curvePoints = [];
      const samples = 24;

      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const it = 1 - t;
        curvePoints.push(new THREE.Vector3(
          it * it * p0.x + 2 * it * t * p1.x + t * t * p2.x,
          0.3,
          it * it * p0.z + 2 * it * t * p1.z + t * t * p2.z
        ));
      }
      this._previewLine.geometry.setFromPoints(curvePoints);
      this._previewLine.visible = true;
    } else {
      // Straight line preview
      const a = this._chainNode.position;
      this._previewLine.geometry.setFromPoints([
        new THREE.Vector3(a.x, 0.3, a.z),
        new THREE.Vector3(point.x, 0.3, point.z),
      ]);
      this._previewLine.visible = true;
    }
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