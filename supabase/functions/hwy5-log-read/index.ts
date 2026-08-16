// =============================================================================
// NovaCore — Hwy 5 field archive: read-only reconnaissance (Brief 7, stage 2)
//
// Reads the Google Sheets archive for contract 26607-0000 and returns a
// reconciliation payload. WRITES NOTHING — not to quantity_records, not to
// any other NovaCore table, not to Google. Every Supabase call this file
// makes is a select. Every Google call is a GET. There is no INSERT/UPDATE
// anywhere in this file, by design: this is "a read you can run and
// inspect," not the import itself.
//
// Invoked manually (supabase functions invoke / a direct authenticated
// fetch) — there is no client call site, no cron, no webhook trigger. That
// is deliberate: no scheduling or polling yet, per the brief.
//
// Auth: a Google service account (read-only Drive metadata + Sheets scope),
// its key held in the GOOGLE_SA_HWY5_KEY Supabase secret, never in this
// repo. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are the ones Supabase
// injects into every Edge Function automatically — no secret of ours reads
// quantity_records or items, both read here with the service role because
// this function has no signed-in user of its own to act as.
// =============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

// "Hwy5 Measurements" — the specific subfolder under the main project
// folder (1Na_GX_uZNWmmLouCxoNpY5MdPnLZewkH) that holds the per-item
// workbooks. Scoped here rather than the parent to avoid walking whatever
// else lives in the project folder (the recursive walk below would reach
// this subfolder either way, but starting here is narrower and faster).
const FOLDER_ID = '18cqCmAxTX8eeSy536XT0kUWo9MNL-bWO'
const CONTRACT_NO = '26607-0000'
const GOOGLE_SCOPES =
  'https://www.googleapis.com/auth/drive.metadata.readonly ' +
  'https://www.googleapis.com/auth/spreadsheets.readonly'

// Level Course and Bottom/Intermediate Lifts carry tonnage per measurement
// (WebApp.gs's own SEG_TONNES) — postMeasurement refuses to save one
// without it. Every other paving item's tonnage comes from the day's Closed
// row instead. This is the rule as given, not a heuristic.
const SEG_TONNES_ITEMS = new Set(['05.03.01', '05.03.02'])

const DAY_TAB_PATTERN = /^\d{1,2}\s+[A-Za-z]{3}-B\d+$/
const AREA_EPSILON = 0.005

// -----------------------------------------------------------------------------
// Google service-account auth — JWT Bearer flow via Web Crypto, no extra deps.
// -----------------------------------------------------------------------------

interface ServiceAccountKey {
  client_email: string
  private_key: string
}

function base64url(bytes: Uint8Array): string {
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlJson(obj: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(obj)))
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const raw = atob(b64)
  const buf = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i)
  return buf.buffer
}

async function getGoogleAccessToken(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: key.client_email,
    scope: GOOGLE_SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }
  const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(key.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput),
  )
  const jwt = `${signingInput}.${base64url(new Uint8Array(signature))}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`)
  }
  const json = await res.json()
  return json.access_token as string
}

// -----------------------------------------------------------------------------
// Drive — recursive folder walk, spreadsheets only.
// -----------------------------------------------------------------------------

interface DriveFile {
  id: string
  name: string
  mimeType: string
}

async function listFolderChildren(folderId: string, accessToken: string): Promise<DriveFile[]> {
  const files: DriveFile[] = []
  let pageToken: string | undefined
  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files')
    url.searchParams.set('q', `'${folderId}' in parents and trashed = false`)
    url.searchParams.set('fields', 'nextPageToken, files(id, name, mimeType)')
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`Drive files.list failed for ${folderId}: ${res.status} ${await res.text()}`)
    const json = await res.json()
    files.push(...(json.files ?? []))
    pageToken = json.nextPageToken
  } while (pageToken)
  return files
}

