import { supabase } from './client'

export interface MyProject {
  id: string
  name: string
  contractNo: string | null
  role: 'field' | 'project_manager' | 'cfo' | 'owner'
}

/**
 * Every project the signed-in user is a member of, with their role on each
 * one — role lives per project (spec §1), so the same person can be
 * `field` on one project and `project_manager` on another. RLS already
 * scopes project_members to rows the caller can see (public.is_member()),
 * so filtering by user_id here is belt-and-braces, not load-bearing.
 */
export async function fetchMyProjects(): Promise<MyProject[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return []

  const { data, error } = await supabase
    .from('project_members')
    .select('role, projects!inner ( id, name, contract_no )')
    .eq('user_id', user.id)
  if (error) throw error

  return (data ?? []).map((row) => {
    const project = row.projects as unknown as { id: string; name: string; contract_no: string | null }
    return {
      id: project.id,
      name: project.name,
      contractNo: project.contract_no,
      role: row.role as MyProject['role'],
    }
  })
}
