// Reusable OpenStreetMap catchment map: plots a normalised {suburb, postcode, count,
// detail?} row list. Shared by the usage catchment map AND the full-database
// customer-suburb map (MapTab.tsx).
//
// 2026-09-05 rework (Inspector: "a lot of data missing", "better way to visualise",
// "full screen"):
//  • Placement is SYNCHRONOUS and offline via src/lib/suburb-geo.ts (every one of the
//    1,814 WA localities in wa-postcodes.ts has a precise point; unknown suburbs fall
//    back to their postcode centroid). The old path had 51 hand-placed suburbs and sent
//    everything else to Nominatim one request per second, caching a failure as null
//    FOREVER — which is how suburbs went "missing". Nominatim is now a last resort for
//    rows that still can't be placed, and its misses expire after a day.
//  • Three views, switchable in place: bubbles (graduated circles, quantile colours),
//    density heat (bundled canvas layer, radius + intensity sliders), ranked bars
//    (top 15 with distance from the facility) beside a small map.
//  • Distance rings 5 / 10 / 20 km around 78 Jones St on every view (toggle).
//  • Full screen: Fullscreen API on the card, CSS fixed-to-viewport fallback, Esc exits,
//    Leaflet re-lays out on the size change. Controls stay usable in both modes.
//  • The card now SAYS what could not be placed (count + names) and what the server
//    could not attribute at all (rows with no suburb on file), instead of dropping them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { resolveSuburbLatLng, suburbKey, distanceKm, GEO_METHOD_LABEL, type GeoMethod, type LatLng } from '../../lib/suburb-geo'
import { FACILITY_LATLNG, FACILITY_NAME, FACILITY_ADDRESS, FACILITY_RINGS_KM } from '../../lib/facility-location'
import { HeatLayer } from '../../lib/leaflet-heat-layer'

export type SuburbRow = { suburb: string; postcode: string; count: number; detail?: string }
export type MapView = 'bubble' | 'heat' | 'bars'

type Placed = { row: SuburbRow; key: string; latLng: LatLng; method: GeoMethod; km: number }

// ---------------------------------------------------------------------------
// Last-resort online geocoder (Nominatim). Only used for rows the offline resolver
// cannot place. Negative results EXPIRE (24h) — the previous cache kept a null for
// ever, so one rate-limited afternoon blanked a suburb permanently on that browser.
// ---------------------------------------------------------------------------
type GeoCacheEntry = { ll: LatLng | null; t: number }
const GEO_CACHE_KEY = 'kr_geocache_v2'
const NEG_TTL_MS = 24 * 60 * 60 * 1000
const geoCache: Record<string, GeoCacheEntry> = (() => {
  try { return JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}') } catch { return {} }
})()
function saveGeo() { try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geoCache)) } catch { /* ignore */ } }
let lastGeoAt = 0
async function geocodeOnline(suburb: string, postcode: string): Promise<LatLng | null> {
  const key = suburbKey(suburb)
  const cached = geoCache[key]
  if (cached && (cached.ll || Date.now() - cached.t < NEG_TTL_MS)) return cached.ll
  try {
    const wait = Math.max(0, 1100 - (Date.now() - lastGeoAt)) // Nominatim: max 1 req/s
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastGeoAt = Date.now()
    const q = encodeURIComponent(`${suburb}, ${postcode || ''} Western Australia, Australia`)
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${q}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(String(res.status))
    const j = await res.json()
    const hit = Array.isArray(j) && j[0] ? ([parseFloat(j[0].lat), parseFloat(j[0].lon)] as LatLng) : null
    geoCache[key] = { ll: hit, t: Date.now() }; saveGeo()
    return hit
  } catch {
    geoCache[key] = { ll: null, t: Date.now() }; saveGeo()
    return null
  }
}

