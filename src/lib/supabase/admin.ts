import { supabase } from './client'
import type { ContractRights } from './contracts'

export interface AdminContract {
  id: string
  name: string
  contractNo: string | null
  isSandbox: boolean
}

/**
 * Every contract, for the Seat Members picker — not just ones the caller is
 * already a member of (fetchMyContracts' own scope). Reachable only because
 * contracts_select_member now also admits a manage_members holder (0028);
 * a create_projects-only caller (no manage_members) gets exactly the
 * member-scoped set back, same as fetchMyContracts, since RLS is what
 * actually decides the row set either way — this function makes no rights
 * decision of its own.
 */
export async function fetchAllContractsForAdmin(): Promise<AdminContract[]> {
  const { data, error } = await supabase.from('contracts').select('id, contract_name, contract_no, is_sandbox').order('contract_name')
  if (error) throw error
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.contract_name,
    contractNo: row.contract_no,
    isSandbox: row.is_sandbox,
  }))
}

export interface ContractMember extends ContractRights {
  userId: string
  fullName: string | null
}

interface RawContractMemberRow {
  user_id: string
  create_items: boolean
  set_cost: boolean
  set_unit_price: boolean
  enter_quantity: boolean
  correct_quantity: boolean
  confirm_quantity: boolean
  view_rates: boolean
  extract_report: boolean
  prepare_claims: boolean
  profiles: { full_name: string | null } | null
}

function mapContractMemberRow(row: RawContractMemberRow): ContractMember {
  return {
    userId: row.user_id,
    fullName: row.profiles?.full_name ?? null,
    createItems: row.create_items,
    setCost: row.set_cost,
    setUnitPrice: row.set_unit_price,
    enterQuantity: row.enter_quantity,
    correctQuantity: row.correct_quantity,
    confirmQuantity: row.confirm_quantity,
    viewRates: row.view_rates,
    extractReport: row.extract_report,
    prepareClaims: row.prepare_claims,
  }
}

const CONTRACT_MEMBER_SELECT =
  'user_id, create_items, set_cost, set_unit_price, enter_quantity, correct_quantity, confirm_quantity, view_rates, extract_report, prepare_claims, profiles ( full_name )'

/** Every seat on a contract, with the name to show against each — manage_members only (contract_members_select's own is_member(contract_id) gate is satisfied by 0028's widened contracts visibility, not bypassed). */
export async function fetchContractMembers(contractId: string): Promise<ContractMember[]> {
  const { data, error } = await supabase.from('contract_members').select(CONTRACT_MEMBER_SELECT).eq('contract_id', contractId)
  if (error) throw error
  return (data ?? []).map((row) => mapContractMemberRow(row as unknown as RawContractMemberRow))
}

export interface FoundProfile {
  id: string
  fullName: string | null
}

/**
 * Resolves an email to a profiles.id via find_profile_by_email (0028,
 * SECURITY DEFINER — profiles has no email column, and auth.users isn't
 * otherwise reachable from the client). Null means no account, not an
 * error: "must have signed in at least once" is a real, expected state to
 * handle, not a failure — the caller decides how to say so.
 */
export async function findProfileByEmail(email: string): Promise<FoundProfile | null> {
  const { data, error } = await supabase.rpc('find_profile_by_email', { p_email: email })
  if (error) throw error
  const row = (data ?? [])[0] as { id: string; full_name: string | null } | undefined
  if (!row) return null
  return { id: row.id, fullName: row.full_name }
}

export type ContractRightKey = keyof ContractRights

const RIGHT_COLUMN: Record<ContractRightKey, string> = {
  createItems: 'create_items',
  setCost: 'set_cost',
  setUnitPrice: 'set_unit_price',
  enterQuantity: 'enter_quantity',
  correctQuantity: 'correct_quantity',
  confirmQuantity: 'confirm_quantity',
  viewRates: 'view_rates',
  extractReport: 'extract_report',
  prepareClaims: 'prepare_claims',
}

/**
 * Seats a person with EXACTLY the rights passed in true — every right not
 * listed stays at its column default (false), same as any other brand-new
 * row. This is a genuine first INSERT, not an update-in-place, so there is
 * nothing to preserve yet; the "never a wholesale rewrite" rule (see
 * updateContractMemberRight below) is about not re-asserting every column
 * on an EXISTING member's row, which this isn't.
 */
export async function addContractMember(contractId: string, userId: string, rightsToGrant: ContractRightKey[]): Promise<ContractMember> {
  const payload: Record<string, string | boolean> = { contract_id: contractId, user_id: userId }
  for (const key of rightsToGrant) payload[RIGHT_COLUMN[key]] = true

  const { data, error } = await supabase.from('contract_members').insert(payload).select(CONTRACT_MEMBER_SELECT).single()
  if (error) {
    if (error.code === '23505') throw new Error('This person is already seated on this contract.')
    throw new Error(error.message)
  }
  return mapContractMemberRow(data as unknown as RawContractMemberRow)
}

/**
 * Changes exactly ONE right on an EXISTING seat — a single-column PATCH,
 * never the whole rights object. This is the specific lesson from this
 * session's seed-rerun incident (a wholesale grant clobbered a real seat's
 * rights): every checkbox in the Seat Members grid commits independently,
 * the instant it's toggled, touching only its own column. Batching several
 * toggles into one save-all PATCH would reintroduce exactly the staleness
 * risk already fixed for confirming quantity records — reasserting rights
 * the admin's browser merely happened to have loaded, silently overwriting
 * anything changed elsewhere in the meantime.
 */
export async function updateContractMemberRight(contractId: string, userId: string, right: ContractRightKey, value: boolean): Promise<void> {
  const { error } = await supabase
    .from('contract_members')
    .update({ [RIGHT_COLUMN[right]]: value })
    .eq('contract_id', contractId)
    .eq('user_id', userId)
  if (error) throw error
}
