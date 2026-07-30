import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCurrentProject } from '../../lib/useCurrentProject'
import {
  fetchDashboardData,
  type DashboardData,
  type ItemProgress,
} from '../../lib/supabase/dashboard'
import './DashboardScreen.css'

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') {
    return err.message
  }
  return fallback
}

function formatNumber(n: number, maxFractionDigits = 0): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits })
}

function progressColorClass(percent: number): string {
  if (percent >= 100) return 'dashboard-progress-green'
  if (percent >= 75) return 'dashboard-progress-amber'
  return 'dashboard-progress-blue'
}

export function DashboardScreen() {
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
      .catch((err) => setError(extractErrorMessage(err, 'Failed to load dashboard.')))
      .finally(() => setLoading(false))
  }, [currentProject])

  if (!currentProject) {
    return (
      <div className="dashboard-screen">
        <p className="dashboard-project-prompt">No project selected — choose one from the header to see your dashboard.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="dashboard-screen">
        <p>Loading…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="dashboard-screen">
        <p className="dashboard-error">{error}</p>
      </div>
    )
  }

  if (!data) return null

  const { project, stats, itemsBySection } = data
  const sections = [...itemsBySection.keys()]

  return (
    <div className="dashboard-screen">
      <div className="dashboard-project">
        <span className="dashboard-project-code">{project.contractNumber}</span>
        <span className="dashboard-project-name">{project.name}</span>
      </div>

      <section className="dashboard-stats">
        <div className="dashboard-stat-card">
          <span className="dashboard-stat-label">Days Logged</span>
          <strong className="dashboard-stat-value">{stats.daysLogged}</strong>
        </div>
        <div className="dashboard-stat-card">
          <span className="dashboard-stat-label">Total Milled</span>
          <strong className="dashboard-stat-value">{formatNumber(stats.totalAreaMilledM2)} m²</strong>
        </div>
        <div className="dashboard-stat-card">
          <span className="dashboard-stat-label">Total Paved</span>
          <strong className="dashboard-stat-value">{formatNumber(stats.totalTonnesPaved)} t</strong>
        </div>
      </section>

      <section className="dashboard-quick-actions">
        <Link to="/milling" className="dashboard-quick-action">
          Milling Entry
        </Link>
        <Link to="/paving" className="dashboard-quick-action">
          Paving Entry
        </Link>
      </section>

      <section className="dashboard-items">
        <h2 className="dashboard-section-title">Contract Items</h2>
        {sections.map((section) => (
          <div key={section} className="dashboard-item-section">
            <h3 className="dashboard-item-section-header">{section}</h3>
            <div className="dashboard-item-list">
              {itemsBySection.get(section)!.map((item) => (
                <ContractItemRow key={item.target.id} item={item} />
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="dashboard-reports">
        <h2 className="dashboard-section-title">Recent Reports</h2>
        <p className="dashboard-coming-soon">
          No daily-report concept exists yet — this section is a placeholder until that's built.
        </p>
      </section>
    </div>
  )
}

function ContractItemRow({ item }: { item: ItemProgress }) {
  const { target } = item

  return (
    <div className="dashboard-item-row">
      <div className="dashboard-item-info">
        <span className="dashboard-item-code">{target.itemCode}</span>
        <span className="dashboard-item-desc">{target.description}</span>
      </div>

      {target.isLumpSum ? (
        <span className="dashboard-item-lumpsum">{target.uom}</span>
      ) : target.eventType === null ? (
        <div className="dashboard-item-untracked">
          <span className="dashboard-item-untracked-qty">
            {target.contractQty !== null ? formatNumber(target.contractQty, 2) : '—'} {target.uom}
          </span>
          <span className="dashboard-item-untracked-label">Not yet tracked in-app</span>
        </div>
      ) : (
        <div className="dashboard-item-progress">
          <div className="dashboard-item-progress-numbers">
            <span>
              {formatNumber(item.quantityToDate ?? 0, 2)} / {formatNumber(target.contractQty ?? 0, 2)} {target.uom}
            </span>
            <span className="dashboard-item-percent">
              {item.percentComplete === null ? '—' : `${formatNumber(item.percentComplete, 1)}%`}
            </span>
          </div>
          <div className="dashboard-progress-track">
            <div
              className={
                'dashboard-progress-bar ' +
                (item.percentComplete !== null ? progressColorClass(item.percentComplete) : '')
              }
              style={{ width: `${Math.min(100, Math.max(0, item.percentComplete ?? 0))}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