// Quantile colour bins — rank-based so one dominant suburb doesn't wash every other
// bubble into the lowest colour, which is what a max-ratio scale did. Bins are actual
// value ranges so the legend can say "1–2 · 3–5 · 6–11 · 12+".
const BIN_COLOURS = ['#10b981', '#84cc16', '#f59e0b', '#ea580c', '#b91c1c']
type Bin = { lo: number; hi: number; colour: string }
function makeBins(counts: number[]): Bin[] {
  const s = [...counts].sort((a, b) => a - b)
  if (s.length === 0) return []
  const min = s[0], max = s[s.length - 1]
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  const thresholds = [...new Set([q(0.2), q(0.4), q(0.6), q(0.8)])].filter((t) => t > min).sort((a, b) => a - b)
  const edges = [min, ...thresholds, max + 1]
  const n = edges.length - 1
  return Array.from({ length: n }, (_, i) => ({
    lo: edges[i], hi: edges[i + 1] - 1,
    colour: n === 1 ? BIN_COLOURS[2] : BIN_COLOURS[Math.round((i * 4) / (n - 1))],
  }))
}
function binFor(count: number, bins: Bin[]): Bin | undefined {
  return bins.find((b) => count >= b.lo && count <= b.hi) ?? bins[bins.length - 1]
}