async function walkFolderForSpreadsheets(
  folderId: string,
  accessToken: string,
  depth = 0,
  maxDepth = 6,
): Promise<{ spreadsheets: DriveFile[]; depthWarnings: string[] }> {
  if (depth > maxDepth) {
    return { spreadsheets: [], depthWarnings: [`Folder ${folderId} exceeded max recursion depth (${maxDepth}) — not fully walked.`] }
  }
  const children = await listFolderChildren(folderId, accessToken)
  const spreadsheets: DriveFile[] = []
  const depthWarnings: string[] = []
  for (const child of children) {
    if (child.mimeType === 'application/vnd.google-apps.folder') {
      const sub = await walkFolderForSpreadsheets(child.id, accessToken, depth + 1, maxDepth)
      spreadsheets.push(...sub.spreadsheets)
      depthWarnings.push(...sub.depthWarnings)
    } else if (child.mimeType === 'application/vnd.google-apps.spreadsheet') {
      spreadsheets.push(child)
    }
  }
  return { spreadsheets, depthWarnings }
}

// -----------------------------------------------------------------------------
// Sheets — metadata + values, UNFORMATTED_VALUE so dates come back as Sheets
// serials (converted below) rather than locale-dependent formatted strings.
// -----------------------------------------------------------------------------

async function getSheetTitles(spreadsheetId: string, accessToken: string): Promise<string[]> {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`)
  url.searchParams.set('fields', 'sheets.properties.title')
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Sheets get failed for ${spreadsheetId}: ${res.status} ${await res.text()}`)
  const json = await res.json()
  return (json.sheets ?? []).map((s: { properties: { title: string } }) => s.properties.title)
}

