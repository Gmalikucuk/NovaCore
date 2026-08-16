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
  /** May prepare and submit the monthly progress claim (0046) — Unit Price and quantity, never cost or margin. Independent of setCost/setUnitPrice on purpose: the project management team prepares claims, not Finance. */
  prepareClaims: boolean
  /** Enter, edit, certify, and reopen Daily Work Reports (Force Account claims, GC 49.00) on this contract. Does NOT imply the company-wide viewCostRegisterRates/maintainCostRegisters — a DWR line's rate is a register rate, and both must be held to actually write one; see CompanyRights. */
  recordForceAccount: boolean
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
  /** Whether derived cost figures (Margin, Margin %, Est. cost/margin, the pinned-Item margin line, Needs Attention's at-cost sentence, both Excel exports) render anywhere outside Rates' own entry columns (0042). Defaults false — cost coverage is not yet real on any contract. A person's deliberate call, never inferred from how much cost happens to be entered. */
  costTrackingEnabled: boolean
  /** The holdback percentage withheld from each progress payment (GC 54.00, 0046), entered from the contract documents. Null until someone enters it. */
  holdbackPercent: number | null
  /** The GST rate applied to the net progress payment (0046), entered from the contract documents. Null until someone enters it. */
  gstPercent: number | null
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
  /** Create/edit a bid, its item lines, and each line's sell price (0047) — the pre-award equivalent of createProjects, on the same has_global_right mechanism. */
  createBids: boolean
  /** Write cost_price/cost_source on a bid line (0047). Independent of createBids — the estimator costing a line is often not the person pricing the submission. */
  setBidCost: boolean
  /** Read cost_price/cost_source on a bid line (0047). Never implied by createBids or setBidCost. */
  viewBidCosts: boolean
  /** Add/edit equipment, labour classes, materials, and every rate/history table under them (0048). Implies read of rates — maintaining a register requires seeing what it holds. */
  maintainCostRegisters: boolean
  /** Read cost-register rate figures without being able to change the register (0048). Identity fields (equipment type/year/make/model, class name, material description/unit) need no right — open read. */
  viewCostRegisterRates: boolean
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
  prepare_claims: boolean
  record_force_account: boolean
  contracts: {
    id: string
    contract_name: string
    contract_no: string | null
    is_sandbox: boolean
    tender_price: string | null
    contract_end: string | null
    contract_state: ContractState
    cost_tracking_enabled: boolean
    holdback_percent: string | null
    gst_percent: string | null
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
      'create_items, set_cost, set_unit_price, enter_quantity, correct_quantity, confirm_quantity, view_rates, extract_report, prepare_claims, record_force_account, contracts!inner ( id, contract_name, contract_no, is_sandbox, tender_price, contract_end, contract_state, cost_tracking_enabled, holdback_percent, gst_percent )',
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
      costTrackingEnabled: r.contracts.cost_tracking_enabled,
      holdbackPercent: r.contracts.holdback_percent === null ? null : Number(r.contracts.holdback_percent),
      gstPercent: r.contracts.gst_percent === null ? null : Number(r.contracts.gst_percent),
      createItems: r.create_items,
      setCost: r.set_cost,
      setUnitPrice: r.set_unit_price,
      enterQuantity: r.enter_quantity,
      correctQuantity: r.correct_quantity,
      confirmQuantity: r.confirm_quantity,
      viewRates: r.view_rates,
      extractReport: r.extract_report,
      prepareClaims: r.prepare_claims,
      recordForceAccount: r.record_force_account,
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
    .select('id, contract_name, contract_no, is_sandbox, contract_state, cost_tracking_enabled')
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
    costTrackingEnabled: data.cost_tracking_enabled,
    holdbackPercent: null,
    gstPercent: null,
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
    prepareClaims: false,
    recordForceAccount: false,
  }
}

/** The signed-in user's company-wide rights — see CompanyRights. */
export async function fetchMyCompanyRights(): Promise<CompanyRights> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user)
    return {
      createProjects: false,
      manageMembers: false,
      createBids: false,
      setBidCost: false,
      viewBidCosts: false,
      maintainCostRegisters: false,
      viewCostRegisterRates: false,
    }

  const { data, error } = await supabase
    .from('profiles')
    .select('create_projects, manage_members, create_bids, set_bid_cost, view_bid_costs, maintain_cost_registers, view_cost_register_rates')
    .eq('id', user.id)
    .single()
  if (error) throw error

  return {
    createProjects: data.create_projects,
    manageMembers: data.manage_members,
    createBids: data.create_bids,
    setBidCost: data.set_bid_cost,
    viewBidCosts: data.view_bid_costs,
    maintainCostRegisters: data.maintain_cost_registers,
    viewCostRegisterRates: data.view_cost_register_rates,
  }
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

/**
 * The one switch (0042) deciding whether Margin/Est. cost/Est. margin
 * render anywhere on this contract outside Rates' own entry columns. Gated
 * the same as updateTenderPrice above (set_cost + set_unit_price,
 * contracts_cost_tracking_update_right) — the same "who may touch pricing
 * figures on this contract" surface, not a new decision.
 */
export async function updateCostTrackingEnabled(contractId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.from('contracts').update({ cost_tracking_enabled: enabled }).eq('id', contractId)
  if (error) throw error
}

/**
 * Holdback/GST percentages (0046) — entered from the contract documents,
 * never hardcoded (see the column comments). Gated by RLS on prepare_claims
 * (contracts_progress_claim_fields_update_right), not set_cost/set_unit_
 * price: the population preparing the claim is the population reading
 * these off the documents, independent of Rates' own pricing rights.
 */
export async function updateContractClaimTerms(contractId: string, input: { holdbackPercent: number | null; gstPercent: number | null }): Promise<void> {
  const { error } = await supabase.from('contracts').update({ holdback_percent: input.holdbackPercent, gst_percent: input.gstPercent }).eq('id', contractId)
  if (error) throw error
}
