import { IconGavel } from '@tabler/icons-react'
import { EmptyState, PageHeader } from '../../components/ui'

/**
 * Pre-award, placeholder only. A bid has no Items anyone is bound to, no
 * Unit Prices, no Ministry Representative, no members seated — it is not
 * a Contract and must never be seeded into `contracts`. Nothing here
 * reads or writes any table; this is a shell announcing where pre-award
 * work will eventually live, not a working screen. No invented bid data
 * — the empty state is the whole content.
 *
 * Renamed from Tenders (this screen's own prior identity) as part of the
 * navigation restructure — the tree now separates by stage (pre-award vs
 * this contract) crossed with dimension, and "Bids" is the pre-award
 * stage's own name for the same not-yet-won work Tenders already meant.
 * Same placeholder, same route (/tenders — flagged separately as a
 * candidate rename, not done in this pass), reworded only.
 */
export function BidsScreen() {
  return (
    <div>
      <PageHeader title="Bids" subtitle="Pre-award" />
      <EmptyState
        icon={<IconGavel size={32} stroke={1.5} />}
        title="Bids aren't built yet."
        description="This is where pre-award work — bids not yet won, with no Items, Unit Prices, Ministry Representative, or seated members — will live, separately from Contracts. Nothing is tracked here today."
      />
    </div>
  )
}
