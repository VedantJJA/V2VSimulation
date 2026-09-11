import { RoadNetwork } from './RoadNetwork.js';
import { RoadObstruction } from './RoadObstruction.js';

export const MAP_FORMAT = 'road-network';
/**
 * v1: nodes / segments / obstructions.
 * v2: adds the optional `buildings` array.
 * v3: adds the optional `vehicleSpawns` array (Phase 5). Older maps still
 * load — missing keys simply deserialize as empty lists.
 */
export const MAP_FORMAT_VERSION = 3;

/**
 * RoadSerializer — map JSON ⇄ live network + meshes + buildings + spawns.
 *
 * Schema (sample at public/maps/sample.json):
 * {
 *   "format": "road-network", "version": 3, "name": "...",
 *   "nodes":      [ { "id": "n1", "position": [x, y, z] } ],
 *   "segments":   [ { "id": "s1", "startNodeId": "n1", "endNodeId": "n2",
 *                     "controlPoints": [[x,y,z], ...],
 *                     "lanesForward": 1, "lanesBackward": 1,
 *                     "laneWidthM": 3.5, "speedLimitKph": 50 } ],
 *   "obstructions": [ { "id": "o1", "segmentId": "s1", "lane": 0,
 *                       "distanceAlongM": 60, "blocking": "full" } ],
 *   "buildings":  [ { "id": "b1", "position": [x,y,z], "size": [w,d,h],
 *                     "rotationY": 0 } ],
 *   "vehicleSpawns": [ { "id": "spawn-1", "segmentId": "s1", "lane": 0,
 *                        "distanceAlongM": 20, "isEgo": true,
 *                        "targetSpeedMps": 8 } ]
 * }
 *
 * deserialize() rehydrates in dependency order (nodes → segments →
 * intersections → obstructions → buildings → spawns) and returns
 * { network, vehicleSpawns } — spawning real vehicles is the caller's job
 * (the editor renders previews, the simulation session builds Vehicles).
 * Unknown references are warned + skipped, never fatal. Multiple isEgo
 * entries are collapsed to the last one (the "reassign" rule).
 */
export class RoadSerializer {
  /**
   * @param {RoadNetwork} network
   * @param {import('../buildings/BuildingManager.js').BuildingManager} [buildingManager]
   * @param {Array<{ id: string, segmentId: string, lane: number, distanceAlongM: number,
   *                 isEgo?: boolean, targetSpeedMps?: number }>} [vehicleSpawns]
   */
  static serialize(network, buildingManager = null, vehicleSpawns = []) {
    const map = {
      format: MAP_FORMAT,
      version: MAP_FORMAT_VERSION,
      nodes: Array.from(network.nodes.values(), (node) => ({
        id: node.id,
        position: [node.position.x, node.position.y, node.position.z],
      })),
      segments: Array.from(network.segments.values(), (segment) => ({
        id: segment.id,
        startNodeId: segment.startNodeId,
        endNodeId: segment.endNodeId,
        controlPoints: segment.controlPoints.map((p) => [p.x, p.y, p.z]),
        lanesForward: segment.lanesForward,
        lanesBackward: segment.lanesBackward,
        laneWidthM: segment.laneWidthM,
        speedLimitKph: segment.speedLimitKph,
      })),
      obstructions: Array.from(network.segments.values(), (segment) =>
        segment.obstructions.map((obstruction) => obstruction.toJSON())
      ).flat(),
    };

    if (buildingManager) {
      map.buildings = buildingManager.getAll().map((building) => ({
        id: building.id,
        position: [building.position.x, building.position.y, building.position.z],
        size: [...building.size],
        rotationY: building.rotationY,
      }));
    }

    map.vehicleSpawns = (vehicleSpawns ?? []).map((spawn) => ({
      id: spawn.id,
      segmentId: spawn.segmentId,
      lane: spawn.lane,
      distanceAlongM: spawn.distanceAlongM,
      isEgo: !!spawn.isEgo,
      targetSpeedMps: spawn.targetSpeedMps ?? 8,
    }));

    return map;
  }

