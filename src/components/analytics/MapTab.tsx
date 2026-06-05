// SPEC_ANALYTICS_BUILD_2026-06 addendum — OpenStreetMap catchment heatmap. Plots
// graduated bubbles per suburb from the customer catchment report (unique
// customers per suburb). Suburb → lat/lng comes from a built-in Perth-metro
// lookup, falling back to OSM Nominatim (cached in localStorage) for the rest.
import { useEffect, useRef, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { type DateRange, Section, Loading, Empty } from './shared'

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

async function geocode(suburb: string, postcode: string): Promise<[number, number] | null> {
  const key = norm(suburb)
  if (SUBURBS[key]) return SUBURBS[key]
  if (key in geoCache) return geoCache[key]
  try {
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

export default function MapTab({ range }: { range: DateRange }) {
  const data = useQuery(api.analytics.getCatchmentReport, { from: range.from || undefined, to: range.to || undefined })
  const mapRef = useRef<HTMLDivElement>(null)
  const leafletRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const [unplaced, setUnplaced] = useState<string[]>([])

  // Init the map once.
  useEffect(() => {
    if (!mapRef.current || leafletRef.current) return
    const map = L.map(mapRef.current, { scrollWheelZoom: true }).setView([-31.89, 115.81], 11)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 18,
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    leafletRef.current = map
    return () => { map.remove(); leafletRef.current = null }
  }, [])

  // Plot bubbles whenever the catchment data changes.
  useEffect(() => {
    const map = leafletRef.current; const layer = layerRef.current
    if (!map || !layer || !data) return
    let cancelled = false
    layer.clearLayers()
    const rows = (data.bySuburb ?? []).filter((r: any) => (r.customers ?? r.bookings) > 0)
    const maxC = rows.reduce((m: number, r: any) => Math.max(m, r.customers ?? r.bookings), 0) || 1
    const missing: string[] = []
    const pts: [number, number][] = [];

    (async () => {
      for (const r of rows) {
        const count = r.customers ?? r.bookings
        const ll = await geocode(r.suburb, r.postcode)
        if (cancelled) return
        if (!ll) { missing.push(r.suburb); continue }
        pts.push(ll)
        const ratio = count / maxC
        const radius = 8 + Math.sqrt(count) * 6
        L.circleMarker(ll, {
          radius, color: colorFor(ratio), fillColor: colorFor(ratio), fillOpacity: 0.55, weight: 1.5,
        }).bindPopup(`<b>${r.suburb}</b> ${r.postcode || ''}<br>${count} customer${count !== 1 ? 's' : ''} · ${r.bookings} session${r.bookings !== 1 ? 's' : ''}`).addTo(layer)
        L.marker(ll, {
          icon: L.divIcon({ className: 'kr-suburb-label', html: `<span style="font-size:10px;font-weight:700;color:#111;text-shadow:0 0 3px #fff,0 0 3px #fff">${r.suburb} (${count})</span>`, iconSize: [0, 0] }),
        }).addTo(layer)
      }
      if (!cancelled) {
        setUnplaced(missing)
        if (pts.length > 0) map.fitBounds(L.latLngBounds(pts).pad(0.2))
      }
    })()
    return () => { cancelled = true }
  }, [data])

  return (
    <div className="space-y-4">
      <Section title="Catchment heatmap" subtitle="Where customers travel from — bubble size & colour scale with unique customers per suburb (OpenStreetMap)">
        {data === undefined ? <Loading label="Loading catchment…" /> : data === null ? <Empty label="Unavailable." /> : (
          <div className="p-4 space-y-3">
            <div ref={mapRef} className="w-full rounded-xl overflow-hidden border border-gray-200" style={{ height: 520 }} />
            <div className="flex items-center gap-4 flex-wrap text-xs text-gray-500">
              <span className="font-medium text-gray-600">Unique customers:</span>
              {[['low', '#10b981'], ['', '#84cc16'], ['', '#f59e0b'], ['', '#ea580c'], ['high', '#b91c1c']].map(([lbl, c], i) => (
                <span key={i} className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-full" style={{ background: c }} />{lbl}</span>
              ))}
              <span className="ml-auto">{data.uniqueCustomers ?? '—'} unique customers · {data.total} sessions</span>
            </div>
            {unplaced.length > 0 && (
              <p className="text-[11px] text-amber-600">Could not place: {unplaced.join(', ')} (unknown suburb — add to lookup or check spelling).</p>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}
