import { supabase } from './client'

// ---------------------------------------------------------------------------
// Equipment — identity open-read, rates keyed by Blue Book edition (book
// year), not a column on the machine. See rateHistory.ts for how a rate is
// meant to be read back out of the array these fetches return — never a
// bare "current rate," always "as of when."
// ---------------------------------------------------------------------------

export interface Equipment {
  id: string
  equipmentType: string
  year: number | null
  make: string | null
  model: string | null
}

export interface EquipmentRate {
  id: string
  equipmentId: string
  bookYear: number
  /** What gets billed — the BC Road Builders Equipment Rental Rate Guide figure someone typed for this machine. Never imported or embedded; this is Keywest's own entry only. */
  blueBookRate: number | null
  /** What it actually costs — an operator's own judgement, independent of the Blue Book figure. Never computed from it. */
  internalRate: number | null
}

interface RawEquipmentRow {
  id: string
  equipment_type: string
  year: number | null
  make: string | null
  model: string | null
}

function mapEquipmentRow(row: RawEquipmentRow): Equipment {
  return { id: row.id, equipmentType: row.equipment_type, year: row.year, make: row.make, model: row.model }
}

const EQUIPMENT_SELECT = 'id, equipment_type, year, make, model'

export async function fetchEquipment(): Promise<Equipment[]> {
  const { data, error } = await supabase.from('equipment').select(EQUIPMENT_SELECT).order('equipment_type')
  if (error) throw error
  return (data ?? []).map((row) => mapEquipmentRow(row as unknown as RawEquipmentRow))
}

export interface EquipmentInput {
  equipmentType: string
  year: number | null
  make: string | null
  model: string | null
}

export async function createEquipment(input: EquipmentInput): Promise<Equipment> {
  const { data, error } = await supabase
    .from('equipment')
    .insert({ equipment_type: input.equipmentType, year: input.year, make: input.make, model: input.model })
    .select(EQUIPMENT_SELECT)
    .single()
  if (error) throw error
  return mapEquipmentRow(data as unknown as RawEquipmentRow)
}

export async function updateEquipment(id: string, input: EquipmentInput): Promise<Equipment> {
  const { data, error } = await supabase
    .from('equipment')
    .update({ equipment_type: input.equipmentType, year: input.year, make: input.make, model: input.model })
    .eq('id', id)
    .select(EQUIPMENT_SELECT)
    .single()
  if (error) throw error
  return mapEquipmentRow(data as unknown as RawEquipmentRow)
}

interface RawEquipmentRateRow {
  id: string
  equipment_id: string
  book_year: number
  blue_book_rate: string | null
  internal_rate: string | null
}

function mapEquipmentRateRow(row: RawEquipmentRateRow): EquipmentRate {
  return {
    id: row.id,
    equipmentId: row.equipment_id,
    bookYear: row.book_year,
    blueBookRate: row.blue_book_rate === null ? null : Number(row.blue_book_rate),
    internalRate: row.internal_rate === null ? null : Number(row.internal_rate),
  }
}

const EQUIPMENT_RATE_SELECT = 'id, equipment_id, book_year, blue_book_rate, internal_rate'

/** Every equipment_rates row across every machine — empty for a seat lacking view_cost_register_rates AND maintain_cost_registers (RLS), same absent-means-no-rights-or-no-data shape as item_prices. */
export async function fetchEquipmentRates(): Promise<EquipmentRate[]> {
  const { data, error } = await supabase.from('equipment_rates').select(EQUIPMENT_RATE_SELECT)
  if (error) throw error
  return (data ?? []).map((row) => mapEquipmentRateRow(row as unknown as RawEquipmentRateRow))
}

export interface EquipmentRateInput {
  bookYear: number
  blueBookRate: number | null
  internalRate: number | null
}