async function getSheetValues(
  spreadsheetId: string,
  sheetTitle: string,
  accessToken: string,
): Promise<unknown[][]> {
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetTitle)}`,
  )
  url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE')
  url.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER')
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`Sheets values.get failed for ${spreadsheetId}!${sheetTitle}: ${res.status} ${await res.text()}`)
  const json = await res.json()
  return json.values ?? []
}

// Sheets/Excel serial date -> ISO (days since 1899-12-30, matching Sheets'
// own epoch, leap-year bug included — irrelevant for any date this contract
// could hold).
function dateFromSerial(serial: unknown): string | null {
  if (typeof serial !== 'number' || Number.isNaN(serial)) return null
  const ms = Date.UTC(1899, 11, 30) + serial * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

// NovaCore's own "19+385" notation parser, for the rare case a Log cell was
// hand-typed that way. Confirmed NOT the ordinary case (see
// stationKmFromLogValue below) — kept only as a fallback for that shape.
function parsePlusNotation(input: string): number | null {
  const plusIndex = input.indexOf('+')
  const km = Number(input.slice(0, plusIndex))
  const metres = Number(input.slice(plusIndex + 1))
  if (Number.isNaN(km) || Number.isNaN(metres)) return null
  return km + metres / 1000
}

// The Log's own From Sta/To Sta cells hold plain METRES, not km — confirmed
// against the source's own sta_() formatter (Math.floor(Math.abs(n)/1000) +
// '+' + ...), applied directly to this same raw stored number: 55440 ->
// "55+440". NovaCore's station_from/station_to are km (0004's own comment:
// "Chainage in km, as entered"), so the ordinary case is raw / 1000. A cell
// already written in "+" notation is treated as already being in km terms.
// No reordering when From > To — 0004 is explicit that station_from >
// station_to is meaningful (opposing-direction segments), not an error to
// normalise away, and this data's own SB rows confirm it (station_from >
// station_to on every one of them, matching Southbound decreasing chainage).
function stationKmFromLogValue(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isNaN(raw) ? null : raw / 1000
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed.includes('+')) return parsePlusNotation(trimmed)
  const n = Number(trimmed)
  return Number.isNaN(n) ? null : n / 1000
}

// NB/SB/EB/WB (the source's own vocabulary, confirmed) -> NovaCore's
// NBL/SBL/EBL/WBL. Deliberately a closed map with no fallback branch —
// anything not in this map is a fatal row error (see readLogSheet), never a
// default, per instruction: "fail loudly on anything that is not one of
// those four rather than defaulting."
const DIRECTION_MAP: Record<string, 'NBL' | 'SBL' | 'EBL' | 'WBL'> = {
  NB: 'NBL',
  SB: 'SBL',
  EB: 'EBL',
  WB: 'WBL',
}

function toNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isNaN(v) ? null : v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isNaN(n) ? null : n
  }
  return null
}

function toStringOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

// -----------------------------------------------------------------------------
// Header indexing — find the header row within the first 10 rows (title rows
// above it are tolerated), map normalised header text -> column index.
// -----------------------------------------------------------------------------

function normalizeHeader(h: unknown): string {
  return String(h ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function findHeaderRow(rows: unknown[][], mustContain: string[]): { headerRowIndex: number; colIndex: Record<string, number> } | null {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const row = rows[r]
    if (!row) continue
    const normalized = row.map(normalizeHeader)
    const hasAll = mustContain.every((needle) => normalized.includes(needle))
    if (hasAll) {
      const colIndex: Record<string, number> = {}
      normalized.forEach((h, i) => {
        if (h) colIndex[h] = i
      })
      return { headerRowIndex: r, colIndex }
    }
  }
  return null
}

// -----------------------------------------------------------------------------
// Types for the reconciliation payload
// -----------------------------------------------------------------------------

interface ParsedLogRow {
  itemNumber: string
  sheetRowNumber: number // 1-indexed, matches what a human sees in the Sheet
  shape: 'area' | 'entry'
  workDate: string | null
  workDateRaw: unknown
  jobSite: string | null
  direction: string | null
  lane: string | null
  stationFrom: number | null
  stationTo: number | null
  lengthM: number | null
  widthFrom: number | null
  widthTo: number | null
  areaM2: number | null
  whereNoStations: string | null
  tonnes: number | null
  lift: string | null
  quantity: number | null
  unit: string | null
  warnings: string[]
  fatal: boolean
}

interface ClosedRow {
  itemNumber: string
  workDate: string | null
  workDateRaw: unknown
  jobSite: string | null
  tonnage: number | null
  stoppedAt: unknown
  closedAt: unknown
}

interface DayTabTotal {
  itemNumber: string
  tabName: string
  total: number | null
  totalCellLabel: string | null
  rawSample?: unknown[][]
}

interface RowWarning {
  itemNumber: string
  sheet: string
  rowNumber: number | null
  message: string
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------

Deno.serve(async (_req) => {
  const warnings: RowWarning[] = []

  const saKeyRaw = Deno.env.get('GOOGLE_SA_HWY5_KEY')
  if (!saKeyRaw) {
    return jsonResponse({ error: 'GOOGLE_SA_HWY5_KEY secret is not set' }, 500)
  }
  const saKey: ServiceAccountKey = JSON.parse(saKeyRaw)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // ---- 1. NovaCore's own item list for 26607-0000 (read-only select) ------
  const { data: contract, error: contractError } = await supabase
    .from('contracts')
    .select('id, contract_name, contract_no')
    .eq('contract_no', CONTRACT_NO)
    .single()
  if (contractError || !contract) {
    return jsonResponse({ error: `Contract ${CONTRACT_NO} not found`, detail: contractError }, 500)
  }

  const { data: items, error: itemsError } = await supabase
    .from('items')
    .select('id, item_number, description, unit, item_kind, area_basis, approximate_quantity')
    .eq('contract_id', contract.id)
  if (itemsError || !items) {
    return jsonResponse({ error: 'Failed to read items', detail: itemsError }, 500)
  }
  const itemsByNumber = new Map(items.map((i) => [i.item_number, i]))

  // ---- 2. Google auth + folder walk ---------------------------------------
  const accessToken = await getGoogleAccessToken(saKey)
  const { spreadsheets, depthWarnings } = await walkFolderForSpreadsheets(FOLDER_ID, accessToken)

  // ---- 3. Match workbook filenames to item numbers -------------------------
  // Source names each workbook "<code>  <name>" (two spaces).
  const matched: { itemNumber: string; workbook: DriveFile }[] = []
  const unmatchedFilenames: string[] = []
  for (const wb of spreadsheets) {
    const m = wb.name.match(/^(\S+)\s{2,}(.*)$/)
    const code = m?.[1]
    if (code && itemsByNumber.has(code)) {
      matched.push({ itemNumber: code, workbook: wb })
    } else {
      unmatchedFilenames.push(wb.name)
    }
  }
  const matchedItemNumbers = new Set(matched.map((m) => m.itemNumber))
  const unitPriceItemsWithNoWorkbook = items
    .filter((i) => i.item_kind === 'unit_price' && !matchedItemNumbers.has(i.item_number))
    .map((i) => i.item_number)

  // ---- 4. Per-workbook: Log, Closed, Checks, day tabs ----------------------
  const logRows: ParsedLogRow[] = []
  const closedRows: ClosedRow[] = []
  const dayTabTotals: DayTabTotal[] = []
  const checksRaw: { itemNumber: string; sheet: string; header: string[]; rows: unknown[][] }[] = []
  const skippedOldLogSheets: { itemNumber: string; sheetName: string }[] = []

  for (const { itemNumber, workbook } of matched) {
    const item = itemsByNumber.get(itemNumber)!
    let titles: string[]
    try {
      titles = await getSheetTitles(workbook.id, accessToken)
    } catch (e) {
      warnings.push({ itemNumber, sheet: '(workbook)', rowNumber: null, message: `Could not read sheet list: ${String(e)}` })
      continue
    }

    for (const title of titles) {
      if (title.startsWith('Log (old')) {
        skippedOldLogSheets.push({ itemNumber, sheetName: title })
      }
    }

    // --- Log ---
    if (titles.includes('Log')) {
      await readLogSheet(workbook.id, itemNumber, item, accessToken, logRows, warnings)
    } else {
      warnings.push({ itemNumber, sheet: '(workbook)', rowNumber: null, message: 'No "Log" sheet found in this workbook.' })
    }

    // --- Closed ---
    if (titles.includes('Closed')) {
      await readClosedSheet(workbook.id, itemNumber, accessToken, closedRows, warnings)
    }

    // --- Checks (raw pass-through, no schema assumed) ---
    if (titles.includes('Checks')) {
      const rows = await getSheetValues(workbook.id, 'Checks', accessToken)
      if (rows.length > 0) {
        checksRaw.push({ itemNumber, sheet: 'Checks', header: (rows[0] ?? []).map(String), rows: rows.slice(1) })
      }
    }

    // --- Day tabs (for the independent TOTAL cross-check) ---
    for (const title of titles) {
      if (!DAY_TAB_PATTERN.test(title)) continue
      const total = await readDayTabTotal(workbook.id, itemNumber, title, accessToken, warnings)
      dayTabTotals.push(total)
    }
  }

  // ---- 5. Reconciliation: per item x work_date ------------------------------
  const reconciliation = buildReconciliation(logRows, closedRows, dayTabTotals, itemsByNumber, warnings)

  const dates = logRows.map((r) => r.workDate).filter((d): d is string => d !== null).sort()

  return jsonResponse({
    contract: { id: contract.id, name: contract.contract_name, contractNo: contract.contract_no },
    folder: { id: FOLDER_ID, depthWarnings },
    workbooks: {
      totalFound: spreadsheets.length,
      matchedCount: matched.length,
      unmatchedFilenames,
      unitPriceItemsWithNoWorkbook,
    },
    skippedOldLogSheets,
    logRows: {
      totalParsed: logRows.length,
      byItem: countByItem(logRows.map((r) => r.itemNumber)),
      fatalRowCount: logRows.filter((r) => r.fatal).length,
    },
    dateRange: dates.length > 0 ? { min: dates[0], max: dates[dates.length - 1] } : null,
    reconciliation,
    logRowDetail: logRows,
    checks: checksRaw,
    dayTabTotals,
    warnings,
  })
})

// -----------------------------------------------------------------------------
// Sheet readers
// -----------------------------------------------------------------------------

async function readLogSheet(
  spreadsheetId: string,
  itemNumber: string,
  item: { area_basis: string | null; unit: string },
  accessToken: string,
  out: ParsedLogRow[],
  warnings: RowWarning[],
): Promise<void> {
  const rows = await getSheetValues(spreadsheetId, 'Log', accessToken)
  const header = findHeaderRow(rows, ['date', 'item'])
  if (!header) {
    warnings.push({ itemNumber, sheet: 'Log', rowNumber: null, message: 'Could not find a header row (looked for "Date"/"Item" in the first 10 rows).' })
    return
  }
  const { headerRowIndex, colIndex } = header
  const isAreaShape = 'width from (m)' in colIndex || 'area (m²)' in colIndex || 'area (m2)' in colIndex
  const isEntryShape = 'quantity' in colIndex && 'unit' in colIndex

  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.every((c) => c === undefined || c === null || c === '')) continue
    const sheetRowNumber = r + 1
    const get = (name: string) => (colIndex[name] !== undefined ? row[colIndex[name]] : undefined)

    const workDateRaw = get('date')
    const workDate = dateFromSerial(workDateRaw)
    const rowWarnings: string[] = []
    if (workDateRaw !== undefined && workDate === null) {
      rowWarnings.push(`Date cell did not parse as a serial date: ${JSON.stringify(workDateRaw)}`)
    }

    const directionRaw = toStringOrNull(get('direction'))
    let direction: string | null = null
    let rowFatal = false
    if (directionRaw !== null) {
      const mapped = DIRECTION_MAP[directionRaw]
      if (mapped) {
        direction = mapped
      } else {
        rowWarnings.push(`FATAL: direction "${directionRaw}" is not NB/SB/EB/WB — not mapped, not defaulted, this row cannot land until resolved.`)
        rowFatal = true
      }
    }

    const stationFromRaw = get('from sta')
    const stationToRaw = get('to sta')
    const stationFrom = stationKmFromLogValue(stationFromRaw)
    const stationTo = stationKmFromLogValue(stationToRaw)
    if (stationFromRaw !== undefined && stationFromRaw !== '' && stationFrom === null) {
      rowWarnings.push(`From Sta did not parse: ${JSON.stringify(stationFromRaw)}`)
    }
    if (stationToRaw !== undefined && stationToRaw !== '' && stationTo === null) {
      rowWarnings.push(`To Sta did not parse: ${JSON.stringify(stationToRaw)}`)
    }

    const tonnes = toNumberOrNull(get('tonnes'))
    const isSegTonnesItem = SEG_TONNES_ITEMS.has(itemNumber)
    if (isSegTonnesItem && tonnes === null) {
      rowWarnings.push('Item is a per-measurement tonnage item (SEG_TONNES) but this Log row has no Tonnes value.')
    }
    if (!isSegTonnesItem && item.area_basis === 'separately_measured' && tonnes !== null) {
      rowWarnings.push('Item is expected to take tonnage from the day Close, but this Log row has its own Tonnes value.')
    }

    const areaM2 = toNumberOrNull(get('area (m²)') ?? get('area (m2)'))
    const widthFrom = toNumberOrNull(get('width from (m)'))
    const widthTo = toNumberOrNull(get('width to (m)'))
    if (widthFrom !== null && widthTo !== null && stationFrom !== null && stationTo !== null && areaM2 !== null) {
      const avgWidth = (widthFrom + widthTo) / 2
      const reachM = (stationTo - stationFrom) * 1000
      const computed = avgWidth * reachM
      if (Math.abs(computed - areaM2) >= AREA_EPSILON) {
        rowWarnings.push(`Entered area (${areaM2} m²) disagrees with width × reach (${computed.toFixed(2)} m²) — expected under this contract's own standing rule, not itself an error, but recorded for the report.`)
      }
    }

    const parsed: ParsedLogRow = {
      itemNumber,
      sheetRowNumber,
      shape: isAreaShape ? 'area' : 'entry',
      workDate,
      workDateRaw,
      jobSite: toStringOrNull(get('job site')),
      direction,
      lane: toStringOrNull(get('lane')),
      stationFrom,
      stationTo,
      lengthM: toNumberOrNull(get('length (m)')),
      widthFrom,
      widthTo,
      areaM2,
      whereNoStations: toStringOrNull(get('where (no stations)') ?? get('where')),
      tonnes,
      lift: toStringOrNull(get('lift')),
      quantity: isEntryShape ? toNumberOrNull(get('quantity')) : null,
      unit: isEntryShape ? toStringOrNull(get('unit')) : null,
      warnings: rowWarnings,
      fatal: rowFatal,
    }
    out.push(parsed)
    for (const w of rowWarnings) {
      warnings.push({ itemNumber, sheet: 'Log', rowNumber: sheetRowNumber, message: w })
    }
  }
}

