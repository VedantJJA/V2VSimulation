/**
 * Constants — truly global, cross-domain constants. Anything that belongs
 * to a single module is a tunable and lives in ConfigDefaults instead.
 */

/** Scene-unit contract: 1 world unit = 1 meter. Identity today; any future
 *  meters↔units conversion routes through this. */
export const METERS_PER_UNIT = 1;

/** Ground-plane height. The flat driving surface sits at y = DEFAULT_Y;
 *  road surfaces are ConfigDefaults.road.roadSurfaceYM above it. */
export const DEFAULT_Y = 0;