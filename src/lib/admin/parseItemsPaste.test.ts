import { describe, expect, it } from 'vitest'
import { parseItemsPaste } from './parseItemsPaste'

describe('parseItemsPaste', () => {
  it('parses a tab-delimited paste (a direct copy from Excel/Sheets)', () => {
    const result = parseItemsPaste('03.01.01\tAsphalt Medium Mix Aggregate\ttonne\tunit_price\t18000')
    expect(result.delimiter).toBe('tab')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      itemNumber: '03.01.01',
      description: 'Asphalt Medium Mix Aggregate',
      unit: 'tonne',
      itemKind: 'unit_price',
      approximateQuantity: 18000,
      errors: [],
    })
  })

  it('parses a comma-delimited paste (literal CSV text)', () => {
    const result = parseItemsPaste('03.01.01,Asphalt Medium Mix Aggregate,tonne,unit_price,18000')
    expect(result.delimiter).toBe('comma')
    expect(result.rows[0].errors).toEqual([])
  })

  it("accepts Schedule 7's own words for Item kind, not just this schema's vocabulary", () => {
    const result = parseItemsPaste(
      ['02.01\tMobilization\tLump Sum\tLump Sum\t', '05.03\tSite Modifications\tallowance\tProvisional Sum\t150000', '03.01\tPaving\ttonne\tUnit Price\t20000'].join('\n'),
    )
    expect(result.rows.map((r) => r.itemKind)).toEqual(['lump_sum', 'provisional_sum', 'unit_price'])
    expect(result.rows.every((r) => r.errors.length === 0)).toBe(true)
  })

  it('defaults a blank Approximate Quantity to 0 for Lump Sum/Provisional Sum, without an error', () => {
    const result = parseItemsPaste('02.01\tMobilization\tLump Sum\tlump_sum\t')
    expect(result.rows[0].approximateQuantity).toBe(0)
    expect(result.rows[0].errors).toEqual([])
  })

  it('requires Approximate Quantity for a Unit Price Item — blank is an error, not a silent 0', () => {
    const result = parseItemsPaste('03.01\tPaving\ttonne\tunit_price\t')
    expect(result.rows[0].approximateQuantity).toBeNull()
    expect(result.rows[0].errors).toContain('Approximate Quantity is required for a Unit Price Item.')
  })

  it('strips thousands separators from a pasted quantity cell', () => {
    const result = parseItemsPaste('03.01\tPaving\ttonne\tunit_price\t18,000')
    expect(result.rows[0].approximateQuantity).toBe(18000)
    expect(result.rows[0].errors).toEqual([])
  })

  it('flags every row sharing a duplicated Item #, not just the second one', () => {
    const result = parseItemsPaste(['03.01\tA\ttonne\tunit_price\t1', '03.01\tB\ttonne\tunit_price\t2'].join('\n'))
    expect(result.rows[0].errors.some((e) => e.includes('appears more than once'))).toBe(true)
    expect(result.rows[1].errors.some((e) => e.includes('appears more than once'))).toBe(true)
  })

  it('detects and silently skips a header row', () => {
    const result = parseItemsPaste(['Item #\tDescription\tUnit\tKind\tApprox. Qty', '03.01\tPaving\ttonne\tunit_price\t1000'].join('\n'))
    expect(result.skippedHeaderLine).toBe(1)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].itemNumber).toBe('03.01')
  })

  it('does not mistake a genuinely bad first row for a header — a header has BOTH kind and quantity unrecognizable', () => {
    const result = parseItemsPaste('03.01\tPaving\ttonne\tnonsense\t1000')
    expect(result.skippedHeaderLine).toBeNull()
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].errors.some((e) => e.includes('not a recognized Item kind'))).toBe(true)
  })

  it('flags a row with the wrong number of columns', () => {
    const result = parseItemsPaste('03.01\tPaving\ttonne\tunit_price')
    expect(result.rows[0].errors.some((e) => e.includes('Expected 5 columns'))).toBe(true)
  })

  it('flags missing required text fields', () => {
    const result = parseItemsPaste('\t\ttonne\tunit_price\t100')
    expect(result.rows[0].errors).toEqual(expect.arrayContaining(['Item # is missing.', 'Description is missing.']))
  })

  it('ignores blank lines between rows', () => {
    const result = parseItemsPaste(['03.01\tPaving\ttonne\tunit_price\t1000', '', '03.02\tMilling\ttonne\tunit_price\t2000'].join('\n'))
    expect(result.rows).toHaveLength(2)
  })

  it('reports null delimiter for a single bare cell with nothing to split on', () => {
    const result = parseItemsPaste('just one cell with no delimiter at all\n')
    // A comma-free, tab-free line: delimiter detection finds nothing, and
    // the line becomes one column — which then correctly fails the
    // "5 columns expected" check rather than being silently accepted.
    expect(result.delimiter).toBeNull()
    expect(result.rows[0].errors.some((e) => e.includes('Expected 5 columns'))).toBe(true)
  })
})
