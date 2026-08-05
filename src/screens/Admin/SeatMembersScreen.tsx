import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { CurrentContractState } from '../../lib/useCurrentContract'
import {
  addContractMember,
  fetchAllContractsForAdmin,
  fetchContractMembers,
  findProfileByEmail,
  updateContractMemberRight,
  type AdminContract,
  type ContractMember,
  type ContractRightKey,
  type FoundProfile,
} from '../../lib/supabase/admin'
import { errorMessage } from '../../lib/errorMessage'
import { Button, EmptyState, Input, NotificationBanner, PageHeader, Select, Spinner, Table, TBody, TD, TH, THead, TR } from '../../components/ui'

/**
 * Plain-language, not the column name — a person reading this screen sees
 * what they'd say out loud, never `set_unit_price`. Order matches
 * contract_members' own column order (the sequence rights were added in),
 * not an attempt to group them.
 */
const RIGHTS: { key: ContractRightKey; label: string }[] = [
  { key: 'createItems', label: 'Add or edit Items' },
  { key: 'setCost', label: 'Set internal cost' },
  { key: 'setUnitPrice', label: 'Set Unit Price' },
  { key: 'enterQuantity', label: 'Enter quantities' },
  { key: 'correctQuantity', label: 'Correct quantities' },
  { key: 'confirmQuantity', label: 'Confirm quantities' },
  { key: 'viewRates', label: 'View rates and cost' },
  { key: 'extractReport', label: 'Export reports' },
]

/**
 * Add a person to a contract, and toggle their rights individually — never
 * a role, never a preset. Any combination is valid; "make this person a
 * PM" is a role by another name, and 0008 removed roles deliberately. Every
 * checkbox here commits the instant it's toggled, one column at a time —
 * never a batched "save all" that reasserts every right whether it changed
 * or not (the exact shape that cascade-deleted a real seat's rights
 * earlier this session, and the same staleness risk already fixed for
 * confirming quantity records: a save-all button re-sends whatever the
 * browser loaded, silently overwriting anything changed elsewhere since).
 */