export default function SuburbBubbleMap({
  rows,
  metricLabel,
  summaryRight,
  unknownNote,
  title,
  defaultView = 'bubble',
}: {
  rows: SuburbRow[] | undefined // undefined = still loading
  metricLabel: string
  summaryRight?: string
  /** Server-side "could not attribute" statement, e.g. "12 sessions from 5 customers have no suburb on file". */
  unknownNote?: string
  /** Shown in the full-screen header. */
  title?: string
  defaultView?: MapView
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<HTMLDivElement>(null)
  const leafletRef = useRef<L.Map | null>(null)
  const bubbleLayerRef = useRef<L.LayerGroup | null>(null)
  const ringLayerRef = useRef<L.LayerGroup | null>(null)
  const heatRef = useRef<HeatLayer | null>(null)
  const markersRef = useRef<Map<string, L.CircleMarker>>(new Map())
  const fittedKeyRef = useRef<string>('')

  const [view, setView] = useState<MapView>(defaultView)
  const [showRings, setShowRings] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [heatRadius, setHeatRadius] = useState(28)
  const [heatIntensity, setHeatIntensity] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [fsFallback, setFsFallback] = useState(false)
  const [online, setOnline] = useState<Record<string, LatLng | null>>({})

  // ---- placement (synchronous, offline) ----------------------------------
  const { placed, unplaced, byMethod } = useMemo(() => {
    const placed: Placed[] = []
    const unplaced: SuburbRow[] = []
    const byMethod: Record<GeoMethod, number> = { locality: 0, name: 0, postcode: 0, geocoded: 0, unplaced: 0 }
    for (const r of rows ?? []) {
      if (!(r.count > 0)) continue
      const key = `${suburbKey(r.suburb)}|${r.postcode}`
      let res = resolveSuburbLatLng(r.suburb, r.postcode)
      if (!res.latLng) {
        const ll = online[suburbKey(r.suburb)]
        if (ll) res = { latLng: ll, method: 'geocoded', ambiguous: false }
      }
      if (!res.latLng) { unplaced.push(r); byMethod.unplaced++; continue }
      byMethod[res.method]++
      placed.push({ row: r, key, latLng: res.latLng, method: res.method, km: distanceKm(res.latLng, FACILITY_LATLNG) })
    }
    placed.sort((a, b) => b.row.count - a.row.count || a.row.suburb.localeCompare(b.row.suburb))
    return { placed, unplaced, byMethod }
  }, [rows, online])

  const bins = useMemo(() => makeBins(placed.map((p) => p.row.count)), [placed])
  const colourFor = useCallback((count: number) => binFor(count, bins)?.colour ?? BIN_COLOURS[2], [bins])

  // Last-resort online geocode for the leftovers (sequential, rate-limited, cancellable).
  useEffect(() => {
    if (unplaced.length === 0) return
    const todo = unplaced.filter((r) => !(suburbKey(r.suburb) in online))
    if (todo.length === 0) return
    let cancelled = false
    ;(async () => {
      for (const r of todo) {
        const ll = await geocodeOnline(r.suburb, r.postcode)
        if (cancelled) return
        setOnline((o) => ({ ...o, [suburbKey(r.suburb)]: ll }))
      }
    })()
    return () => { cancelled = true }
  }, [unplaced, online])

  // ---- map init -----------------------------------------------------------
  useEffect(() => {
    if (!mapRef.current || leafletRef.current) return
    const map = L.map(mapRef.current, { scrollWheelZoom: true }).setView(FACILITY_LATLNG, 11)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 18,
    }).addTo(map)
    // Facility marker + distance rings (static).
    const rings = L.layerGroup()
    for (const km of FACILITY_RINGS_KM) {
      L.circle(FACILITY_LATLNG, { radius: km * 1000, color: '#1d4ed8', weight: 1, dashArray: '4 4', fill: false, opacity: 0.6, interactive: false }).addTo(rings)
      // label at the top of each ring
      const top = L.latLng(FACILITY_LATLNG[0] + km / 111.32, FACILITY_LATLNG[1])
      L.marker(top, { interactive: false, icon: L.divIcon({ className: 'kr-ring-label', html: `<span style="font-size:10px;color:#1d4ed8;background:rgba(255,255,255,.8);padding:0 3px;border-radius:3px">${km} km</span>`, iconSize: [0, 0], iconAnchor: [-4, 6] }) }).addTo(rings)
    }
    rings.addTo(map)
    L.marker(FACILITY_LATLNG, {
      icon: L.divIcon({ className: 'kr-facility', html: '<div style="width:16px;height:16px;border-radius:50%;background:#1d4ed8;border:3px solid #fff;box-shadow:0 0 0 2px #1d4ed8"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      zIndexOffset: 1000,
    }).bindPopup(`<b>${FACILITY_NAME}</b><br>${FACILITY_ADDRESS}`).addTo(map)
    ringLayerRef.current = rings
    bubbleLayerRef.current = L.layerGroup().addTo(map)
    leafletRef.current = map
    // Leaflet renders blank tiles when the container's size isn't settled at init
    // (it mounts inside a lazy tab). A ResizeObserver recomputes the size whenever
    // the container appears/resizes — also what makes full screen re-lay out.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => map.invalidateSize()) : null
    if (ro && mapRef.current) ro.observe(mapRef.current)
    const t1 = setTimeout(() => map.invalidateSize(), 200)
    const t2 = setTimeout(() => map.invalidateSize(), 700)
    return () => { clearTimeout(t1); clearTimeout(t2); ro?.disconnect(); map.remove(); leafletRef.current = null; heatRef.current = null }
  }, [])

  // Rings toggle.
  useEffect(() => {
    const map = leafletRef.current, rings = ringLayerRef.current
    if (!map || !rings) return
    if (showRings) { if (!map.hasLayer(rings)) rings.addTo(map) } else if (map.hasLayer(rings)) map.removeLayer(rings)
  }, [showRings])

  // ---- plot ---------------------------------------------------------------
  useEffect(() => {
    const map = leafletRef.current, layer = bubbleLayerRef.current
    if (!map || !layer || !rows) return
    layer.clearLayers()
    markersRef.current.clear()
    if (heatRef.current) { map.removeLayer(heatRef.current); heatRef.current = null }

    const showBubbles = view === 'bubble' || view === 'bars'
    const small = view === 'bars'
    for (const p of placed) {
      const { row: r, latLng: ll } = p
      const c = colourFor(r.count)
      const popup = `<b>${r.suburb}</b> ${r.postcode || ''}<br>${r.count} ${metricLabel.toLowerCase()}${r.detail ? ` · ${r.detail}` : ''}<br><span style="color:#6b7280">${p.km.toFixed(1)} km from ${FACILITY_NAME} · placed by ${GEO_METHOD_LABEL[p.method]}</span>`
      if (showBubbles) {
        const radius = (small ? 4 : 6) + Math.sqrt(r.count) * (small ? 3.5 : 5)
        const m = L.circleMarker(ll, { radius, color: c, fillColor: c, fillOpacity: 0.55, weight: 1.5 }).bindPopup(popup).addTo(layer)
        markersRef.current.set(p.key, m)
        if (showLabels && !small) {
          L.marker(ll, {
            interactive: false,
            icon: L.divIcon({ className: 'kr-suburb-label', html: `<span style="font-size:10px;font-weight:700;color:#111;text-shadow:0 0 3px #fff,0 0 3px #fff">${r.suburb} (${r.count})</span>`, iconSize: [0, 0] }),
          }).addTo(layer)
        }
      } else {
        // heat view: a tiny hit-target so the popup is still reachable
        const m = L.circleMarker(ll, { radius: 4, color: '#111', fillColor: '#fff', fillOpacity: 0.9, weight: 1, opacity: 0.7 }).bindPopup(popup).addTo(layer)
        markersRef.current.set(p.key, m)
      }
    }
    if (view === 'heat' && placed.length > 0) {
      const max = (placed[0].row.count || 1) / heatIntensity
      heatRef.current = new HeatLayer(placed.map((p) => ({ lat: p.latLng[0], lng: p.latLng[1], value: p.row.count })), { radius: heatRadius, blur: Math.round(heatRadius * 0.6), max, minOpacity: 0.08 }).addTo(map)
    }
    map.invalidateSize()
    // Fit once per distinct row set, not on every view/slider change.
    const fitKey = placed.map((p) => p.key).join(',')
    if (placed.length > 0 && fitKey !== fittedKeyRef.current) {
      fittedKeyRef.current = fitKey
      map.fitBounds(L.latLngBounds([...placed.map((p) => p.latLng), FACILITY_LATLNG]).pad(0.15))
    }
  }, [rows, placed, view, heatRadius, heatIntensity, showLabels, metricLabel, colourFor])

  // ---- full screen --------------------------------------------------------
  const exitFullscreen = useCallback(() => {
    if (document.fullscreenElement) { document.exitFullscreen?.().catch(() => {}) }
    setFsFallback(false); setFullscreen(false)
  }, [])
  const toggleFullscreen = useCallback(() => {
    if (fullscreen) { exitFullscreen(); return }
    const el = wrapRef.current
    if (!el) return
    if (el.requestFullscreen) {
      el.requestFullscreen().then(() => setFullscreen(true)).catch(() => { setFsFallback(true); setFullscreen(true) })
    } else {
      setFsFallback(true); setFullscreen(true)
    }
  }, [fullscreen, exitFullscreen])
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement && !fsFallback) setFullscreen(false) }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [fsFallback])
  useEffect(() => {
    if (!fsFallback) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exitFullscreen() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [fsFallback, exitFullscreen])
  useEffect(() => {
    const map = leafletRef.current
    if (!map) return
    const t1 = setTimeout(() => map.invalidateSize(), 60)
    const t2 = setTimeout(() => map.invalidateSize(), 350)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [fullscreen, view])

  const focusRow = (p: Placed) => {
    const map = leafletRef.current
    if (!map) return
    map.flyTo(p.latLng, Math.max(map.getZoom(), 13), { duration: 0.6 })
    const m = markersRef.current.get(p.key)
    if (m) setTimeout(() => m.openPopup(), 650)
  }

  const placedCount = placed.length
  const totalRows = (rows ?? []).filter((r) => r.count > 0).length
  const top = placed.slice(0, 15)
  const topMax = top[0]?.row.count ?? 1

  const btn = (active: boolean) =>
    `px-2.5 py-1 rounded-md text-xs font-medium border transition ${active ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`

  return (
    <div
      ref={wrapRef}
      className={`bg-white ${fsFallback ? 'fixed inset-0 z-[9999] overflow-auto' : ''} ${fullscreen ? 'p-4 flex flex-col' : 'p-4 space-y-3'}`}
      style={fullscreen ? { minHeight: '100vh' } : undefined}
    >
      {/* toolbar */}
      <div className="flex items-center gap-2 flex-wrap text-xs mb-3">
        {fullscreen && title && <span className="font-semibold text-gray-800 text-sm mr-2">{title}</span>}
        <span className="text-gray-500">View:</span>
        <button type="button" className={btn(view === 'bubble')} onClick={() => setView('bubble')}>Bubbles</button>
        <button type="button" className={btn(view === 'heat')} onClick={() => setView('heat')}>Heat</button>
        <button type="button" className={btn(view === 'bars')} onClick={() => setView('bars')}>Top 15 + map</button>
        <label className="inline-flex items-center gap-1 ml-2 text-gray-600 cursor-pointer">
          <input type="checkbox" checked={showRings} onChange={(e) => setShowRings(e.target.checked)} /> 5/10/20 km rings
        </label>
        {view === 'bubble' && (
          <label className="inline-flex items-center gap-1 text-gray-600 cursor-pointer">
            <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> labels
          </label>
        )}
        {view === 'heat' && (
          <>
            <label className="inline-flex items-center gap-1 text-gray-600">radius
              <input type="range" min={10} max={70} value={heatRadius} onChange={(e) => setHeatRadius(Number(e.target.value))} className="w-24" />
              <span className="tabular-nums w-6">{heatRadius}</span>
            </label>
            <label className="inline-flex items-center gap-1 text-gray-600">intensity
              <input type="range" min={0.25} max={4} step={0.25} value={heatIntensity} onChange={(e) => setHeatIntensity(Number(e.target.value))} className="w-24" />
              <span className="tabular-nums w-8">{heatIntensity}×</span>
            </label>
          </>
        )}
        <button type="button" className={`${btn(false)} ml-auto`} onClick={toggleFullscreen} title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen'}>
          {fullscreen ? '✕ Exit full screen' : '⛶ Full screen'}
        </button>
      </div>

      {/* body */}
      <div className={`${view === 'bars' ? 'grid gap-3 md:grid-cols-[minmax(280px,340px)_1fr]' : ''} ${fullscreen ? 'flex-1 min-h-0' : ''}`}>
        {view === 'bars' && (
          <div className={`rounded-xl border border-gray-200 overflow-auto ${fullscreen ? 'max-h-[calc(100vh-170px)]' : 'max-h-[520px]'}`}>
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500 sticky top-0">
                <tr><th className="text-left px-2 py-1.5 font-medium">#</th><th className="text-left px-2 py-1.5 font-medium">Suburb</th><th className="text-right px-2 py-1.5 font-medium">{metricLabel}</th><th className="text-right px-2 py-1.5 font-medium">km</th><th className="px-2 py-1.5 w-[38%]"></th></tr>
              </thead>
              <tbody>
                {top.map((p, i) => (
                  <tr key={p.key} className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => focusRow(p)}>
                    <td className="px-2 py-1.5 text-gray-400">{i + 1}</td>
                    <td className="px-2 py-1.5 text-gray-800">{p.row.suburb} <span className="text-gray-400">{p.row.postcode}</span></td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-medium">{p.row.count}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-gray-500">{p.km.toFixed(1)}</td>
                    <td className="px-2 py-1.5"><div className="h-2.5 rounded" style={{ width: `${Math.max(4, (p.row.count / topMax) * 100)}%`, background: colourFor(p.row.count) }} /></td>
                  </tr>
                ))}
                {top.length === 0 && <tr><td colSpan={5} className="px-2 py-3 text-gray-400">No placed suburbs in range.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        <div className="relative">
          {/* The map container is ALWAYS mounted (not gated on data) — Leaflet's init
              effect needs the ref present on first render, and the plot effect adds
              layers once the data arrives. */}
          <div
            ref={mapRef}
            className="w-full rounded-xl overflow-hidden border border-gray-200 bg-gray-50"
            style={{ height: fullscreen ? 'calc(100vh - 170px)' : 520 }}
          />
          {rows === undefined && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 bg-white/60 rounded-xl">Loading…</div>
          )}
        </div>
      </div>

      {/* legend + summary */}
      <div className="flex items-center gap-4 flex-wrap text-xs text-gray-500 mt-3">
        <span className="font-medium text-gray-600">{metricLabel}:</span>
        {view === 'heat' ? (
          <span className="inline-flex items-center gap-1">low <span className="inline-block w-24 h-3 rounded" style={{ background: 'linear-gradient(90deg,#2563eb,#06b6d4,#84cc16,#f59e0b,#dc2626)' }} /> high</span>
        ) : (
          bins.map((b, i) => (
            <span key={i} className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-full" style={{ background: b.colour }} />{b.hi > b.lo ? `${b.lo}–${b.hi}` : `${b.lo}`}</span>
          ))
        )}
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-blue-700 border-2 border-white shadow" /> facility</span>
        {summaryRight && <span className="ml-auto">{summaryRight}</span>}
      </div>
      {rows && (
        <div className="text-[11px] text-gray-500 space-y-0.5">
          <p>
            Placed <b>{placedCount}</b> of {totalRows} suburbs
            {placedCount > 0 && (
              <> ({byMethod.locality} exact{byMethod.name ? ` · ${byMethod.name} by name` : ''}{byMethod.postcode ? ` · ${byMethod.postcode} at postcode centre` : ''}{byMethod.geocoded ? ` · ${byMethod.geocoded} via online geocoder` : ''})</>
            )}
            {unplaced.length > 0 && (
              <span className="text-amber-600"> · <b>{unplaced.length} could not be placed</b> ({unplaced.reduce((n, r) => n + r.count, 0)} {metricLabel.toLowerCase()}): {unplaced.slice(0, 8).map((r) => `${r.suburb}${r.postcode ? ` ${r.postcode}` : ''}`).join(', ')}{unplaced.length > 8 ? ` +${unplaced.length - 8} more` : ''}</span>
            )}
          </p>
          {unknownNote && <p className="text-amber-700">{unknownNote}</p>}
        </div>
      )}
    </div>
  )
}
