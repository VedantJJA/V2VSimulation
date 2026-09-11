/**
 * ConfigDefaults (Phase 11) — the single source of truth for every tunable
 * and magic number in the app, organized by consuming module.
 *
 * Contract:
 * - BOOT-TIME: modules read their section as constructor defaults.
 *   Deep-frozen — nothing may ever write to this object.
 * - RUN-TIME: after construction each INSTANCE owns its values; the
 *   ControlPanel "Config (runtime)" folder mutates live instances
 *   (V2VManager.radiusM, LODManager.cullRadiusM,
 *   PropagationModel.wallThicknessThresholdM), never this object.
 *
 * Documented deviations from the phase brief:
 * - No lod.passiveRadiusM: the passive tier is DEFINED as
 *   cullRadiusM + hysteresisMarginM (Phase 7 design) — a second key would
 *   be dead config.
 * - vehicle.npc.idm* fields are RESERVED for a future IDM car-follower;
 *   today's follower is gain-based and does not read them.
 * - TimeOfDay presets, map JSON, CSS, and debug-overlay colors live with
 *   their owners: they are data/presentation, not tunables.
 */

function deepFreeze(object) {
    if (object && typeof object === 'object' && !Object.isFrozen(object)) {
        Object.freeze(object);
        for (const key of Object.keys(object)) deepFreeze(object[key]);
    }
    return object;
}

