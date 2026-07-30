import { supabase } from './client'
import type { ProjectOption } from './milling'

/** Every project the given crew member is assigned to, via crew_member_projects — drives useProjectAssignment's single/multi/none UX split. */
export async function fetchAssignedProjects(crewMemberId: string): Promise<ProjectOption[]> {
  const { data, error } = await supabase
    .from('crew_member_projects')
    .select('projects!inner(id, contract_number, name)')
    .eq('crew_member_id', crewMemberId)
  if (error) throw error
  return (data ?? [])
    .map((row) => row.projects as unknown as { id: string; contract_number: string; name: string })
    .map((p) => ({ id: p.id, contractNumber: p.contract_number, name: p.name }))
    .sort((a, b) => a.contractNumber.localeCompare(b.contractNumber))
}
