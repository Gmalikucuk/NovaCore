import { useEffect, useState } from 'react'
import { fetchMyCompanyRights, fetchMyContracts, type CompanyRights, type MyContract } from './supabase/contracts'
import { errorMessage } from './errorMessage'

const STORAGE_KEY = 'novacore_current_contract_id'

const NO_COMPANY_RIGHTS: CompanyRights = {
  createProjects: false,
  manageMembers: false,
  createBids: false,
  setBidCost: false,
  viewBidCosts: false,
  maintainCostRegisters: false,
  viewCostRegisterRates: false,
}

export interface CurrentContractState {
  status: 'loading' | 'none' | 'ready' | 'error'
  contracts: MyContract[]
  current: MyContract | null
  setCurrentId: (id: string) => void
  message?: string
  /** Company-wide rights (profiles.create_projects/manage_members/create_bids/set_bid_cost/view_bid_costs) — gates the sidebar's ADMIN group and the Bids surface. See CompanyRights. */
  companyRights: CompanyRights
}

/**
 * The signed-in user's contracts, plus which one is "current" — persisted so
 * a reload doesn't lose the choice. Auto-selects when there's exactly one
 * (the common case for a field seat), matching the archived build's
 * single-assignment auto-select behavior; a multi-contract person keeps an
 * explicit choice.
 */
export function useCurrentContract(): CurrentContractState {
  const [contracts, setContracts] = useState<MyContract[]>([])
  const [status, setStatus] = useState<'loading' | 'none' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | undefined>()
  const [currentId, setCurrentIdState] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY))
  const [companyRights, setCompanyRights] = useState<CompanyRights>(NO_COMPANY_RIGHTS)

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    // Fetched alongside contracts, not gated on having any — a
    // manage_members-only seat is still an admin before they're seated on a
    // single contract. Unused by any screen yet (ADMIN nav group only, see
    // Sidebar.tsx); a failure here shouldn't block the contract list this
    // hook exists for, so it's swallowed rather than folded into `status`.
    fetchMyCompanyRights()
      .then((rights) => {
        if (!cancelled) setCompanyRights(rights)
      })
      .catch((err: unknown) => {
        console.warn('fetchMyCompanyRights failed:', err)
      })
    fetchMyContracts()
      .then((list) => {
        if (cancelled) return
        setContracts(list)
        if (list.length === 0) {
          setStatus('none')
          return
        }
        setStatus('ready')
        setCurrentIdState((prev) => {
          if (prev && list.some((c) => c.id === prev)) return prev
          const fallback = list[0].id
          localStorage.setItem(STORAGE_KEY, fallback)
          return fallback
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setStatus('error')
        setMessage(errorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  function setCurrentId(id: string) {
    localStorage.setItem(STORAGE_KEY, id)
    setCurrentIdState(id)
  }

  const current = contracts.find((c) => c.id === currentId) ?? null

  return { status, contracts, current, setCurrentId, message, companyRights }
}