  /**
   * @param {object} data parsed map JSON
   * @param {object} context
   * @param {RoadNetwork} [context.network] built into when provided, else fresh
   * @param {import('./RoadMeshBuilder.js').RoadMeshBuilder} context.meshBuilder
   * @param {import('./LaneMarkingBuilder.js').LaneMarkingBuilder} context.markingBuilder
   * @param {import('./IntersectionBuilder.js').IntersectionBuilder} [context.intersectionBuilder]
   * @param {import('../core/SceneManager.js').SceneManager} [context.sceneManager] obstruction meshes auto-add
   * @param {import('../buildings/BuildingManager.js').BuildingManager} [context.buildingManager] buildings auto-add
   * @returns {{ network: RoadNetwork, vehicleSpawns: Array<object> }}
   */
  static deserialize(data, context = {}) {
    if (!data || data.format !== MAP_FORMAT) {
      throw new Error(`RoadSerializer: not a "${MAP_FORMAT}" map (got format "${data?.format}")`);
    }
    if (data.version > MAP_FORMAT_VERSION) {
      console.warn(`RoadSerializer: map version ${data.version} is newer than supported ${MAP_FORMAT_VERSION}`);
    }

    const {
      network = new RoadNetwork(),
      meshBuilder,
      markingBuilder,
      intersectionBuilder = null,
      sceneManager = null,
      buildingManager = null,
    } = context;
    if (!meshBuilder || !markingBuilder) {
      throw new TypeError('RoadSerializer.deserialize: requires meshBuilder and markingBuilder');
    }
    if ((data.buildings ?? []).length > 0 && !buildingManager) {
      console.warn('RoadSerializer: map contains buildings but no buildingManager was provided — skipped');
    }

    for (const node of data.nodes ?? []) {
      network.addNode(node.position, node.id);
    }

    for (const seg of data.segments ?? []) {
      const segment = network.addSegment({
        id: seg.id,
        startNodeId: seg.startNodeId,
        endNodeId: seg.endNodeId,
        controlPoints: seg.controlPoints,
        lanesForward: seg.lanesForward,
        lanesBackward: seg.lanesBackward,
        laneWidthM: seg.laneWidthM,
        speedLimitKph: seg.speedLimitKph,
      });
      meshBuilder.build(segment);
      markingBuilder.build(segment);
    }

    if (intersectionBuilder) intersectionBuilder.buildAll(network);

    for (const ob of data.obstructions ?? []) {
      const segment = network.getSegment(ob.segmentId);
      if (!segment) {
        console.warn(`RoadSerializer: obstruction "${ob.id ?? '?'}" references unknown segment "${ob.segmentId}" — skipped`);
        continue;
      }
      new RoadObstruction({
        id: ob.id,
        segment,
        lane: ob.lane,
        distanceAlongM: ob.distanceAlongM,
        blocking: ob.blocking,
        sceneManager,
      });
    }

    if (buildingManager) {
      for (const b of data.buildings ?? []) {
        buildingManager.addBuilding({
          id: b.id,
          position: b.position,
          size: b.size,
          rotationY: b.rotationY ?? 0,
        });
      }
    }

    // Vehicle spawns (v3): plain data for the caller (editor previews /
    // simulation spawn). Ego is exclusive — a later isEgo demotes earlier ones.
    const vehicleSpawns = [];
    for (const spawn of data.vehicleSpawns ?? []) {
      if (!network.getSegment(spawn.segmentId)) {
        console.warn(`RoadSerializer: vehicle spawn "${spawn.id ?? '?'}" references unknown segment "${spawn.segmentId}" — skipped`);
        continue;
      }
      if (spawn.isEgo === true) {
        for (const previous of vehicleSpawns) previous.isEgo = false;
      }
      vehicleSpawns.push({
        id: spawn.id ?? `spawn-${vehicleSpawns.length + 1}`,
        segmentId: spawn.segmentId,
        lane: spawn.lane ?? 0,
        distanceAlongM: spawn.distanceAlongM ?? 0,
        isEgo: spawn.isEgo === true,
        targetSpeedMps: spawn.targetSpeedMps ?? 8,
      });
    }

    return { network, vehicleSpawns };
  }
}