export const ConfigDefaults = deepFreeze({
    core: {
        cameraFovDeg: 60,
        cameraNearM: 0.1,
        cameraFarM: 2000,
        maxPixelRatio: 2,
        toneMappingExposure: 1.0,
        maxFrameDeltaSec: 0.1, // clamps runaway steps for fixed-timestep physics
    },

    environment: {
        fogColorHex: 0x9fb2c8,
        fogDensityDefault: 0.0025,
        fogDensityMax: 0.02,
        fogDensityStep: 0.0001,
        skyDomeRadiusM: 900, // must stay inside camera.far
        skyDomeSegments: 32,
        skyDomeRings: 15,
        skyHorizonDarken: 0.45,
        shadowMapSize: 2048,
        shadowCameraNearM: 1,
        shadowCameraFarM: 400,
        shadowCameraExtentM: 120,
        shadowBias: -0.0004,
    },

    road: {
        laneWidthM: 3.5,
        defaultSpeedLimitKph: 50,
        nodeSnapThresholdM: 6,
        sampleSpacingM: 2,
        minSamples: 8,
        roadSurfaceYM: 0.05, // asphalt lift above the ground plane
        asphaltTileM: 4,
        asphaltSeed: 1337,
        asphaltBaseCss: '#31353a',
        asphaltSpeckles: 2400,
        markingLineWidthM: 0.15,
        markingLiftM: 0.04, // above the asphalt
        dashLengthM: 3,
        dashGapM: 6,
        dashHeightM: 0.02,
        padMarginM: 2,
        padSides: 28,
        padLiftM: 0.03, // above markings: hides line ends inside junctions
        connectorWidthM: 0.25,
        connectorLiftM: 0.03, // above the pad
        coneRadiusM: 0.55,
        coneHeightM: 0.9,
        coneSegments: 12,
        barrierLaneWidthFactor: 0.9, // full-blocking barrier spans laneWidth * factor
        barrierHeightM: 1.0,
        barrierDepthM: 2.4,
    },

    buildings: {
        gridCellSizeM: 25,
        collisionMarginM: 2, // sidewalk kept between pavement edge and buildings
        overlapThresholdM: 0.5, // tolerated building-building overlap
        footprintSampleSpacingM: 4, // road-footprint centerline sampling
    },

    vehicle: {
        modelUrl: 'models/car_sedan.glb', // resolved against BASE_URL; GLTF faces −Z, origin at chassis center
        egoPaintHex: 0xc23b2e,
        fallbackPaintHex: 0x8a8f98,
        npcPaintPalette: [0xd8d5cf, 0x3f6d8c, 0x8a8f98, 0xd9a13b],
        trafficScatterSeed: 20240607,
        kinematicRideHeightM: 0.72, // chassis-center height; tires on the asphalt
        physicsSpawnHeightM: 1.0, // small drop onto the suspension
        vehicleProxyHalf: { width: 0.85, height: 0.75, length: 2.0 }, // analytic OBB proxy (Raycast/Neighbor/GPU)
        body: { widthM: 1.7, heightM: 0.6, lengthM: 4.0, offsetY: -0.05, roughness: 0.5, metalness: 0.25 },
        cabin: { widthM: 1.5, heightM: 0.5, lengthM: 1.9, offsetY: 0.32, offsetZ: 0.45, roughness: 0.25, metalness: 0.4, colorHex: 0x1d2126 },
        wheel: { radiusM: 0.36, widthM: 0.28, trackM: 0.82, offsetZM: 1.35, offsetY: -0.31, colorHex: 0x18191c },
        bicycle: {
            wheelbaseM: 2.7,
            maxSteerRad: 0.55,
            maxSpeedMps: 25,
            maxReverseSpeedMps: 6,
            engineAccelMps2: 4.5,
            brakeDecelMps2: 9,
            coastDecelMps2: 0.9,
        },
        physics: {
            massKg: 380,
            maxEngineForceN: 1600,
            brakeForcePerWheelN: 45,
            maxSteerRad: 0.5,
            steerSpeedFactor: 0.05, // steering authority fades as 1/(1 + v·f)
            angularDamping: 0.35,
            linearDamping: 0.01,
            chassisHalf: { x: 0.85, y: 0.35, z: 2.05 },
            wheel: {
                radiusM: 0.36,
                trackXM: 0.8,
                frontZM: 1.35, // chassis forward is +Z in the physics frame
                rearZM: -1.35,
                suspensionStiffness: 30,
                suspensionRestLengthM: 0.3,
                maxSuspensionTravelM: 0.3,
                maxSuspensionForce: 100000,
                dampingRelaxation: 2.3,
                dampingCompression: 4.4,
                frictionSlip: 1.4,
                rollInfluence: 0.01,
                customSlidingRotationalSpeed: -30,
            },
        },
        npc: {
            defaultTargetSpeedMps: 8,
            lookaheadM: 7,
            steerGain: 2.2,
            speedGain: 0.5,
            brakeGain: 0.6,
            cornerSlowFactor: 0.5,
            uTurnSpeedMps: 2.5,
            switchEpsilonM: 1.0,
            maxSpeedFactor: 1.5, // kinematic model max = target * factor
            minCruiseSpeedMps: 5,
            // RESERVED — future IDM car-follower (unread today):
            idmDesiredTimeHeadwaySec: 1.5,
            idmMaxAccelMps2: 2.5,
            idmComfortDecelMps2: 3.0,
            idmMinGapM: 2.5,
        },
        controls: {
            steerSlewRate: 6, // ≈ full lock in 1/6 s
            keyMap: {
                forward: ['KeyW', 'ArrowUp'],
                backward: ['KeyS', 'ArrowDown'],
                left: ['KeyA', 'ArrowLeft'],
                right: ['KeyD', 'ArrowRight'],
                brake: ['Space'],
            },
        },
    },

    sensor: {
        proximityMaxRangeM: 40,
        proximityOriginRadiusM: 2.1, // ray ring around the chassis center
        proximityOriginHeightM: 0.45, // bumper height; horizontal rays never hit flat roads
        proximityRays: [
            { name: 'front', angleDeg: 0 },
            { name: 'front-left', angleDeg: -45 },
            { name: 'front-right', angleDeg: 45 },
            { name: 'left', angleDeg: -90 },
            { name: 'right', angleDeg: 90 },
            { name: 'rear-left', angleDeg: -135 },
            { name: 'rear-right', angleDeg: 135 },
            { name: 'rear', angleDeg: 180 },
        ],
        dynamicGridCellSizeM: 20, // RaycastEngine's vehicle broadphase
        laneSampleSpacingM: 2, // LaneCenteringSensor projection sampling
        laneMinSamples: 16,
    },

    v2v: {
        radiusM: 250,
        neighborCellSizeM: 50,
        // BSMs are broadcast every tick in this build; this is the reserved
        // floor for future rate-limiting.
        bsmIntervalSec: 1 / 60,
        bsm: {
            pathIntervalSec: 0.5,
            pathPoints: 5, // → 2.5 s prediction horizon
            steerLockRad: 0.55,
            wheelbaseM: 2.7,
            substepSec: 0.1,
            turnSignalSteering: 0.3,
            maxSpeedMps: 75,
            maxAccelMps2: 15,
            maxYawRateRadS: 3,
            brakingDecelScaleMps2: 6, // observed decel / scale → brakingIntensity
            maxPathPoints: 8,
            lengthM: 4.0,
            widthM: 1.7,
        },
        propagation: {
            wallThicknessThresholdM: 10, // cumulative concrete that fully blocks
            recomputeDistanceM: 2, // pair-geometry cache refresh threshold
            maxCachedPairs: 4096,
            maxHitPoints: 8,
        },
        safety: {
            intersectionMinSegments: 3,
            icwRadiusM: 50, // both vehicles must be this close to the shared node
            icwHorizonSec: 3,
            icwTimeToleranceSec: 2,
            icwNodeProximityM: 30,
            bswRadiusM: 10,
            bswRearBearingDeg: 135,
            eebRadiusM: 100,
            eebBrakingThreshold: 0.6,
            eebBearingDeg: 35,
            eebLateralM: 7.5,
            maxAlerts: 8,
        },
    },

    lod: {
        cullRadiusM: 400,
        hysteresisMarginM: 80,
        coarseUpdateIntervalSec: 0.25,
        promoteNearestNMax: 512,
    },

    editor: {
        gridSnapSizeM: 6, // road-tool node-snap radius (mirrors road.nodeSnapThresholdM)
        orbitDampingFactor: 0.08,
        orbitMinDistanceM: 5,
        orbitMaxDistanceM: 500,
        initialCameraPosition: [70, 70, 95],
        topViewHeightM: 180,
        orbitViewOffset: [60, 65, 85],
        buildingGridCellSizeM: 25,
        nodeMarkerRadiusM: 0.7,
        nodeMarkerHeightM: 0.6,
        nodeMarkerOpacity: 0.9,
    },

    camera: {
        firstPersonForwardM: 0.35, // windshield offset from chassis center
        firstPersonUpM: 0.45,
        firstPersonLookDistanceM: 40,
        firstPersonLookDropM: 1.6,
        thirdPersonDistanceM: 9,
        thirdPersonHeightM: 4.2,
        thirdPersonLookAheadM: 6,
        thirdPersonLookHeightM: 1.2,
        positionDampLambda: 4.5,
        targetDampLambda: 10,
        minY: 0.6,
    },

    physics: {
        gravityY: -9.81,
        fixedStepSec: 1 / 60,
        maxSubSteps: 5,
        contactFriction: 0.3,
    },

    gpu: {
        maxRays: 4096,
        maxProxies: 512,
        workgroupSize: 64,
        validationDispatches: 4,
        validationToleranceM: 0.75,
    },
});