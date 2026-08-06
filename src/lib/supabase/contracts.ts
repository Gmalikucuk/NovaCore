import { supabase } from './client'

/**
 * Set by a person, never inferred from contract_end or any other date — a
 * contract can be finished before its own end date (Venables: paving done
 * July 31, period ends August 10) or still active past it. No enforced
 * transition graph; pipeline -> active -> warranty_period -> closed_out ->
 * archived is the expected path, not a constraint.
 */
export type ContractState = 'pipeline' | 'active' | 'warranty_period' | 'closed_out' | 'archived'

export interface ContractRights {
  createItems: boolean
  setCost: boolean
  setUnitPrice: boolean
  enterQuantity: boolean
  correctQuantity: boolean
  confirmQuantity: boolean
  viewRates: boolean
  extractReport: boolean
}

export interface MyContract extends ContractRights {
  id: string
  name: string
  contractNo: string | null
  /** Fabricated data for exercising every screen state (0005/0006) — the Overview's unmissable, non-dismissable sandbox banner gates on this. */
  isSandbox: boolean
  /** The tendered total off the award document (0035) — null until someone enters it. Never derived from the sum of Ext. amount; see Rates' own reconciliation line. */
  tenderPrice: number | null
  /** The Ministry's given contract period end (0016) — null until entered. No longer drives stalled-Item suppression (see contractState) — kept for display/reference only. */
  contractEnd: string | null
  /** pipeline/active/warranty_period/closed_out/archived — see ContractState. Drives Needs Attention's stalled suppression and, going forward, Portfolio's sectioning. */
  contractState: ContractState
}

/**
 * Company-wide, not per-contract — live on profiles, not contract_members
 * (0011). create_projects: a contract can't be created "on" a contract that
 * doesn't exist yet. manage_members: seat people and set their rights.
 * Fetched now so the sidebar's ADMIN nav group can gate on them; the
 * screens those rights would unlock (contract creation, member management)
 * aren't built yet — a separate task.
 */
export interface CompanyRights {
  createProjects: boolean
  manageMembers: boolean
}

interface RawMembershipRow {
  create_items: boolean
  set_cost: boolean
  set_unit_price: boolean
  enter_quantity: boolean
  correct_quantity: boolean
  confirm_quantity: boolean
  view_rates: boolean
  extract_report: boolean
  contracts: {
    id: string
    contract_name: string
    contract_no: string | null
    is_sandbox: boolean
    tender_price: string | null
    contract_end: string | null
    contract_state: ContractState
  }
}

/**
 * Every contract the signed-in user is a member of, with their RIGHTS on
 * each one — rights live per contract (0008), so the same person can hold
 * different combinations on different contracts. RLS already scopes
 * contract_members to rows the caller can see (public.is_member()), so
 * filtering by user_id here is belt-and-braces, not load-bearing.
 *
 * No role field, derived or otherwise — 0008 removed roles as a concept
 * specifically so nothing collapses a right combination back into one.
 * Every UI gate reads one of these eight booleans directly.
 */
export async function fetchMyContracts(): Promise<MyContract[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  const { data, error } = await supabase
    .from('contract_members')
    .select(
      'create_items, set_cost, set_unit_price, enter_quantity, correct_quantity, confirm_quantity, view_rates, extract_report, contracts!inner ( id, contract_name, contract_no, is_sandbox, tender_price, contract_end, contract_state )',
    )
    .eq('user_id', user.id)
  if (error) throw error

  return (data ?? []).map((row) => {
    const r = row as unknown as RawMembershipRow
    return {
      id: r.contracts.id,
      name: r.contracts.contract_name,
      contractNo: r.contracts.contract_no,
      isSandbox: r.contracts.is_sandbox,
      tenderPrice: r.contracts.tender_price === null ? null : Number(r.contracts.tender_price),
      contractEnd: r.contracts.contract_end,
      contractState: r.contracts.contract_state,
      createItems: r.create_items,
      setCost: r.set_cost,
      setUnitPrice: r.set_unit_price,
      enterQuantity: r.enter_quantity,
      correctQuantity: r.correct_quantity,
      confirmQuantity: r.confirm_quantity,
      viewRates: r.view_rates,
      extractReport: r.extract_report,
    }
  })
}

