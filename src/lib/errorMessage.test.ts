import { describe, expect, it } from 'vitest'
import { errorMessage } from './errorMessage'

describe('errorMessage', () => {
  it('extracts .message from a native Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('extracts .message from a Supabase-style plain object (not instanceof Error)', () => {
    // Exactly the shape PostgREST returns on failure — {code, details, hint, message}.
    // The bug this guards: `err instanceof Error` is false for these, and a naive
    // `String(err)` fallback degrades to the literal string "[object Object]".
    const pgrstError = { code: 'PGRST205', details: null, hint: null, message: "Could not find the table 'public.project_members'" }
    expect(errorMessage(pgrstError)).toBe("Could not find the table 'public.project_members'")
  })

  it('falls back to String() only when there is no usable .message', () => {
    expect(errorMessage('a plain string')).toBe('a plain string')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage({ code: 'X' })).toBe('[object Object]')
  })
})
