import { useOutletContext } from 'react-router-dom'
import { IconReceiptDollar } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { EmptyState, PageHeader, SandboxBanner } from '../../components/ui'

/**
 * Project level, placeholder only. Where a payment actually received
 * against a progress claim will eventually live, distinct from the
 * claimed and estimated figures Progress claims and Months already show
 * — this is cash in hand, not a claim or an estimate. Nothing here reads
 * or writes any table; this is a shell, not a working screen. No
 * invented figures — the empty state is the whole content.
 */
export function PaymentsScreen() {
  const contract = useOutletContext<MyContract>()

  return (
    <div>
      <PageHeader title="Payments" subtitle={contract.name} />
      <SandboxBanner contract={contract} />
      <EmptyState
        icon={<IconReceiptDollar size={32} stroke={1.5} />}
        title="Payments aren't built yet."
        description="This is where a payment actually received against a progress claim will live, separate from the claimed and estimated figures Progress claims and Months already show. Nothing is tracked here today."
      />
    </div>
  )
}
