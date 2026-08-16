import { useOutletContext } from 'react-router-dom'
import { IconShoppingCart } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { EmptyState, PageHeader, SandboxBanner } from '../../components/ui'

/**
 * Project level, placeholder only. Where a purchase order — material,
 * equipment, subcontract commitments made against this contract — will
 * eventually live. Nothing here reads or writes any table; this is a
 * shell, not a working screen. No invented figures — the empty state is
 * the whole content.
 */
export function PurchaseOrdersScreen() {
  const contract = useOutletContext<MyContract>()

  return (
    <div>
      <PageHeader title="Purchase orders" subtitle={contract.name} />
      <SandboxBanner contract={contract} />
      <EmptyState
        icon={<IconShoppingCart size={32} stroke={1.5} />}
        title="Purchase orders aren't built yet."
        description="This is where a purchase order — material, equipment, subcontract commitments made against this contract — will live. Nothing is tracked here today."
      />
    </div>
  )
}