export interface NewContractInput {
  contractNo: string | null
  name: string
  /** GC 52.00's own dates — the Ministry's period, not Keywest's own schedule. Coherent-pair + start<=end enforced by contracts_given_pair_coherent/contracts_given_start_before_end (0016); both null or both set. */
  contractStart: string | null
  contractEnd: string | null
  /** Keywest's own planning dates, distinct from the Ministry period above (0016) — both null or both set (contracts_planned_pair_coherent). */
  plannedStart: string | null
  plannedEnd: string | null
  isSandbox: boolean
}

/**
 * create_projects only (company-wide, per contracts_insert_right) —
 * created_by must be the caller (RLS with_check), never settable to anyone
 * else. The creator gets create_items on the new contract automatically
 * (enrol_global_roles(), 0028) — enough to enter its Items in the same
 * flow — but nothing else; seating them with any other right still goes
 * through Seat Members like anyone else's.
 */
export async function createContract(input: NewContractInput): Promise<MyContract> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in.')

  const { data, error } = await supabase
    .from('contracts')
    .insert({
      contract_no: input.contractNo,
      contract_name: input.name,
      contract_start: input.contractStart,
      contract_end: input.contractEnd,
      planned_start: input.plannedStart,
      planned_end: input.plannedEnd,
      is_sandbox: input.isSandbox,
      created_by: user.id,
    })
    .select('id, contract_name, contract_no, is_sandbox, contract_state')
    .single()
  if (error) throw error

  return {
    id: data.id,
    name: data.contract_name,
    contractNo: data.contract_no,
    isSandbox: data.is_sandbox,
    tenderPrice: null,
    contractEnd: input.contractEnd,
    contractState: data.contract_state,
    // The creator's own rights on their brand-new contract — create_items
    // only (see above), everything else false until seated separately.
    createItems: true,
    setCost: false,
    setUnitPrice: false,
    enterQuantity: false,
    correctQuantity: false,
    confirmQuantity: false,
    viewRates: false,
    extractReport: false,
  }
}

/** The signed-in user's two company-wide rights — see CompanyRights. */
export async function fetchMyCompanyRights(): Promise<CompanyRights> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { createProjects: false, manageMembers: false }

  const { data, error } = await supabase.from('profiles').select('create_projects, manage_members').eq('id', user.id).single()
  if (error) throw error

  return { createProjects: data.create_projects, manageMembers: data.manage_members }
}

/**
 * The one figure Rates' reconciliation line checks the sum of Ext. amount
 * against — entered once by a person reading it off the award document
 * (0035), never derived from that sum itself. Gated the same as Rates' own
 * edit surface (set_cost + set_unit_price both, contracts_tender_price_
 * update_right) — RLS is what actually enforces this; the caller only
 * reaches this button when RatesScreen's own canEdit already agrees.
 */
export async function updateTenderPrice(contractId: string, tenderPrice: number | null): Promise<void> {
  const { error } = await supabase.from('contracts').update({ tender_price: tenderPrice }).eq('id', contractId)
  if (error) throw error
}

/**
 * A person's own judgement, not a derivation — see ContractState's own
 * comment. No transition graph: any state to any state is a valid call.
 * Gated by RLS (contracts_state_update_right, manage_members) — the caller
 * only reaches this when the UI's own gate already agrees, same posture as
 * updateTenderPrice above.
 */
export async function updateContractState(contractId: string, state: ContractState): Promise<void> {
  const { error } = await supabase.from('contracts').update({ contract_state: state }).eq('id', contractId)
  if (error) throw error
}
