// Reusable OpenStreetMap bubble map: plots graduated circles per suburb from a
// normalised {suburb, postcode, count, detail?} row list. Suburb → lat/lng comes
// from a built-in Perth-metro lookup, falling back to OSM Nominatim (cached in
// localStorage) for the rest. Shared by the usage catchment map AND the
// full-database customer-suburb map (MapTab.tsx).
import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export type SuburbRow = { suburb: string; postcode: string; count: number; detail?: string }

// Approximate centroids for common Perth-metro suburbs (lat, lng). Covers the
// venue's catchment; anything else is geocoded via Nominatim on demand.
const SUBURBS: Record<string, [number, number]> = {
  STIRLING: [-31.8866, 115.8003], BALCATTA: [-31.8746, 115.8203], OSBORNE_PARK: [-31.9026, 115.8186],
  TUART_HILL: [-31.8986, 115.8336], DIANELLA: [-31.8836, 115.8636], YOKINE: [-31.9106, 115.8536],
  NOLLAMARA: [-31.8716, 115.8436], MIRRABOOKA: [-31.8636, 115.8636], GWELUP: [-31.8696, 115.7936],
  KARRINYUP: [-31.8716, 115.7736], INNALOO: [-31.8936, 115.7936], DOUBLEVIEW: [-31.9036, 115.7836],
  SCARBOROUGH: [-31.8946, 115.7596], TRIGG: [-31.8716, 115.7556], CARINE: [-31.8546, 115.7836],
  DUNCRAIG: [-31.8326, 115.7706], SORRENTO: [-31.8276, 115.7506], HILLARYS: [-31.8086, 115.7426],
  PERTH: [-31.9523, 115.8613], NORTHBRIDGE: [-31.9466, 115.8536], LEEDERVILLE: [-31.9366, 115.8416],
  MOUNT_LAWLEY: [-31.9366, 115.8736], MAYLANDS: [-31.9336, 115.8946], INGLEWOOD: [-31.9226, 115.8736],
  SUBIACO: [-31.9486, 115.8266], WEMBLEY: [-31.9326, 115.8166], NEDLANDS: [-31.9806, 115.8086],
  DALKEITH: [-31.9956, 115.7986], CLAREMONT: [-31.9826, 115.7826], COTTESLOE: [-31.9956, 115.7596],
  SHENTON_PARK: [-31.9606, 115.8016], FLOREAT: [-31.9376, 115.7946], CITY_BEACH: [-31.9356, 115.7676],
  WEMBLEY_DOWNS: [-31.9106, 115.7806], JOONDANNA: [-31.9006, 115.8436], MENORA: [-31.9156, 115.8616],
  COOLBINIA: [-31.9106, 115.8616], MORLEY: [-31.8886, 115.9086], NORANDA: [-31.8696, 115.8956],
  BAYSWATER: [-31.9176, 115.9176], BEDFORD: [-31.9106, 115.8836], BENNETT_SPRINGS: [-31.8576, 115.9416],
  WANNEROO: [-31.7466, 115.8036], JOONDALUP: [-31.7446, 115.7666], GREENWOOD: [-31.8246, 115.7986],
  WARWICK: [-31.8406, 115.8086], KINGSLEY: [-31.8136, 115.7906], WOODVALE: [-31.7896, 115.7976],
  CRAIGIE: [-31.8016, 115.7626], PADBURY: [-31.8086, 115.7686], BELDON: [-31.7956, 115.7596],
}

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '_')

const geoCache: Record<string, [number, number] | null> = (() => {
  try { return JSON.parse(localStorage.getItem('kr_geocache') || '{}') } catch { return {} }
})()
function saveGeo() { try { localStorage.setItem('kr_geocache', JSON.stringify(geoCache)) } catch { /* ignore */ } }

