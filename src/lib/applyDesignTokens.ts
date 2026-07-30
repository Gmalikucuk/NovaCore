import { colors, mobileOverrides, radius, shadows, spacing, touchTarget, typography } from '../tokens'

function kebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

const MOBILE_QUERY = '(max-width: 767px)'

/**
 * tokens.ts is the single source of truth, but plain .css files can't import
 * a TS object — this bridges the two by writing every token onto :root as a
 * CSS custom property, so CSS can reference var(--color-navy) etc. without
 * duplicating the values.
 *
 * Written as inline styles on <html>, which always wins over a plain CSS
 * `@media { :root { ... } }` override in a stylesheet regardless of
 * specificity tricks — so making sizing responsive has to happen HERE, by
 * picking values based on matchMedia, rather than in CSS. mobileOverrides in
 * tokens.ts is the one place that governs the "smaller and tighter on
 * mobile" rule for every screen; nothing below hardcodes which screen it
 * applies to.
 */
export function applyDesignTokens(): void {
  const root = document.documentElement.style
  const mobileQuery = window.matchMedia(MOBILE_QUERY)

  function write(): void {
    const isMobile = mobileQuery.matches

    for (const [key, value] of Object.entries(colors)) {
      root.setProperty(`--color-${kebab(key)}`, value)
    }

    root.setProperty('--font-family', typography.fontFamily)
    root.setProperty('--font-family-mono', typography.fontFamilyMono)
    for (const [key, value] of Object.entries(typography.sizes)) {
      const mobileValue = isMobile ? (mobileOverrides.sizes as Record<string, string>)[key] : undefined
      root.setProperty(`--font-size-${key}`, mobileValue ?? value)
    }
    for (const [key, value] of Object.entries(typography.weights)) {
      root.setProperty(`--font-weight-${key}`, String(value))
    }

    for (const [key, value] of Object.entries(spacing)) {
      const mobileValue = isMobile ? (mobileOverrides.spacing as Record<string, string>)[key] : undefined
      root.setProperty(`--space-${key}`, mobileValue ?? value)
    }
    for (const [key, value] of Object.entries(radius)) {
      root.setProperty(`--radius-${key}`, value)
    }
    for (const [key, value] of Object.entries(shadows)) {
      root.setProperty(`--shadow-${key}`, value)
    }
    for (const [key, value] of Object.entries(touchTarget)) {
      const mobileValue = isMobile ? (mobileOverrides.touchTarget as Record<string, string>)[key] : undefined
      root.setProperty(`--touch-${kebab(key)}`, mobileValue ?? value)
    }
  }

  write()
  // Covers rotating a tablet, resizing a desktop browser window across the
  // breakpoint, or DevTools device toggling — not just the initial load.
  mobileQuery.addEventListener('change', write)
}
