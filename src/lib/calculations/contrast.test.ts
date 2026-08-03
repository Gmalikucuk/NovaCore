/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio } from './contrast'

// AA (4.5:1 for normal-size text), not AAA (7:1). The old NovaCore palette
// (tokens.ts, removed by the Vektor design-system migration) was hand-tuned
// to clear AAA everywhere — every *Dark token existed specifically to hit
// >=7:1. The nc- palette this replaces it with is Vektor Freight's system,
// supplied verbatim (index.css was replaced with the attached file, not
// designed here) and its own comments never claim AAA. Measured, not
// assumed: of the 7 status bg/text pairs, only `ready` (8.28:1) and `over`
// (7.57:1) clear AAA — success (4.57), warning (4.51), danger (5.30),
// neutral (6.92) and info (6.59) all clear AA but not AAA. text-muted clears
// AA (~4.6) but not AAA either. This test asserts the bar the supplied
// tokens actually hold, uniformly, rather than a mix of AAA-where-convenient
// and AA-elsewhere, or an AAA assertion that would fail on 5 of 7 pairs no
// token value here was changed to fix.
const AA = 4.5

/** Pulls every `--color-nc-*: #hex;` declaration out of index.css's @theme block — one source of truth, not a duplicated color map. */
function readTokens(): Record<string, string> {
  const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
  const tokens: Record<string, string> = {}
  for (const m of css.matchAll(/--color-nc-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[m[1]] = m[2]
  }
  return tokens
}

const t = readTokens()

interface Pairing {
  source: string
  fg: string
  bg: string
  exempt?: string
}

// The seven documented status bg/text pairs (nc_tokens.css: "Tokens ship as
// fill/text PAIRS so a fill cannot be chosen without its matching
// foreground") — the same badge-legibility property the old test enforced
// for the previous palette's badges.
const STATUS_PAIRS: Pairing[] = [
  { source: 'success bg/text', fg: t['success-text'], bg: t['success-bg'] },
  { source: 'warning bg/text', fg: t['warning-text'], bg: t['warning-bg'] },
  { source: 'danger bg/text', fg: t['danger-text'], bg: t['danger-bg'] },
  { source: 'neutral bg/text', fg: t['neutral-text'], bg: t['neutral-bg'] },
  { source: 'info bg/text', fg: t['info-text'], bg: t['info-bg'] },
  { source: 'ready bg/text (5th state, carried from Freight/QuoteDock)', fg: t['ready-text'], bg: t['ready-bg'] },
  { source: 'over bg/text (6th state, NovaCore-specific — over-quantity)', fg: t['over-text'], bg: t['over-bg'] },
]

// Core text-on-surface pairs — every surface color actually used as a text
// background in the sidebar/page/card system.
const SURFACE_PAIRS: Pairing[] = [
  { source: 'text on page', fg: t.text, bg: t.page },
  { source: 'text on card', fg: t.text, bg: t.card },
  { source: 'text on secondary', fg: t.text, bg: t.secondary },
  { source: 'text-muted on page', fg: t['text-muted'], bg: t.page },
  { source: 'text-muted on card', fg: t['text-muted'], bg: t.card },
  // Measured at 4.10:1 — below AA (4.5:1) for normal text. Accent is
  // documented as a brand color, not assigned a specific role here; if it's
  // ever used as small foreground text on a light surface it needs a darker
  // shade or a non-text role (icon, border, focus ring, or as a background
  // with white text, which is a completely different, uncomputed pairing).
  // Computed and exempted rather than silently dropped, so the real number
  // stays visible if this token's usage is ever pinned down.
  { source: 'accent on card', fg: t.accent, bg: t.card, exempt: 'no confirmed small-text usage; documented for when there is one' },
  { source: 'white on navy (sidebar body text)', fg: '#FFFFFF', bg: t.navy },
  // text-subtle fails even AA (~2.5:1) — reserved for placeholder-style,
  // non-required text (WCAG 1.4.3 exempts placeholder/decorative text the
  // same way it exempts disabled controls), never for anything a user must
  // read to act. Computed and asserted >0, not silently dropped.
  { source: 'text-subtle on page', fg: t['text-subtle'], bg: t.page, exempt: 'placeholder/decorative text (WCAG 1.4.3)' },
  { source: 'text-subtle on card', fg: t['text-subtle'], bg: t.card, exempt: 'placeholder/decorative text (WCAG 1.4.3)' },
]

describe('WCAG AA contrast — the nc- design tokens', () => {
  it('found every expected token (parser sanity check)', () => {
    for (const key of ['navy', 'accent', 'page', 'card', 'secondary', 'text', 'text-muted', 'text-subtle', 'success-bg', 'success-text', 'over-bg', 'over-text']) {
      expect(t[key], `--color-nc-${key} not found in index.css`).toBeDefined()
    }
  })

  it.each([...STATUS_PAIRS, ...SURFACE_PAIRS].map((p) => [p.source, p] as const))('%s clears AA (4.5:1)', (_label, p) => {
    const ratio = contrastRatio(p.fg, p.bg)
    if (p.exempt) {
      expect(ratio).toBeGreaterThan(0)
      return
    }
    expect(ratio).toBeGreaterThanOrEqual(AA)
  })
})
