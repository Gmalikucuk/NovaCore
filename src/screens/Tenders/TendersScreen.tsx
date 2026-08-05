import { IconGavel } from '@tabler/icons-react'
import { EmptyState, PageHeader } from '../../components/ui'

/**
 * Pre-award, placeholder only. A tender has no Items anyone is bound to,
 * no Unit Prices, no Ministry Representative, no members seated — it is
 * not a Contract and must never be seeded into `contracts`. Nothing here
 * reads or writes any table; this is a shell announcing where pre-award
 * work will eventually live, not a working screen. No invented tender
 * data — the empty state is the whole content.
 */
export function TendersScreen() {
  return (
    <div>
      <PageHeader title="Tenders" subtitle="Pre-award" />
      <EmptyState
        icon={<IconGavel size={32} stroke={1.5} />}
        title="Tenders aren't built yet."
        description="This is where pre-award work — tenders not yet won, with no Items, Unit Prices, Ministry Representative, or seated members — will live, separately from Contracts. Nothing is tracked here today."
      />
    </div>
  )
}
