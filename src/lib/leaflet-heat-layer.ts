// Minimal canvas density ("heat") layer for Leaflet — bundled, no CDN (the live
// app's CSP is script-src 'self'; leaflet.heat is not a dependency and adding one
// would touch package.json). Same technique as simpleheat/Leaflet.heat: stamp a
// radial-gradient alpha blob per point weighted by value, then recolour the
// accumulated alpha through a gradient lookup. ~100 lines, no external code.
import L from 'leaflet'

export type HeatPoint = { lat: number; lng: number; value: number }
export type HeatOptions = {
  /** blob radius in CSS px at the current zoom */
  radius?: number
  /** extra blur beyond the radius, px */
  blur?: number
  /** the value that maps to full intensity; default = max of the data */
  max?: number
  /** floor opacity so single small points are still visible (0..1) */
  minOpacity?: number
  /** stop -> css colour, stops in 0..1 */
  gradient?: Record<number, string>
}

const DEFAULT_GRADIENT: Record<number, string> = {
  0.2: '#2563eb', 0.4: '#06b6d4', 0.6: '#84cc16', 0.8: '#f59e0b', 1.0: '#dc2626',
}

export class HeatLayer extends L.Layer {
  private _canvas: HTMLCanvasElement | null = null
  private _points: HeatPoint[] = []
  private _opts: Required<HeatOptions>
  private _stamp: HTMLCanvasElement | null = null
  private _grad: Uint8ClampedArray | null = null
  private _frame: number | null = null

  constructor(points: HeatPoint[], opts: HeatOptions = {}) {
    super()
    this._points = points
    this._opts = { radius: 25, blur: 15, max: 0, minOpacity: 0.05, gradient: DEFAULT_GRADIENT, ...opts }
  }

  setPoints(points: HeatPoint[]) { this._points = points; this._stamp = null; this.redraw(); return this }
  setOptions(opts: HeatOptions) {
    this._opts = { ...this._opts, ...opts }
    this._stamp = null; this._grad = null
    this.redraw(); return this
  }

  onAdd(map: L.Map): this {
    const c = L.DomUtil.create('canvas', 'leaflet-heat-layer leaflet-zoom-hide') as HTMLCanvasElement
    c.style.position = 'absolute'
    c.style.pointerEvents = 'none'
    this._canvas = c
    map.getPanes().overlayPane.appendChild(c)
    map.on('moveend zoomend resize viewreset', this.redraw, this)
    this.redraw()
    return this
  }

  onRemove(map: L.Map): this {
    map.off('moveend zoomend resize viewreset', this.redraw, this)
    if (this._frame) cancelAnimationFrame(this._frame)
    this._canvas?.remove(); this._canvas = null
    return this
  }

  redraw = () => {
    if (this._frame) cancelAnimationFrame(this._frame)
    this._frame = requestAnimationFrame(() => { this._frame = null; this._draw() })
  }

  private _buildStamp() {
    const r = this._opts.radius, blur = this._opts.blur, r2 = r + blur
    const s = document.createElement('canvas')
    s.width = s.height = r2 * 2
    const ctx = s.getContext('2d')!
    const g = ctx.createRadialGradient(r2, r2, Math.max(0, r - blur), r2, r2, r2)
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, r2 * 2, r2 * 2)
    this._stamp = s
  }

  private _buildGradient() {
    const c = document.createElement('canvas'); c.width = 1; c.height = 256
    const ctx = c.getContext('2d')!
    const g = ctx.createLinearGradient(0, 0, 0, 256)
    for (const [stop, colour] of Object.entries(this._opts.gradient)) g.addColorStop(Number(stop), colour)
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1, 256)
    this._grad = ctx.getImageData(0, 0, 1, 256).data
  }

  private _draw() {
    const map = this._map as L.Map | undefined
    const canvas = this._canvas
    if (!map || !canvas) return
    const size = map.getSize()
    if (canvas.width !== size.x || canvas.height !== size.y) { canvas.width = size.x; canvas.height = size.y }
    // Pin the canvas to the current viewport's top-left in layer coordinates.
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]))
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, size.x, size.y)
    if (this._points.length === 0) return
    if (!this._stamp) this._buildStamp()
    if (!this._grad) this._buildGradient()
    const stamp = this._stamp!, grad = this._grad!
    const r2 = this._opts.radius + this._opts.blur
    const max = this._opts.max > 0 ? this._opts.max : this._points.reduce((m, p) => Math.max(m, p.value), 0) || 1
    for (const p of this._points) {
      const pt = map.latLngToContainerPoint([p.lat, p.lng])
      if (pt.x < -r2 || pt.y < -r2 || pt.x > size.x + r2 || pt.y > size.y + r2) continue
      ctx.globalAlpha = Math.min(Math.max(p.value / max, this._opts.minOpacity), 1)
      ctx.drawImage(stamp, pt.x - r2, pt.y - r2)
    }
    ctx.globalAlpha = 1
    const img = ctx.getImageData(0, 0, size.x, size.y)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3]
      if (a === 0) continue
      const j = a * 4
      d[i] = grad[j]; d[i + 1] = grad[j + 1]; d[i + 2] = grad[j + 2]
      // keep alpha, soften slightly so the basemap stays readable
      d[i + 3] = Math.min(255, Math.round(a * 0.85))
    }
    ctx.putImageData(img, 0, 0)
  }
}

export function heatLayer(points: HeatPoint[], opts?: HeatOptions) { return new HeatLayer(points, opts) }
