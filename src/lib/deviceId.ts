const STORAGE_KEY = 'novacore_device_id'

/** A stable per-browser identifier, persisted once. daily_entries.device_id is informational only (which device generated a row) — not an auth or dedup mechanism, that's the client-generated entry id. */
export function getDeviceId(): string {
  let id = localStorage.getItem(STORAGE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(STORAGE_KEY, id)
  }
  return id
}
