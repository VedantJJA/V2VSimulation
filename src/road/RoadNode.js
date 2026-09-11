import * as THREE from 'three';

/**
 * RoadNode — a point where segments meet.
 *
 * Pure data: { id, position }. Intersections emerge when 2+ segments
 * reference the same node (RoadNetwork.addSegment snaps endpoints to
 * nearby nodes). No rendering, no logic.
 */
export class RoadNode {
  /**
   * @param {object} options
   * @param {string} options.id
   * @param {THREE.Vector3 | number[]} options.position
   */
  constructor({ id, position }) {
    if (!id) throw new TypeError('RoadNode: id is required');
    this.id = id;
    this.position = position.isVector3
      ? position.clone()
      : new THREE.Vector3(position[0], position[1] ?? 0, position[2] ?? 0);
  }
}