export function SeatMembersScreen() {
  const { companyRights } = useOutletContext<CurrentContractState>()
  const canSeat = companyRights.manageMembers

  const [contracts, setContracts] = useState<AdminContract[]>([])
  const [contractsStatus, setContractsStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [contractsError, setContractsError] = useState<string | null>(null)
  const [selectedContractId, setSelectedContractId] = useState<string>('')

  const [members, setMembers] = useState<ContractMember[]>([])
  const [membersStatus, setMembersStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [membersError, setMembersError] = useState<string | null>(null)
  const [togglingKey, setTogglingKey] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ userId: string; message: string } | null>(null)

  const [email, setEmail] = useState('')
  const [lookingUp, setLookingUp] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [found, setFound] = useState<FoundProfile | null | undefined>(undefined) // undefined: not looked up yet. null: looked up, no account.
  const [rightsToGrant, setRightsToGrant] = useState<Set<ContractRightKey>>(new Set())
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  useEffect(() => {
    if (!canSeat) return
    setContractsStatus('loading')
    fetchAllContractsForAdmin()
      .then((rows) => {
        setContracts(rows)
        setContractsStatus('ready')
        setSelectedContractId((prev) => prev || (rows[0]?.id ?? ''))
      })
      .catch((err: unknown) => {
        setContractsError(errorMessage(err))
        setContractsStatus('error')
      })
  }, [canSeat])

  function loadMembers(contractId: string) {
    setMembersStatus('loading')
    fetchContractMembers(contractId)
      .then((rows) => {
        setMembers(rows)
        setMembersStatus('ready')
      })
      .catch((err: unknown) => {
        setMembersError(errorMessage(err))
        setMembersStatus('error')
      })
  }

  useEffect(() => {
    if (!selectedContractId) return
    loadMembers(selectedContractId)
  }, [selectedContractId])

  const selectedContract = useMemo(() => contracts.find((c) => c.id === selectedContractId), [contracts, selectedContractId])

  async function toggleRight(member: ContractMember, key: ContractRightKey, value: boolean) {
    const cellKey = `${member.userId}-${key}`
    setTogglingKey(cellKey)
    setRowError(null)
    try {
      await updateContractMemberRight(selectedContractId, member.userId, key, value)
      setMembers((prev) => prev.map((m) => (m.userId === member.userId ? { ...m, [key]: value } : m)))
    } catch (err) {
      setRowError({ userId: member.userId, message: errorMessage(err) })
    } finally {
      setTogglingKey(null)
    }
  }

  async function handleLookup() {
    setLookupError(null)
    setFound(undefined)
    if (!email.trim()) {
      setLookupError('Enter an email address.')
      return
    }
    setLookingUp(true)
    try {
      const result = await findProfileByEmail(email.trim())
      setFound(result)
      setRightsToGrant(new Set())
    } catch (err) {
      setLookupError(errorMessage(err))
    } finally {
      setLookingUp(false)
    }
  }

  function toggleGrant(key: ContractRightKey) {
    setRightsToGrant((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function handleAdd() {
    if (!found) return
    setAddError(null)
    setAdding(true)
    try {
      const member = await addContractMember(selectedContractId, found.id, [...rightsToGrant])
      setMembers((prev) => [...prev, member])
      setEmail('')
      setFound(undefined)
      setRightsToGrant(new Set())
    } catch (err) {
      setAddError(errorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  if (!canSeat) {
    return (
      <div>
        <PageHeader title="Seat members" />
        <EmptyState title="You don't have permission to manage members." />
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="Seat members" />

      {contractsStatus === 'loading' && (
        <div className="flex items-center gap-2 py-8 text-nc-text-muted">
          <Spinner />
          <span className="text-sm">Loading contracts…</span>
        </div>
      )}
      {contractsStatus === 'error' && contractsError && <NotificationBanner tone="danger">{contractsError}</NotificationBanner>}

      {contractsStatus === 'ready' && contracts.length === 0 && <EmptyState title="No contracts exist yet." description="Create one first." />}

      {contractsStatus === 'ready' && contracts.length > 0 && (
        <div className="space-y-6">
          <div className="max-w-md">
            <label className="mb-1 block text-sm font-semibold text-nc-text-muted" htmlFor="sm-contract">
              Contract
            </label>
            <Select id="sm-contract" value={selectedContractId} onChange={(e) => setSelectedContractId(e.target.value)}>
              {contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.contractNo ? `${c.contractNo} — ${c.name}` : c.name}
                  {c.isSandbox ? ' (sandbox)' : ''}
                </option>
              ))}
            </Select>
          </div>

          {membersStatus === 'loading' && (
            <div className="flex items-center gap-2 py-4 text-nc-text-muted">
              <Spinner />
              <span className="text-sm">Loading members…</span>
            </div>
          )}
          {membersStatus === 'error' && membersError && <NotificationBanner tone="danger">{membersError}</NotificationBanner>}

          {membersStatus === 'ready' && (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    {RIGHTS.map((r) => (
                      <TH key={r.key} align="right">
                        {r.label}
                      </TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {members.length === 0 ? (
                    <TR>
                      <TD colSpan={RIGHTS.length + 1} className="text-nc-text-muted">
                        Nobody is seated on {selectedContract?.name ?? 'this contract'} yet.
                      </TD>
                    </TR>
                  ) : (
                    members.map((member) => (
                      <TR key={member.userId}>
                        <TD>{member.fullName ?? 'Unnamed'}</TD>
                        {RIGHTS.map((r) => (
                          <TD key={r.key} align="right">
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              checked={member[r.key]}
                              disabled={togglingKey === `${member.userId}-${r.key}`}
                              onChange={(e) => void toggleRight(member, r.key, e.target.checked)}
                              aria-label={`${r.label} for ${member.fullName ?? 'this person'}`}
                            />
                          </TD>
                        ))}
                      </TR>
                    ))
                  )}
                  {rowError && (
                    <TR>
                      <TD colSpan={RIGHTS.length + 1} className="text-nc-danger-text">
                        {rowError.message}
                      </TD>
                    </TR>
                  )}
                </TBody>
              </Table>

              <div className="max-w-xl rounded-lg border border-nc-border bg-white p-4 shadow-sm">
                <p className="mb-3 text-sm font-semibold text-nc-text">Add a person</p>
                <div className="flex gap-2">
                  <Input
                    type="email"
                    placeholder="name@keywestasphalt.com"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      setFound(undefined)
                      setLookupError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void handleLookup()
                      }
                    }}
                  />
                  <Button type="button" variant="secondary" onClick={() => void handleLookup()} disabled={lookingUp}>
                    {lookingUp ? 'Looking up…' : 'Look up'}
                  </Button>
                </div>

                {lookupError && (
                  <NotificationBanner tone="danger" className="mt-3">
                    {lookupError}
                  </NotificationBanner>
                )}

                {found === null && (
                  <NotificationBanner tone="warning" className="mt-3">
                    No NovaCore account found for this email. They need to sign in at least once before they can be seated.
                  </NotificationBanner>
                )}

                {found && (
                  <div className="mt-4">
                    <p className="mb-2 text-sm text-nc-text">
                      Seating <span className="font-semibold">{found.fullName ?? found.id}</span> with:
                    </p>
                    <div className="mb-3 grid grid-cols-2 gap-2">
                      {RIGHTS.map((r) => (
                        <label key={r.key} className="flex items-center gap-2 text-sm text-nc-text">
                          <input type="checkbox" className="h-4 w-4" checked={rightsToGrant.has(r.key)} onChange={() => toggleGrant(r.key)} />
                          {r.label}
                        </label>
                      ))}
                    </div>
                    {addError && (
                      <NotificationBanner tone="danger" className="mb-3">
                        {addError}
                      </NotificationBanner>
                    )}
                    <Button type="button" onClick={() => void handleAdd()} disabled={adding}>
                      {adding ? 'Adding…' : 'Add to contract'}
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
