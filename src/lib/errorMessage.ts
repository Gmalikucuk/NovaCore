/**
 * Supabase-js throws plain {message, details, hint, code} objects, not
 * Error instances — `err instanceof Error` misses them and `String(err)`
 * degrades to "[object Object]", losing the actual message. Falls back to
 * a `.message` string property before giving up to String(err).
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return String(err)
}
