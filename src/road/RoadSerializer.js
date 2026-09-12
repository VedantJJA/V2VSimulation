import { RoadNetwork, RoadObstruction } from './RoadNetwork.js';

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
        intersectionType: node.intersectionType ?? 'square',
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
        guardRails: segment.guardRails ?? 'none',
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
   * @param {import('./GuardRailBuilder.js').GuardRailBuilder} [context.guardRailBuilder]
   * @param {import('../core/SceneManager.js').SceneManager} [context.sceneManager] obstruction meshes auto-add
   * @param {import('../buildings/BuildingManager.js').BuildingManager} [context.buildingManager] buildings auto-add
   * @returns {{ network: RoadNetwork, vehicleSpawns: Array<object> }}
   */
  static deserialize(
    data,
    {
      network = new RoadNetwork(),
      meshBuilder,
      markingBuilder,
      intersectionBuilder = null,
      guardRailBuilder = null,
      laneMergerBuilder = null,
      sceneManager = null,
      buildingManager = null,
    } = {}
  ) {
    if (!data || data.format !== MAP_FORMAT) {
      throw new Error(`RoadSerializer: unrecognized map format "${data?.format}"`);
    }
    if ((data.version ?? 0) > MAP_FORMAT_VERSION) {
      console.warn(`RoadSerializer: map version ${data.version} > supported ${MAP_FORMAT_VERSION} — loading anyway`);
    }
    if ((data.buildings ?? []).length > 0 && !buildingManager) {
      console.warn('RoadSerializer: map contains buildings but no buildingManager was provided — skipped');
    }
    if (!meshBuilder || !markingBuilder) {
      throw new TypeError('RoadSerializer.deserialize: requires meshBuilder and markingBuilder');
    }

    for (const node of data.nodes ?? []) {
      network.addNode(node.position, node.id, node.intersectionType ?? 'square');
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
        guardRails: seg.guardRails ?? 'none',
      });
      meshBuilder.build(segment);
      markingBuilder.build(segment);
      if (guardRailBuilder) guardRailBuilder.build(segment);
      if (laneMergerBuilder) RoadSerializer._updateMerger(segment, network, laneMergerBuilder);
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

  static _updateMerger(segment, network, laneMergerBuilder) {
    if (!laneMergerBuilder || !network) return;
    const startNode = network.getNode(segment.startNodeId);
    const endNode = network.getNode(segment.endNodeId);
    const startTotalSegs = network.getSegmentsAtNode(segment.startNodeId);
    const endTotalSegs = network.getSegmentsAtNode(segment.endNodeId);

    // Merging ONLY happens when the junction has MORE than two roads!
    const startHasJunction = startTotalSegs.length > 2;
    const endHasJunction = endTotalSegs.length > 2;

    if (!startHasJunction && !endHasJunction) {
      laneMergerBuilder.dispose(segment.id);
      return;
    }

    let minStartFwd = segment.lanesForward;
    if (startHasJunction) {
      for (const s of startTotalSegs) {
        if (s.id !== segment.id) minStartFwd = Math.min(minStartFwd, s.lanesForward);
      }
      if (startNode?.intersectionType === 'roundabout' && segment.lanesBackward > 1) {
        minStartFwd = Math.min(minStartFwd, 1);
      }
    }

    let minEndFwd = segment.lanesForward;
    if (endHasJunction) {
      for (const s of endTotalSegs) {
        if (s.id !== segment.id) minEndFwd = Math.min(minEndFwd, s.lanesForward);
      }
      if (endNode?.intersectionType === 'roundabout' && segment.lanesForward > 1) {
        minEndFwd = Math.min(minEndFwd, 1);
      }
    }

    if (endHasJunction && minEndFwd < segment.lanesForward) {
      laneMergerBuilder.buildForSegment(segment, {
        taperEnd: 'end',
        side: 'both',
        originalWidthM: segment.halfWidthForwardM,
        targetWidthM: minEndFwd * segment.laneWidthM,
      });
    } else if (startHasJunction && minStartFwd < segment.lanesBackward) {
      laneMergerBuilder.buildForSegment(segment, {
        taperEnd: 'start',
        side: 'both',
        originalWidthM: segment.halfWidthBackwardM,
        targetWidthM: minStartFwd * segment.laneWidthM,
      });
    } else {
      laneMergerBuilder.dispose(segment.id);
    }
  }
}