/** Upsert on (equipment_id, book_year) — the same year corrected in place, a new year always a new row. */
export async function upsertEquipmentRate(equipmentId: string, input: EquipmentRateInput): Promise<EquipmentRate> {
  const { data, error } = await supabase
    .from('equipment_rates')
    .upsert(
      { equipment_id: equipmentId, book_year: input.bookYear, blue_book_rate: input.blueBookRate, internal_rate: input.internalRate },
      { onConflict: 'equipment_id,book_year' },
    )
    .select(EQUIPMENT_RATE_SELECT)
    .single()
  if (error) throw error
  return mapEquipmentRateRow(data as unknown as RawEquipmentRateRow)
}

// ---------------------------------------------------------------------------
// Labour — classes (identity) + rates (effective_date history) + the two
// payroll percentages (company-wide, effective_date history, no entity id).
// ---------------------------------------------------------------------------

export interface LabourClass {
  id: string
  className: string
}

export interface LabourClassRate {
  id: string
  labourClassId: string
  hourlyRate: number
  effectiveDate: string
}

interface RawLabourClassRow {
  id: string
  class_name: string
}

function mapLabourClassRow(row: RawLabourClassRow): LabourClass {
  return { id: row.id, className: row.class_name }
}

const LABOUR_CLASS_SELECT = 'id, class_name'

export async function fetchLabourClasses(): Promise<LabourClass[]> {
  const { data, error } = await supabase.from('labour_classes').select(LABOUR_CLASS_SELECT).order('class_name')
  if (error) throw error
  return (data ?? []).map((row) => mapLabourClassRow(row as unknown as RawLabourClassRow))
}

export async function createLabourClass(className: string): Promise<LabourClass> {
  const { data, error } = await supabase.from('labour_classes').insert({ class_name: className }).select(LABOUR_CLASS_SELECT).single()
  if (error) throw error
  return mapLabourClassRow(data as unknown as RawLabourClassRow)
}

export async function updateLabourClass(id: string, className: string): Promise<LabourClass> {
  const { data, error } = await supabase.from('labour_classes').update({ class_name: className }).eq('id', id).select(LABOUR_CLASS_SELECT).single()
  if (error) throw error
  return mapLabourClassRow(data as unknown as RawLabourClassRow)
}

interface RawLabourClassRateRow {
  id: string
  labour_class_id: string
  hourly_rate: string
  effective_date: string
}

function mapLabourClassRateRow(row: RawLabourClassRateRow): LabourClassRate {
  return { id: row.id, labourClassId: row.labour_class_id, hourlyRate: Number(row.hourly_rate), effectiveDate: row.effective_date }
}

const LABOUR_CLASS_RATE_SELECT = 'id, labour_class_id, hourly_rate, effective_date'

export async function fetchLabourClassRates(): Promise<LabourClassRate[]> {
  const { data, error } = await supabase.from('labour_class_rates').select(LABOUR_CLASS_RATE_SELECT)
  if (error) throw error
  return (data ?? []).map((row) => mapLabourClassRateRow(row as unknown as RawLabourClassRateRow))
}

/** Upsert on (labour_class_id, effective_date) — same date corrected in place, a new date always a new row (a new history entry, never a silent overwrite of the old one). */
export async function upsertLabourClassRate(labourClassId: string, hourlyRate: number, effectiveDate: string): Promise<LabourClassRate> {
  const { data, error } = await supabase
    .from('labour_class_rates')
    .upsert({ labour_class_id: labourClassId, hourly_rate: hourlyRate, effective_date: effectiveDate }, { onConflict: 'labour_class_id,effective_date' })
    .select(LABOUR_CLASS_RATE_SELECT)
    .single()
  if (error) throw error
  return mapLabourClassRateRow(data as unknown as RawLabourClassRateRow)
}

export interface PercentRate {
  id: string
  percent: number
  effectiveDate: string
}

interface RawPercentRow {
  id: string
  percent: string
  effective_date: string
}

function mapPercentRow(row: RawPercentRow): PercentRate {
  return { id: row.id, percent: Number(row.percent), effectiveDate: row.effective_date }
}

const PERCENT_SELECT = 'id, percent, effective_date'

