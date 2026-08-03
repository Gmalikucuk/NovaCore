import { quantity as fmtQuantity, station } from '../lib/format'

export interface ChainageEntry {
  id: string
  stationFrom: number
  stationTo: number | null
  status: 'draft' | 'confirmed'
  itemNumber: string
  quantity: number
}

/**
 * The day's reaches drawn on a scale derived from the entered stations —
 * ported from novacore_v1_prototype.jsx's ChainageStrip, interaction design
 * kept, implementation rebuilt against the nc- design tokens instead of the
 * prototype's inline hex palette (and, before this pass, tokens.ts's CSS
 * variables — since removed). No sites table in v1 (spec amendment,
 * 2026-07-30), so there's no a-priori site bound to fall back to — bounds
 * always derive from whatever's actually been entered, the prototype's own
 * fallback path for an unbounded site.
 *
 * Scoped to the whole day, not one item or location: the point is
 * making a wrong station visible against everything else entered that day,
 * not just within whatever's currently selected.
 */
export function ChainageStrip({ entries }: { entries: ChainageEntry[] }) {
  if (entries.length === 0) return null

  const allStations = entries.flatMap((e) => [e.stationFrom, e.stationTo ?? e.stationFrom])
  let lo = Math.floor(Math.min(...allStations) * 10) / 10
  let hi = Math.ceil(Math.max(...allStations) * 10) / 10
  if (hi - lo < 0.2) hi = lo + 0.2

  const span = hi - lo || 1
  const pct = (v: number) => ((v - lo) / span) * 100
  const step = span > 10 ? 2 : span > 4 ? 1 : span > 1 ? 0.5 : 0.1
  const ticks: number[] = []
  // Rounded to the same precision station() displays at, not a display
  // call itself — this is float-step hygiene (0.1 + 0.1 + 0.1 drifting
  // past exact tenths), not a number being rendered.
  for (let k = Math.ceil(lo / step) * step; k <= hi + 1e-9; k += step) ticks.push(Math.round(k * 1000) / 1000)

  return (
    <div className="rounded-lg border border-nc-border bg-white p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-nc-text-muted">Chainage — today</div>
      <div className="relative h-10">
        <div className="absolute inset-x-0 top-4 h-2 rounded-sm border border-nc-border bg-nc-page" />
        <div
          className="absolute inset-x-0 top-[19px] h-0.5"
          style={{ background: 'repeating-linear-gradient(to right, var(--color-nc-border) 0, var(--color-nc-border) 6px, transparent 6px, transparent 12px)' }}
        />
        {entries.map((e) => {
          const a = pct(e.stationFrom)
          const b = pct(e.stationTo ?? e.stationFrom)
          const left = Math.max(0, Math.min(a, b))
          const width = Math.max(1.2, Math.abs(b - a))
          return (
            <div
              key={e.id}
              title={`${e.itemNumber}  ${station(e.stationFrom)}${e.stationTo != null ? '–' + station(e.stationTo) : ''}  ${fmtQuantity(e.quantity)}`}
              className={`absolute top-[15px] h-2.5 min-w-[3px] rounded-sm ${e.status === 'confirmed' ? 'bg-nc-success-text' : 'bg-nc-warning-text'}`}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          )
        })}
        {ticks.map((t) => (
          <div key={t} className="absolute top-[26px] flex -translate-x-1/2 flex-col items-center" style={{ left: `${pct(t)}%` }}>
            <div className="h-[5px] w-px bg-nc-border" />
            <div className="nc-numeric mt-0.5 whitespace-nowrap text-[10px] text-nc-text-muted">{station(t, span > 4 ? 0 : 1)}</div>
          </div>
        ))}
      </div>
      <div className="nc-numeric mt-2 text-xs text-nc-text-muted">
        km {station(lo)} → {station(hi)} · green is confirmed, yellow is awaiting review
      </div>
    </div>
  )
}
