import * as THREE from 'three';

const GHOST_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xff7a1a,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
});
const CONE_GHOST_GEOMETRY = new THREE.ConeGeometry(0.55, 0.9, 12);
const BARRIER_GHOST_GEOMETRY = new THREE.BoxGeometry(3.15, 1.0, 2.4);

const HINT = 'Click on a road lane to place an obstruction (Cone = partial, Barrier = full)';
const MISS_HINT = 'That click missed the road — aim for the asphalt';

/**
 * ObstructionPlaceTool — click a point on a lane to drop an obstruction.
 * Blocking mode (partial cone / full barrier) is chosen in the side panel.
 * The click is projected onto the segment (lane + distance along), so the
 * placed prop lands exactly like a serialized one.
 */
export class ObstructionPlaceTool {
  constructor(editor) {
    this.editor = editor;
    /** 'partial' | 'full' — wired to the panel select. */
    this.blocking = 'partial';
    this._inScene = false;

    this._coneGhost = new THREE.Mesh(CONE_GHOST_GEOMETRY, GHOST_MATERIAL);
    this._barrierGhost = new THREE.Mesh(BARRIER_GHOST_GEOMETRY, GHOST_MATERIAL);
    for (const ghost of [this._coneGhost, this._barrierGhost]) {
      ghost.name = 'editor:obstruction-ghost';
      ghost.visible = false;
      ghost.frustumCulled = false;
    }
  }

  onEnable() {
    this._addToScene();
    this.editor.ui.setStatus(HINT);
  }

  onDisable() {
    this._removeFromScene();
  }

  onPointerMove(event, point) {
    this._showGhost(this.editor.pickRoad(event));
  }

  onPointerDown(event, point) {
    const pick = this.editor.pickRoad(event);
    if (!pick) {
      this.editor.ui.setStatus(MISS_HINT);
      this._hideGhosts();
      return;
    }
    this.editor.ui.setStatus(HINT);
    this.editor.addObstruction({
      segmentId: pick.segment.id,
      lane: pick.lane,
      distanceAlongM: pick.distanceAlongM,
      blocking: this.blocking,
    });
    this._hideGhosts();
  }

  _showGhost(pick) {
    this._hideGhosts();
    if (!pick) return;
    const ghost = this.blocking === 'full' ? this._barrierGhost : this._coneGhost;
    const halfHeight = this.blocking === 'full' ? 0.5 : 0.45;
    ghost.position.set(pick.point.x, pick.point.y + halfHeight, pick.point.z);
    ghost.rotation.y = -pick.headingRad;
    ghost.visible = true;
  }

  _hideGhosts() {
    this._coneGhost.visible = false;
    this._barrierGhost.visible = false;
  }

  _addToScene() {
    if (this._inScene) return;
    this.editor.sceneManager.add(this._coneGhost, this._barrierGhost);
    this._inScene = true;
  }

  _removeFromScene() {
    if (!this._inScene) return;
    this.editor.sceneManager.remove(this._coneGhost, this._barrierGhost);
    this._inScene = false;
  }
}