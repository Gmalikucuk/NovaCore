import { useEffect, useState } from 'react'
import { useCurrentProject } from '../../lib/useCurrentProject'
import { fetchDashboardData, type DashboardData, type ItemProgress } from '../../lib/supabase/dashboard'
import './TrackerScreen.css'

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

function formatNumber(n: number, maxFractionDigits = 2): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits })
}

function percentClass(percent: number): string {
  if (percent >= 100) return 'tracker-percent-green'
  if (percent >= 75) return 'tracker-percent-amber'
  return 'tracker-percent-blue'
}

/**
 * Full per-item contract tracker — same three-state data as the Dashboard's
 * progress cards (fetchDashboardData is reused as-is, not re-queried), laid
 * out as a real table instead of grouped cards. No blended project-wide
 * percentage here either: items are sequenced/interdependent (shoulder
 * strip before milling, milling before paving, tack coat immediately before
 * paving, hot joint sealant only where two directions meet, joint sealant
 * only at project close) and measured in incompatible units — only a
 * per-item % is ever meaningful.
 *
 * FOLLOW-UP, not built here: segment-level breakdown per item (e.g.
 * expanding a row to show which road_segments contributed to its
 * quantity-to-date). Flagging rather than blocking this screen on it, per
 * instruction — the aggregate table below is real, tested data either way.
 */
export function TrackerScreen() {
  const currentProject = useCurrentProject()
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!currentProject) {
      setData(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    fetchDashboardData(currentProject)
      .then(setData)
      .catch((err) => setError(extractErrorMessage(err, 'Failed to load tracker.')))
      .finally(() => setLoading(false))
  }, [currentProject])

  if (!currentProject) {
    return (
      <div className="tracker-screen">
        <p className="tracker-project-prompt">No project selected — choose one from the header to see the tracker.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="tracker-screen">
        <p>Loading…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="tracker-screen">
        <p className="tracker-error">{error}</p>
      </div>
    )
  }

  if (!data) return null

  const { project, itemsBySection } = data
  const sections = [...itemsBySection.keys()]

  return (
    <div className="tracker-screen">
      <div className="tracker-project">
        <span className="tracker-project-code">{project.contractNumber}</span>
        <span className="tracker-project-name">{project.name}</span>
      </div>

      <div className="tracker-table-wrap">
        <table className="tracker-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Description</th>
              <th>UOM</th>
              <th className="tracker-col-num">Contract Qty</th>
              <th className="tracker-col-num">Done</th>
              <th className="tracker-col-num">Remaining</th>
              <th className="tracker-col-num">%</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => (
              <SectionRows key={section} section={section} items={itemsBySection.get(section)!} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SectionRows({ section, items }: { section: string; items: ItemProgress[] }) {
  return (
    <>
      <tr className="tracker-section-row">
        <td colSpan={7}>{section}</td>
      </tr>
      {items.map((item) => (
        <ItemRow key={item.target.id} item={item} />
      ))}
    </>
  )
}

function ItemRow({ item }: { item: ItemProgress }) {
  const { target } = item

  if (target.isLumpSum) {
    return (
      <tr>
        <td>{target.itemCode}</td>
        <td>{target.description}</td>
        <td>{target.uom}</td>
        <td className="tracker-col-num">—</td>
        <td className="tracker-col-num">—</td>
        <td className="tracker-col-num">—</td>
        <td className="tracker-col-num">
          <span className="tracker-lumpsum-badge">Lump Sum</span>
        </td>
      </tr>
    )
  }

  if (target.eventType === null) {
    return (
      <tr>
        <td>{target.itemCode}</td>
        <td>{target.description}</td>
        <td>{target.uom}</td>
        <td className="tracker-col-num">{target.contractQty !== null ? formatNumber(target.contractQty) : '—'}</td>
        <td className="tracker-col-num tracker-untracked-cell" colSpan={2}>
          Not yet tracked in-app
        </td>
        <td className="tracker-col-num">—</td>
      </tr>
    )
  }

  const done = item.quantityToDate ?? 0
  const remaining = target.contractQty !== null ? target.contractQty - done : null

  return (
    <tr>
      <td>{target.itemCode}</td>
      <td>{target.description}</td>
      <td>{target.uom}</td>
      <td className="tracker-col-num">{target.contractQty !== null ? formatNumber(target.contractQty) : '—'}</td>
      <td className="tracker-col-num">{formatNumber(done)}</td>
      <td className="tracker-col-num">{remaining !== null ? formatNumber(remaining) : '—'}</td>
      <td className="tracker-col-num">
        {item.percentComplete === null ? (
          '—'
        ) : (
          <span className={`tracker-percent ${percentClass(item.percentComplete)}`}>
            {formatNumber(item.percentComplete, 1)}%
          </span>
        )}
      </td>
    </tr>
  )
}
