// The facility's map position — 78 Jones Street, Stirling WA 6021 (Cricket Revolution).
// Used by the catchment maps for the distance rings (5/10/20 km), the "km from
// facility" column and the nearest-match tie-break in suburb-geo.ts.
//
// ⚠️ PRECISION NOTE (2026-09-05): this is the dataset's precise point for the
// STIRLING locality (matthewproctor/australianpostcodes Lat_precise/Long_precise),
// NOT a surveyed parcel coordinate for 78 Jones St — the two geocoders tried while
// building this (Nominatim from the office IP: HTTP 429; the HA `zone.home` read was
// blocked by the tool policy) could not supply one. The error is a few hundred
// metres at most, which does not move a 5 km ring visibly. Replace with the exact
// lat/lng from Home Assistant's zone.home (or Google Maps) when convenient — this is
// the ONLY place it is defined.
import type { LatLng } from './wa-postcode-coords'

export const FACILITY_LATLNG: LatLng = [-31.8864, 115.8099]
export const FACILITY_NAME = 'Cricket Revolution'
export const FACILITY_ADDRESS = '78 Jones St, Stirling WA 6021'
/** Distance rings drawn on every catchment map, km. */
export const FACILITY_RINGS_KM: readonly number[] = [5, 10, 20]
