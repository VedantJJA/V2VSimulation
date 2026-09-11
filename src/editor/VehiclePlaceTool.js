import * as THREE from 'three';

const GHOST_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x4a90c9,
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
});
const GHOST_GEOMETRY = new THREE.BoxGeometry(1.7, 0.7, 4.0);

const HINT = 'Click on a lane to place a vehicle — tick "place as ego" first for the player car';
const MISS_HINT = 'That click missed the road — aim for a lane';
const EGO_PLACED_HINT = 'Ego spawn placed (previous ego, if any, was demoted to an NPC)';

/**
 * VehiclePlaceTool — click a point on a lane to add a vehicle SPAWN.
 * Spawns are editor data (previews), not live vehicles: the simulation
 * session turns them into a real EgoVehicle/NPCVehicle at the same
 * (segment, lane, distance) parameters.
 *
 * The ego flag is exclusive — placing or ticking a new ego demotes any
 * previous one (MapEditor enforces the reassignment).
 */
export class VehiclePlaceTool {
  constructor(editor) {
    this.editor = editor;
    /** Wired to the panel checkbox. */
    this.placeAsEgo = false;
    this._inScene = false;

    this._ghost = new THREE.Mesh(GHOST_GEOMETRY, GHOST_MATERIAL);
    this._ghost.name = 'editor:vehicle-ghost';
    this._ghost.visible = false;
    this._ghost.frustumCulled = false;
  }

  onEnable() {
    this._addToScene();
    this.editor.ui.setStatus(HINT);
  }

  onDisable() {
    this._removeFromScene();
  }

  onPointerMove(event, point) {
    const pick = this.editor.pickRoad(event);
    if (!pick) {
      this._ghost.visible = false;
      return;
    }
    this._ghost.visible = true;
    this._ghost.position.set(pick.point.x, pick.point.y + 0.35, pick.point.z);
    this._ghost.rotation.y = -pick.headingRad;
  }

  onPointerDown(event, point) {
    const pick = this.editor.pickRoad(event);
    if (!pick) {
      this.editor.ui.setStatus(MISS_HINT);
      return;
    }
    const spawn = this.editor.addVehicleSpawn({
      segmentId: pick.segment.id,
      lane: pick.lane,
      distanceAlongM: pick.distanceAlongM,
      isEgo: this.placeAsEgo,
    });
    if (spawn?.isEgo) this.editor.ui.setStatus(EGO_PLACED_HINT);
  }

  _addToScene() {
    if (this._inScene) return;
    this.editor.sceneManager.add(this._ghost);
    this._inScene = true;
  }

  _removeFromScene() {
    if (!this._inScene) return;
    this.editor.sceneManager.remove(this._ghost);
    this._inScene = false;
  }
}