export async function fetchPayrollAdditiveRates(): Promise<PercentRate[]> {
  const { data, error } = await supabase.from('payroll_additive_rates').select(PERCENT_SELECT)
  if (error) throw error
  return (data ?? []).map((row) => mapPercentRow(row as unknown as RawPercentRow))
}

export async function upsertPayrollAdditiveRate(percent: number, effectiveDate: string): Promise<PercentRate> {
  const { data, error } = await supabase
    .from('payroll_additive_rates')
    .upsert({ percent, effective_date: effectiveDate }, { onConflict: 'effective_date' })
    .select(PERCENT_SELECT)
    .single()
  if (error) throw error
  return mapPercentRow(data as unknown as RawPercentRow)
}

export async function fetchToolAllowanceRates(): Promise<PercentRate[]> {
  const { data, error } = await supabase.from('tool_allowance_rates').select(PERCENT_SELECT)
  if (error) throw error
  return (data ?? []).map((row) => mapPercentRow(row as unknown as RawPercentRow))
}

export async function upsertToolAllowanceRate(percent: number, effectiveDate: string): Promise<PercentRate> {
  const { data, error } = await supabase
    .from('tool_allowance_rates')
    .upsert({ percent, effective_date: effectiveDate }, { onConflict: 'effective_date' })
    .select(PERCENT_SELECT)
    .single()
  if (error) throw error
  return mapPercentRow(data as unknown as RawPercentRow)
}

// ---------------------------------------------------------------------------
// Materials — identity + effective_date-keyed rate history, same shape as
// labour classes. Purchased-vs-stock is deliberately not a field here — see
// materials' own table comment in the migration.
// ---------------------------------------------------------------------------

export interface Material {
  id: string
  description: string
  unit: string
}

export interface MaterialRate {
  id: string
  materialId: string
  rate: number
  effectiveDate: string
}

interface RawMaterialRow {
  id: string
  description: string
  unit: string
}

function mapMaterialRow(row: RawMaterialRow): Material {
  return { id: row.id, description: row.description, unit: row.unit }
}

const MATERIAL_SELECT = 'id, description, unit'

export async function fetchMaterials(): Promise<Material[]> {
  const { data, error } = await supabase.from('materials').select(MATERIAL_SELECT).order('description')
  if (error) throw error
  return (data ?? []).map((row) => mapMaterialRow(row as unknown as RawMaterialRow))
}

export async function createMaterial(description: string, unit: string): Promise<Material> {
  const { data, error } = await supabase.from('materials').insert({ description, unit }).select(MATERIAL_SELECT).single()
  if (error) throw error
  return mapMaterialRow(data as unknown as RawMaterialRow)
}

export async function updateMaterial(id: string, description: string, unit: string): Promise<Material> {
  const { data, error } = await supabase.from('materials').update({ description, unit }).eq('id', id).select(MATERIAL_SELECT).single()
  if (error) throw error
  return mapMaterialRow(data as unknown as RawMaterialRow)
}

interface RawMaterialRateRow {
  id: string
  material_id: string
  rate: string
  effective_date: string
}

function mapMaterialRateRow(row: RawMaterialRateRow): MaterialRate {
  return { id: row.id, materialId: row.material_id, rate: Number(row.rate), effectiveDate: row.effective_date }
}

const MATERIAL_RATE_SELECT = 'id, material_id, rate, effective_date'

export async function fetchMaterialRates(): Promise<MaterialRate[]> {
  const { data, error } = await supabase.from('material_rates').select(MATERIAL_RATE_SELECT)
  if (error) throw error
  return (data ?? []).map((row) => mapMaterialRateRow(row as unknown as RawMaterialRateRow))
}

export async function upsertMaterialRate(materialId: string, rate: number, effectiveDate: string): Promise<MaterialRate> {
  const { data, error } = await supabase
    .from('material_rates')
    .upsert({ material_id: materialId, rate, effective_date: effectiveDate }, { onConflict: 'material_id,effective_date' })
    .select(MATERIAL_RATE_SELECT)
    .single()
  if (error) throw error
  return mapMaterialRateRow(data as unknown as RawMaterialRateRow)
}
