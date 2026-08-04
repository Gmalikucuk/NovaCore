import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TdHTMLAttributes, type TextareaHTMLAttributes, type ThHTMLAttributes } from 'react'

/**
 * NovaCore UI primitives — ported from Vektor Freight's `ui.jsx` (the
 * reference implementation across all three Vektor products). Same
 * variants, same density, `nc-` tokens throughout. No off-token color
 * classes anywhere in this file — that's the whole point of the prefix.
 */

// ─────────────────────────────────────────────────────────────────────────
// Button
// ─────────────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-nc-navy text-white hover:bg-nc-navy-hover',
  secondary: 'border border-nc-border bg-white text-nc-text hover:bg-nc-secondary',
  danger: 'bg-nc-danger-text text-white hover:opacity-90',
  ghost: 'text-nc-text hover:bg-nc-secondary',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

// One size, per the spec — Freight doesn't offer a size prop and neither
// does this. If a screen needs something smaller, that's a new variant to
// discuss, not an ad-hoc className override at the call site.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'primary', className = '', ...props }, ref) {
  return (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nc-accent disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_VARIANTS[variant]} ${className}`}
      {...props}
    />
  )
})

// ─────────────────────────────────────────────────────────────────────────
// Form fields — Input / Select / Textarea share one base so a focus ring,
// a disabled treatment, or a readOnly treatment can never drift between
// them (RatesScreen's read-only rate cells rely on this matching Input's
// disabled look without actually being disabled).
// ─────────────────────────────────────────────────────────────────────────

const FIELD_BASE =
  'w-full rounded-md border border-nc-border bg-white px-3 py-2 text-sm text-nc-text placeholder:text-nc-text-subtle focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-nc-accent disabled:cursor-not-allowed disabled:bg-nc-secondary disabled:text-nc-text-muted read-only:cursor-default read-only:bg-nc-secondary read-only:text-nc-text-muted'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = '', ...props }, ref) {
  return <input ref={ref} className={`${FIELD_BASE} ${className}`} {...props} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className = '', ...props }, ref) {
  return <select ref={ref} className={`${FIELD_BASE} ${className}`} {...props} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className = '', ...props }, ref) {
  return <textarea ref={ref} className={`${FIELD_BASE} ${className}`} {...props} />
})

// ─────────────────────────────────────────────────────────────────────────
// Card / StatCard
// ─────────────────────────────────────────────────────────────────────────

export function Card({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-lg border border-nc-border bg-white shadow-sm ${className}`} {...props} />
}

interface StatCardProps {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  className?: string
}

