import type { ItemKind } from '../supabase/items'

export interface ParsedItemRow {
  /** 1-based line number in the pasted text, for pointing a person back at what they typed. */
  line: number
  itemNumber: string
  description: string
  unit: string
  itemKind: ItemKind | null
  /** null means "not a valid number" — 0 is a real, entered zero, not the same thing. */
  approximateQuantity: number | null
  errors: string[]
}

export interface ParseItemsPasteResult {
  rows: ParsedItemRow[]
  /** The line number of a detected, silently-skipped header row — null if none was found. */
  skippedHeaderLine: number | null
  delimiter: 'tab' | 'comma' | null
}

const EXPECTED_COLUMNS = 5

/**
 * Schedule 7's own three words, plus the vocabulary this schema already
 * uses internally — both readings accepted since a pasted block is
 * transcribed from the tender document, which never says "unit_price".
 */
function normalizeItemKind(raw: string): ItemKind | null {
  const key = raw.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ')
  switch (key) {
    case 'unit_price':
    case 'unit price':
      return 'unit_price'
    case 'lump_sum':
    case 'lump sum':
      return 'lump_sum'
    case 'provisional_sum':
    case 'provisional sum':
    case 'prov sum':
    case 'provisional':
      return 'provisional_sum'
    default:
      return null
  }
}

function parseQuantity(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  // Strip thousands separators a pasted spreadsheet cell commonly carries
  // (1,000 rather than 1000) — the paste is a transcription, not a typed
  // number, so this is the one place worth being lenient about formatting.
  const cleaned = trimmed.replace(/,/g, '')
  const n = Number(cleaned)
  if (Number.isNaN(n) || n < 0) return null
  return n
}

/**
 * Splits one pasted line into its 5 expected cells, respecting whichever
 * delimiter the whole paste used (never mixed mid-block — decided once,
 * from the first line that contains either).
 */
function splitLine(line: string, delimiter: 'tab' | 'comma'): string[] {
  return line.split(delimiter === 'tab' ? '\t' : ',').map((cell) => cell.trim())
}

function detectDelimiter(lines: string[]): 'tab' | 'comma' | null {
  for (const line of lines) {
    if (line.trim() === '') continue
    if (line.includes('\t')) return 'tab'
    if (line.includes(',')) return 'comma'
  }
  return null
}

/**
 * Looks like a header ("Item #", "Description", ...) rather than a real
 * row: its quantity cell isn't a number AND its kind cell isn't a
 * recognized kind. A real row always has at least one of the two right,
 * even if the other is wrong — a header line has neither, which is what
 * distinguishes it from an ordinary bad row worth surfacing as an error.
 */
function looksLikeHeader(cells: string[]): boolean {
  const kindCell = cells[3] ?? ''
  const qtyCell = cells[4] ?? ''
  return normalizeItemKind(kindCell) === null && parseQuantity(qtyCell) === null && qtyCell.trim() !== ''
}

/**
 * Parses a pasted block of Schedule 7 Items — one Item per line, cells
 * separated by TAB (a direct copy-paste from Excel/Google Sheets) or comma
 * (literal CSV text pasted in) — auto-detected from whichever appears
 * first, never both in the same paste. Columns, in order: Item Number,
 * Description, Unit, Item Kind, Approximate Quantity. Item Kind accepts
 * both this schema's own vocabulary (unit_price) and Schedule 7's own
 * words (Unit Price) — see normalizeItemKind. Approximate Quantity may be
 * blank for a Lump Sum/Provisional Sum row (reads as 0, matching the
 * column's own NOT NULL DEFAULT 0) but is required for a Unit Price row,
 * where it's a real measurement basis.
 *
 * Never silently drops a bad row — every line becomes a ParsedItemRow,
 * blank ones aside, with its own errors array. Duplicate Item Numbers
 * within the pasted batch are flagged on every row that repeats one (not
 * just the second occurrence), so fixing any one of them is enough to see
 * the flag clear on re-parse.
 */
export function parseItemsPaste(text: string): ParseItemsPasteResult {
  const allLines = text.split(/\r\n|\r|\n/)
  const delimiter = detectDelimiter(allLines)

  const rows: ParsedItemRow[] = []
  let skippedHeaderLine: number | null = null
  let sawFirstDataLine = false

  allLines.forEach((rawLine, index) => {
    if (rawLine.trim() === '') return
    const lineNumber = index + 1
    const cells = delimiter ? splitLine(rawLine, delimiter) : [rawLine.trim()]

    if (!sawFirstDataLine && skippedHeaderLine === null && looksLikeHeader(cells)) {
      skippedHeaderLine = lineNumber
      return
    }
    sawFirstDataLine = true

    const errors: string[] = []
    if (cells.length !== EXPECTED_COLUMNS) {
      errors.push(`Expected ${EXPECTED_COLUMNS} columns (Item #, Description, Unit, Kind, Approx. Qty) — found ${cells.length}.`)
    }
    const itemNumber = cells[0] ?? ''
    const description = cells[1] ?? ''
    const unit = cells[2] ?? ''
    const kindCell = cells[3] ?? ''
    const qtyCell = cells[4] ?? ''

    if (itemNumber === '') errors.push('Item # is missing.')
    if (description === '') errors.push('Description is missing.')
    if (unit === '') errors.push('Unit is missing.')

    const itemKind = normalizeItemKind(kindCell)
    if (itemKind === null) errors.push(`"${kindCell}" is not a recognized Item kind (Unit Price, Lump Sum, or Provisional Sum).`)

    const approximateQuantity = parseQuantity(qtyCell)
    if (itemKind === 'unit_price' && approximateQuantity === null) {
      errors.push('Approximate Quantity is required for a Unit Price Item.')
    } else if (approximateQuantity === null && qtyCell.trim() !== '') {
      errors.push(`"${qtyCell}" is not a valid quantity.`)
    }

    rows.push({
      line: lineNumber,
      itemNumber,
      description,
      unit,
      itemKind,
      approximateQuantity: approximateQuantity ?? (itemKind !== null && itemKind !== 'unit_price' ? 0 : null),
      errors,
    })
  })

  const countByItemNumber = new Map<string, number>()
  for (const row of rows) {
    if (row.itemNumber === '') continue
    countByItemNumber.set(row.itemNumber, (countByItemNumber.get(row.itemNumber) ?? 0) + 1)
  }
  for (const row of rows) {
    if (row.itemNumber !== '' && (countByItemNumber.get(row.itemNumber) ?? 0) > 1) {
      row.errors.push(`Item # "${row.itemNumber}" appears more than once in this paste.`)
    }
  }

  return { rows, skippedHeaderLine, delimiter }
}
