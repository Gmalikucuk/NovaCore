import { useOutletContext } from 'react-router-dom'
import { IconReportAnalytics } from '@tabler/icons-react'
import type { MyContract } from '../../lib/supabase/contracts'
import { EmptyState, PageHeader, SandboxBanner } from '../../components/ui'

/**
 * Project level, placeholder only. Where a day's own report — weather,
 * crew, equipment, whatever this contract's own daily-reporting shape
 * turns out to be — will eventually live, distinct from the quantity
 * records Daily Entry already carries. Nothing here reads or writes any
 * table; this is a shell, not a working screen. No invented figures —
 * the empty state is the whole content.
 *
 * Visible to any seated member — no rights gate. There is no
 * daily-report right in the schema to gate it on yet, and inventing one
 * ahead of the screen that would use it isn't this pass's job (no schema
 * change). Propose and add the real gate when this is actually built.
 */
export function DailyReportsScreen() {
  const contract = useOutletContext<MyContract>()

  return (
    <div>
      <PageHeader title="Daily reports" subtitle={contract.name} />
      <SandboxBanner contract={contract} />
      <EmptyState
        icon={<IconReportAnalytics size={32} stroke={1.5} />}
        title="Daily reports aren't built yet."
        description="This is where a daily report — weather, crew, equipment — will live, separate from the quantity records Daily Entry already carries. Nothing is tracked here today."
      />
    </div>
  )
}
