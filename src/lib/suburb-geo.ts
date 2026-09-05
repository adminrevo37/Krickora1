// Suburb / postcode -> map coordinate resolver for the admin catchment maps
// (SuburbBubbleMap.tsx). 2026-09-05 — replaces the 51-entry hand-placed lookup +
// Nominatim-for-everything path that left 97% of WA suburbs dependent on a live
// geocoder (which rate-limits the office IP and whose failures were cached as null
// FOREVER in localStorage — the real reason the maps showed "a lot of data missing").
//
// Resolution order (synchronous, no network):
//   1. locality  — exact suburb within its postcode (precise per-locality point)
//   2. name      — suburb name anywhere in WA (postcode missing/mismatched); if the
//                  name exists in several postcodes the one nearest the facility wins
//   3. postcode  — the postcode's centroid (suburb misspelt/unknown but postcode valid)
//   4. unplaced  — nothing usable; the caller shows the name in the "could not place" list
// A live Nominatim lookup remains available to the CALLER as a last resort (see
// SuburbBubbleMap), but it is no longer on the main path and its misses expire.
import { WA_LOCALITY_COORDS, WA_POSTCODE_CENTROIDS, type LatLng } from './wa-postcode-coords'
import { FACILITY_LATLNG } from './facility-location'

export type { LatLng }
export type GeoMethod = 'locality' | 'name' | 'postcode' | 'geocoded' | 'unplaced'
export type GeoResolution = { latLng: LatLng | null; method: GeoMethod; ambiguous: boolean }

/** Canonical suburb key: upper-case, punctuation stripped, whitespace collapsed, "Mt" -> "Mount". */
export function suburbKey(s: string): string {
  return (s ?? '')
    .toUpperCase()
    .replace(/[.'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^MT /, 'MOUNT ')
}

/** 4-digit postcode or '' (tolerates "6021 " / "WA 6021"). */
export function postcodeKey(pc: string): string {
  const m = (pc ?? '').match(/\b(6\d{3})\b/)
  return m ? m[1] : ''
}

/** Great-circle distance in km. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[0] - a[0])
  const dLng = toRad(b[1] - a[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Lazy name index: suburb key -> every (postcode, point) it appears under.
let nameIndex: Map<string, Array<{ postcode: string; latLng: LatLng }>> | null = null
function getNameIndex() {
  if (nameIndex) return nameIndex
  nameIndex = new Map()
  for (const [pc, subs] of Object.entries(WA_LOCALITY_COORDS)) {
    for (const [name, ll] of Object.entries(subs)) {
      const k = suburbKey(name)
      const arr = nameIndex.get(k) ?? []
      arr.push({ postcode: pc, latLng: ll })
      nameIndex.set(k, arr)
    }
  }
  return nameIndex
}

export function resolveSuburbLatLng(suburb: string, postcode: string): GeoResolution {
  const key = suburbKey(suburb)
  const pc = postcodeKey(postcode)
  if (pc && key) {
    const ll = WA_LOCALITY_COORDS[pc]?.[key]
    if (ll) return { latLng: ll, method: 'locality', ambiguous: false }
  }
  if (key) {
    const hits = getNameIndex().get(key)
    if (hits && hits.length > 0) {
      let best = hits[0]
      if (hits.length > 1) {
        // Same name in several postcodes (e.g. "Perth" 6000/6001): nearest to the facility.
        best = hits.reduce((b, h) => (distanceKm(h.latLng, FACILITY_LATLNG) < distanceKm(b.latLng, FACILITY_LATLNG) ? h : b), hits[0])
      }
      return { latLng: best.latLng, method: 'name', ambiguous: hits.length > 1 }
    }
  }
  if (pc) {
    const c = WA_POSTCODE_CENTROIDS[pc]
    if (c) return { latLng: c, method: 'postcode', ambiguous: false }
  }
  return { latLng: null, method: 'unplaced', ambiguous: false }
}

/** Human label for how a point was placed (used in popups + the placement summary). */
export const GEO_METHOD_LABEL: Record<GeoMethod, string> = {
  locality: 'suburb',
  name: 'suburb name (postcode missing or mismatched)',
  postcode: 'postcode centre (suburb not recognised)',
  geocoded: 'online geocoder',
  unplaced: 'not placed',
}