export function StatCard({ label, value, sub, className = '' }: StatCardProps) {
  return (
    <Card className={`p-4 ${className}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-nc-text-muted">{label}</div>
      <div className="nc-numeric mt-1 text-2xl font-semibold text-nc-text">{value}</div>
      {sub && <div className="mt-1 text-xs text-nc-text-muted">{sub}</div>}
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// StatusBadge — one table mapping domain status to tone, never styled
// inline at the call site (per Freight's pattern).
// ─────────────────────────────────────────────────────────────────────────

type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info' | 'ready' | 'over'

const TONE_CLASSES: Record<StatusTone, string> = {
  success: 'bg-nc-success-bg text-nc-success-text',
  warning: 'bg-nc-warning-bg text-nc-warning-text',
  danger: 'bg-nc-danger-bg text-nc-danger-text',
  neutral: 'bg-nc-neutral-bg text-nc-neutral-text',
  info: 'bg-nc-info-bg text-nc-info-text',
  ready: 'bg-nc-ready-bg text-nc-ready-text',
  over: 'bg-nc-over-bg text-nc-over-text',
}

export type DomainStatus = 'draft' | 'confirmed' | 'superseded' | 'correcting' | 'over' | 'unpriced'

const STATUS_TONE: Record<DomainStatus, StatusTone> = {
  draft: 'warning', // awaiting confirmation
  confirmed: 'success', // counted toward Quantity to Date
  superseded: 'neutral', // replaced by a confirmed correction
  correcting: 'info', // a correction in review
  over: 'over', // recorded above Approximate Quantity
  unpriced: 'neutral', // no Unit Price set
}

interface StatusBadgeProps {
  status: DomainStatus
  children?: ReactNode
  className?: string
}

export function StatusBadge({ status, children, className = '' }: StatusBadgeProps) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[STATUS_TONE[status]]} ${className}`}>{children ?? status}</span>
}

// ─────────────────────────────────────────────────────────────────────────
// Table family — Table renders the bordered/rounded container (same
// treatment as Card); THead/TBody/TR/TH/TD are the plain semantic elements
// inside it. text-data (13px) + tabular figures inherit from index.css's
// `table` rule automatically; TD's `prose` flag opts a cell back out for
// descriptions/notes, which read better with proportional figures.
// ─────────────────────────────────────────────────────────────────────────

export function Table({ className = '', children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className={`overflow-x-auto overflow-y-hidden rounded-lg border border-nc-border bg-white shadow-sm ${className}`}>
      <table className="w-full min-w-max border-collapse" {...props}>
        {children}
      </table>
    </div>
  )
}

export function THead({ ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} />
}

export function TBody({ className = '', ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={`divide-y divide-nc-border ${className}`} {...props} />
}

export function TR({ className = '', ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={className} {...props} />
}

interface AlignProp {
  align?: 'left' | 'right'
}

export function TH({ align = 'left', className = '', ...props }: ThHTMLAttributes<HTMLTableCellElement> & AlignProp) {
  return <th className={`text-label bg-nc-secondary px-4 py-2.5 font-semibold uppercase tracking-wide text-nc-text-muted ${align === 'right' ? 'text-right' : 'text-left'} ${className}`} {...props} />
}

interface DenseProp {
  /**
   * A cell wrapping an Input/Select/Button already carries that control's
   * own vertical padding (py-2 on a field, py-2 on a Button) — stacking the
   * normal py-3 on top of it roughly doubled every row containing a
   * control to ~62-91px, well past Freight's ~44px density, and since a
   * table row takes the height of its tallest cell, that inflated cell
   * dragged every OTHER cell in the same row up with it. Dense drops the
   * TD's own vertical padding to py-1 so the control's padding is what
   * sets the row's height instead of adding to it.
   */
  dense?: boolean
}

export function TD({ align = 'left', prose = false, dense = false, className = '', ...props }: TdHTMLAttributes<HTMLTableCellElement> & AlignProp & { prose?: boolean } & DenseProp) {
  return <td className={`text-data px-4 ${dense ? 'py-1' : 'py-3'} ${align === 'right' ? 'text-right' : 'text-left'} ${prose ? 'nc-prose' : ''} ${className}`} {...props} />
}

// ─────────────────────────────────────────────────────────────────────────
// PageHeader — every screen gets one, always, including denied states
// (see EmptyState below). Subtitle is where a screen's live count goes —
// "48 Items · 3 awaiting confirmation" is the idiom, not a stat card.
// ─────────────────────────────────────────────────────────────────────────

interface PageHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-nc-text">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-nc-text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// EmptyState — solid border, deliberately not dashed. Dashed is reserved
// for "unverified" / "not yours" (a superseded record awaiting its
// replacement's confirmation) — a third, unrelated meaning ("nothing here")
// on the same visual cue would dilute the one signal dashed is supposed to
// carry.
// ─────────────────────────────────────────────────────────────────────────

interface EmptyStateProps {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  /** An icon component (e.g. a Tabler icon) for an empty-DATA state — "nothing recorded yet" — not used on the right-denial usages, which read fine as text alone. */
  icon?: ReactNode
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-nc-border bg-white px-6 py-12 text-center">
      {icon && <div className="mb-1 text-nc-text-subtle">{icon}</div>}
      <p className="text-sm font-medium text-nc-text">{title}</p>
      {description && <p className="text-sm text-nc-text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Spinner
// ─────────────────────────────────────────────────────────────────────────

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`h-4 w-4 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// NotificationBanner
// ─────────────────────────────────────────────────────────────────────────

type BannerTone = 'info' | 'warning' | 'danger' | 'success' | 'navy'

const BANNER_CLASSES: Record<BannerTone, string> = {
  info: 'bg-nc-info-bg text-nc-info-text',
  warning: 'bg-nc-warning-bg text-nc-warning-text',
  danger: 'bg-nc-danger-bg text-nc-danger-text',
  success: 'bg-nc-success-bg text-nc-success-text',
  // The Dashboard's revenue caveat — internal expectation, not a
  // Ministry-approved figure — is the one banner that needs to read as
  // structural/authoritative rather than a status message, hence navy
  // rather than one of the five status tones.
  navy: 'bg-nc-navy text-white',
}

interface NotificationBannerProps {
  tone?: BannerTone
  children: ReactNode
  className?: string
}

export function NotificationBanner({ tone = 'info', children, className = '' }: NotificationBannerProps) {
  return <div className={`rounded-md px-4 py-3 text-sm ${BANNER_CLASSES[tone]} ${className}`}>{children}</div>
}

// ─────────────────────────────────────────────────────────────────────────
// SandboxBanner — the standing rule: a sandbox contract's fictional status
// must be unmissable on every screen that shows it. One copy instead of
// eight, after the nav-restructure pass duplicated this same banner into
// every reading screen (Overview, Tracker, Rates, Items) plus every
// working screen (Daily Entry, Confirm, mobile Field entry) under time
// pressure the night before a demo — mechanical to merge, and the seven-
// files-changed-eighth-missed failure mode duplication invites otherwise.
//
// Renders nothing for a real contract — callers pass the whole contract
// unconditionally rather than gating with `contract.isSandbox &&` at each
// call site themselves; one fewer place to get that check wrong or forget.
//
// The portfolio's row-level "Sandbox" chip is deliberately NOT this
// component — a banner is the wrong shape for one row in a list of many
// (see PortfolioScreen's own comment); that's a second, smaller marker for
// a different surface, not an eighth call site to fold in here.
// ─────────────────────────────────────────────────────────────────────────

interface SandboxBannerProps {
  contract: { isSandbox: boolean; name: string }
  /**
   * 'reading' (default): Overview/Tracker/Rates/Items — looked at, not
   * worked in, so the bold treatment is warranted. 'working': Daily Entry,
   * Confirm, mobile Field entry — re-visited all day doing data entry, so
   * the same danger tone without the extra weight reads as unmissable
   * without reading as more alarm than the situation warrants on repeat.
   */
  variant?: 'reading' | 'working'
}

export function SandboxBanner({ contract, variant = 'reading' }: SandboxBannerProps) {
  if (!contract.isSandbox) return null
  return (
    <NotificationBanner tone="danger" className={`mb-4 ${variant === 'reading' ? 'font-medium' : ''}`}>
      This is a sandbox contract for exercising every screen state — {contract.name} is not a real contract, and its Unit Prices are invented, not tendered figures.
    </NotificationBanner>
  )
}
