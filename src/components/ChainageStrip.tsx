import './ChainageStrip.css'

export interface ChainageEntry {
  id: string
  stationFrom: number
  stationTo: number | null
  status: 'draft' | 'confirmed'
  itemNumber: string
  quantity: number
}

function km(v: number): string {
  return v.toFixed(3)
}

/**
 * The day's reaches drawn on a scale derived from the entered stations —
 * ported from novacore_v1_prototype.jsx's ChainageStrip, interaction design
 * kept, implementation rebuilt against tokens.ts instead of the prototype's
 * inline hex palette. No sites table in v1 (spec amendment, 2026-07-30), so
 * there's no a-priori site bound to fall back to — bounds always derive
 * from whatever's actually been entered, the prototype's own fallback path
 * for an unbounded site.
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
  for (let k = Math.ceil(lo / step) * step; k <= hi + 1e-9; k += step) ticks.push(Number(k.toFixed(3)))

  return (
    <div className="chainage-strip">
      <div className="chainage-strip-label">Chainage — today</div>
      <div className="chainage-strip-track">
        <div className="chainage-strip-road" />
        <div className="chainage-strip-centreline" />
        {entries.map((e) => {
          const a = pct(e.stationFrom)
          const b = pct(e.stationTo ?? e.stationFrom)
          const left = Math.max(0, Math.min(a, b))
          const width = Math.max(1.2, Math.abs(b - a))
          return (
            <div
              key={e.id}
              title={`${e.itemNumber}  ${km(e.stationFrom)}${e.stationTo != null ? '–' + km(e.stationTo) : ''}  ${e.quantity}`}
              className={'chainage-strip-reach' + (e.status === 'confirmed' ? ' chainage-strip-reach-confirmed' : ' chainage-strip-reach-draft')}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          )
        })}
        {ticks.map((t) => (
          <div key={t} className="chainage-strip-tick" style={{ left: `${pct(t)}%` }}>
            <div className="chainage-strip-tick-line" />
            <div className="chainage-strip-tick-label">{t.toFixed(span > 4 ? 0 : 1)}</div>
          </div>
        ))}
      </div>
      <div className="chainage-strip-caption">
        km {km(lo)} → {km(hi)} · green is confirmed, yellow is awaiting review
      </div>
    </div>
  )
}
