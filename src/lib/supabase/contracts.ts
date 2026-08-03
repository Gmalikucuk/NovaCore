import { supabase } from './client'

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
  contracts: { id: string; contract_name: string; contract_no: string | null }
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
      'create_items, set_cost, set_unit_price, enter_quantity, correct_quantity, confirm_quantity, view_rates, extract_report, contracts!inner ( id, contract_name, contract_no )',
    )
    .eq('user_id', user.id)
  if (error) throw error

  return (data ?? []).map((row) => {
    const r = row as unknown as RawMembershipRow
    return {
      id: r.contracts.id,
      name: r.contracts.contract_name,
      contractNo: r.contracts.contract_no,
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