async function readClosedSheet(
  spreadsheetId: string,
  itemNumber: string,
  accessToken: string,
  out: ClosedRow[],
  warnings: RowWarning[],
): Promise<void> {
  const rows = await getSheetValues(spreadsheetId, 'Closed', accessToken)
  const header = findHeaderRow(rows, ['date', 'tonnage'])
  if (!header) {
    warnings.push({ itemNumber, sheet: 'Closed', rowNumber: null, message: 'Could not find a header row (looked for "Date"/"Tonnage" in the first 10 rows).' })
    return
  }
  const { headerRowIndex, colIndex } = header
  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.every((c) => c === undefined || c === null || c === '')) continue
    const get = (name: string) => (colIndex[name] !== undefined ? row[colIndex[name]] : undefined)
    const workDateRaw = get('date')
    out.push({
      itemNumber,
      workDate: dateFromSerial(workDateRaw),
      workDateRaw,
      jobSite: toStringOrNull(get('job site')),
      tonnage: toNumberOrNull(get('tonnage')),
      stoppedAt: get('stopped at') ?? null,
      closedAt: get('closed at') ?? null,
    })
  }
}

async function readDayTabTotal(
  spreadsheetId: string,
  itemNumber: string,
  tabName: string,
  accessToken: string,
  warnings: RowWarning[],
): Promise<DayTabTotal> {
  const rows = await getSheetValues(spreadsheetId, tabName, accessToken)
  // Heuristic: last row containing a cell that reads "total" (case-insensitive),
  // taking the first numeric value elsewhere in that row as the figure.
  for (let r = rows.length - 1; r >= 0; r--) {
    const row = rows[r]
    if (!row) continue
    const labelIdx = row.findIndex((c) => typeof c === 'string' && c.trim().toLowerCase().includes('total'))
    if (labelIdx === -1) continue
    const numeric = row.find((c, i) => i !== labelIdx && typeof c === 'number')
    if (typeof numeric === 'number') {
      return { itemNumber, tabName, total: numeric, totalCellLabel: String(row[labelIdx]) }
    }
  }
  warnings.push({ itemNumber, sheet: tabName, rowNumber: null, message: 'Could not locate a "Total" row with an adjacent numeric value in this day tab — read the tab manually.' })
  // Diagnostic only — the payload stays small since day tabs are one day's
  // worth of rows. Lets the reconciliation report show the actual layout
  // instead of just "couldn't find it" for a heuristic worth improving.
  return { itemNumber, tabName, total: null, totalCellLabel: null, rawSample: rows.slice(0, 40) }
}