let lastGeoAt = 0
async function geocode(suburb: string, postcode: string): Promise<[number, number] | null> {
  const key = norm(suburb)
  if (SUBURBS[key]) return SUBURBS[key]
  if (key in geoCache) return geoCache[key]
  try {
    // Respect Nominatim's 1 req/sec usage policy (only hit for uncached suburbs).
    const wait = Math.max(0, 1100 - (Date.now() - lastGeoAt))
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastGeoAt = Date.now()
    const q = encodeURIComponent(`${suburb}, ${postcode || ''} Western Australia, Australia`)
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`, {
      headers: { 'Accept': 'application/json' },
    })
    const j = await res.json()
    const hit = Array.isArray(j) && j[0] ? [parseFloat(j[0].lat), parseFloat(j[0].lon)] as [number, number] : null
    geoCache[key] = hit; saveGeo()
    return hit
  } catch {
    geoCache[key] = null; saveGeo()
    return null
  }
}

function colorFor(ratio: number): string {
  if (ratio >= 0.8) return '#b91c1c'
  if (ratio >= 0.6) return '#ea580c'
  if (ratio >= 0.4) return '#f59e0b'
  if (ratio >= 0.2) return '#84cc16'
  return '#10b981'
}

export default function SuburbBubbleMap({
  rows,
  metricLabel,
  summaryRight,
}: {
  rows: SuburbRow[] | undefined // undefined = still loading
  metricLabel: string
  summaryRight?: string
}) {
  const mapRef = useRef<HTMLDivElement>(null)
  const leafletRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const [unplaced, setUnplaced] = useState<string[]>([])

  // Init the map once. Centred on Perth metro.
  useEffect(() => {
    if (!mapRef.current || leafletRef.current) return
    const map = L.map(mapRef.current, { scrollWheelZoom: true }).setView([-31.95, 115.86], 11)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 18,
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    leafletRef.current = map
    // Leaflet renders blank tiles when the container's size isn't settled at init
    // (it mounts inside a lazy tab). A ResizeObserver recomputes the size whenever
    // the container appears/resizes — bulletproof against the tab-mount race.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.invalidateSize()) : null
    if (ro && mapRef.current) ro.observe(mapRef.current)
    const t1 = setTimeout(() => map.invalidateSize(), 200)
    const t2 = setTimeout(() => map.invalidateSize(), 700)
    return () => { clearTimeout(t1); clearTimeout(t2); ro?.disconnect(); map.remove(); leafletRef.current = null }
  }, [])

  // Plot bubbles whenever the rows change.
  useEffect(() => {
    const map = leafletRef.current; const layer = layerRef.current
    if (!map || !layer || !rows) return
    let cancelled = false
    layer.clearLayers()
    const valid = rows.filter((r) => r.count > 0)
    const maxC = valid.reduce((m, r) => Math.max(m, r.count), 0) || 1
    const missing: string[] = []
    const pts: [number, number][] = [];

    (async () => {
      for (const r of valid) {
        const ll = await geocode(r.suburb, r.postcode)
        if (cancelled) return
        if (!ll) { missing.push(r.suburb); continue }
        pts.push(ll)
        const ratio = r.count / maxC
        const radius = 8 + Math.sqrt(r.count) * 6
        L.circleMarker(ll, {
          radius, color: colorFor(ratio), fillColor: colorFor(ratio), fillOpacity: 0.55, weight: 1.5,
        }).bindPopup(`<b>${r.suburb}</b> ${r.postcode || ''}<br>${r.count} ${metricLabel.toLowerCase()}${r.detail ? ` · ${r.detail}` : ''}`).addTo(layer)
        L.marker(ll, {
          icon: L.divIcon({ className: 'kr-suburb-label', html: `<span style="font-size:10px;font-weight:700;color:#111;text-shadow:0 0 3px #fff,0 0 3px #fff">${r.suburb} (${r.count})</span>`, iconSize: [0, 0] }),
        }).addTo(layer)
      }
      if (!cancelled) {
        setUnplaced(missing)
        map.invalidateSize()
        if (pts.length > 0) map.fitBounds(L.latLngBounds(pts).pad(0.2))
      }
    })()
    return () => { cancelled = true }
  }, [rows, metricLabel])

  return (
    <div className="p-4 space-y-3">
      {/* The map container is ALWAYS mounted (not gated on data) — Leaflet's init
          effect needs the ref present on first render, and the plot effect adds
          bubbles once the data arrives. */}
      <div className="relative">
        <div ref={mapRef} className="w-full rounded-xl overflow-hidden border border-gray-200 bg-gray-50" style={{ height: 520 }} />
        {rows === undefined && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 bg-white/60 rounded-xl">Loading…</div>
        )}
      </div>
      <div className="flex items-center gap-4 flex-wrap text-xs text-gray-500">
        <span className="font-medium text-gray-600">{metricLabel}:</span>
        {[['low', '#10b981'], ['', '#84cc16'], ['', '#f59e0b'], ['', '#ea580c'], ['high', '#b91c1c']].map(([lbl, c], i) => (
          <span key={i} className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-full" style={{ background: c }} />{lbl}</span>
        ))}
        {summaryRight && <span className="ml-auto">{summaryRight}</span>}
      </div>
      {unplaced.length > 0 && (
        <p className="text-[11px] text-amber-600">Could not place: {unplaced.join(', ')} (unknown suburb — add to lookup or check spelling).</p>
      )}
    </div>
  )
}
