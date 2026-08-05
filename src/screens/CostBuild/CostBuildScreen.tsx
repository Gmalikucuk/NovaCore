import { useOutletContext } from 'react-router-dom'
import { IconCalculator } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { EmptyState, PageHeader, SandboxBanner } from '../../components/ui'

/**
 * Project level, placeholder only. Where a cost buildup — labour,
 * equipment, material, markup, whatever this contract's own breakdown
 * turns out to be — will eventually live per Item, distinct from the
 * single actual_cost_entries figure Rates/Tracker already show. Nothing
 * here reads or writes any table; this is a shell, not a working screen.
 * No invented figures — the empty state is the whole content.
 */
export function CostBuildScreen() {
  const contract = useOutletContext<MyContract>()

  return (
    <div>
      <PageHeader title="Cost build" subtitle={contract.name} />
      <SandboxBanner contract={contract} />
      <EmptyState
        icon={<IconCalculator size={32} stroke={1.5} />}
        title="Cost build isn't built yet."
        description="This is where a per-Item cost buildup will live. Nothing is tracked here today."
      />
    </div>
  )
}