// -----------------------------------------------------------------------------
// Reconciliation
// -----------------------------------------------------------------------------

function buildReconciliation(
  logRows: ParsedLogRow[],
  closedRows: ClosedRow[],
  dayTabTotals: DayTabTotal[],
  itemsByNumber: Map<string, { unit: string; area_basis: string | null }>,
  warnings: RowWarning[],
) {
  type Key = string // `${itemNumber}|${workDate}`
  const groups = new Map<Key, ParsedLogRow[]>()
  for (const row of logRows) {
    if (row.workDate === null) continue
    const key = `${row.itemNumber}|${row.workDate}`
    const arr = groups.get(key) ?? []
    arr.push(row)
    groups.set(key, arr)
  }

  const closedByKey = new Map<Key, ClosedRow>()
  for (const c of closedRows) {
    if (c.workDate === null) continue
    closedByKey.set(`${c.itemNumber}|${c.workDate}`, c)
  }

  const dayTabByItem = new Map<string, DayTabTotal[]>()
  for (const d of dayTabTotals) {
    const arr = dayTabByItem.get(d.itemNumber) ?? []
    arr.push(d)
    dayTabByItem.set(d.itemNumber, arr)
  }

  const results: Array<{
    itemNumber: string
    workDate: string
    rowCount: number
    logSumQuantity: number | null
    closedTonnage: number | null
    dayTabTotal: number | null
    dayTabName: string | null
    divergences: string[]
  }> = []

  for (const [key, rows] of groups) {
    const [itemNumber, workDate] = key.split('|')
    const isSegTonnesItem = SEG_TONNES_ITEMS.has(itemNumber)
    const hasOwnTonnes = rows.every((r) => r.tonnes !== null)
    const logSumTonnes = rows.reduce((sum, r) => sum + (r.tonnes ?? 0), 0)
    const logSumQuantity = rows.every((r) => r.quantity !== null)
      ? rows.reduce((sum, r) => sum + (r.quantity ?? 0), 0)
      : (hasOwnTonnes ? logSumTonnes : null)

    const closed = closedByKey.get(key)
    const closedTonnage = closed?.tonnage ?? null

    // Match a day tab by name convention "<day> <mon>-B<n>" — cannot derive
    // the exact tab name from workDate alone without knowing the job's own
    // "B<n>" suffix, so match any day-tab for this item whose date portion
    // matches workDate's day+month; ambiguity is reported, not resolved.
    const candidateTabs = (dayTabByItem.get(itemNumber) ?? []).filter((t) => {
      const dayMonth = t.tabName.match(/^(\d{1,2}\s+[A-Za-z]{3})-B\d+$/)?.[1]
      if (!dayMonth) return false
      const d = new Date(`${workDate}T00:00:00Z`)
      const expected = `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`
      return dayMonth === expected
    })

    // The per-measurement-vs-per-day tonnage question only means anything
    // for a Tonne-unit item — applying it to e.g. a Metre-unit barrier item
    // (which has no Tonnes column concept at all) produced a false "missing
    // tonnage" divergence on the first live run. Gated on unit, not on
    // area_basis alone, since area_basis is null for some Tonne items too
    // (the Litre carve-out doesn't apply here, but the same shape of bug
    // would).
    const item = itemsByNumber.get(itemNumber)
    const isTonnageItem = item?.unit === 'Tonne'

    const divergences: string[] = []
    if (isTonnageItem && isSegTonnesItem) {
      if (closedTonnage !== null) {
        divergences.push(`Item is per-measurement (SEG_TONNES) but a Closed row also exists for this date — Closed's ${closedTonnage} t is not expected to apply here; reported, not used.`)
      }
      if (logSumQuantity !== null && closedTonnage !== null && Math.abs(logSumQuantity - closedTonnage) > 0.01) {
        divergences.push(`Log sum (${logSumQuantity} t) vs Closed (${closedTonnage} t) differ by ${(logSumQuantity - closedTonnage).toFixed(2)} t.`)
      }
    } else if (isTonnageItem) {
      if (!hasOwnTonnes && closedTonnage === null) {
        divergences.push('No per-row Tonnes and no matching Closed row for this item/date — cannot land a tonnage figure for this day.')
      }
      if (hasOwnTonnes && closedTonnage !== null && Math.abs(logSumTonnes - closedTonnage) > 0.01) {
        divergences.push(`Log rows carry their own Tonnes (sum ${logSumTonnes} t) AND a Closed row exists (${closedTonnage} t) — they differ by ${(logSumTonnes - closedTonnage).toFixed(2)} t; which is authoritative is not decided here.`)
      }
    }

    let dayTabTotal: number | null = null
    let dayTabName: string | null = null
    if (candidateTabs.length === 1) {
      dayTabTotal = candidateTabs[0].total
      dayTabName = candidateTabs[0].tabName
      const landed = closedTonnage ?? logSumQuantity
      if (dayTabTotal !== null && landed !== null && Math.abs(dayTabTotal - landed) > 0.01) {
        divergences.push(`Day tab "${dayTabName}" TOTAL (${dayTabTotal}) differs from what would land (${landed}) by ${(dayTabTotal - landed).toFixed(2)}.`)
      }
    } else if (candidateTabs.length > 1) {
      divergences.push(`${candidateTabs.length} day tabs matched this date ambiguously (${candidateTabs.map((t) => t.tabName).join(', ')}) — not resolved automatically.`)
    }

    results.push({
      itemNumber,
      workDate,
      rowCount: rows.length,
      logSumQuantity,
      closedTonnage,
      dayTabTotal,
      dayTabName,
      divergences,
    })

    for (const d of divergences) {
      warnings.push({ itemNumber, sheet: '(reconciliation)', rowNumber: null, message: `${workDate}: ${d}` })
    }
  }

  return results.sort((a, b) => (a.itemNumber + a.workDate).localeCompare(b.itemNumber + b.workDate))
}

function countByItem(itemNumbers: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const n of itemNumbers) out[n] = (out[n] ?? 0) + 1
  return out
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
