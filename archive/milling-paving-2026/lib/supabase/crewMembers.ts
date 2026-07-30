import { supabase } from './client'

export interface ActiveCrewMember {
  id: string
  name: string
  role: string
}

export async function fetchActiveCrewMembers(): Promise<ActiveCrewMember[]> {
  const { data, error } = await supabase
    .from('crew_members')
    .select('id, name, role')
    .eq('active', true)
    .order('name')
  if (error) throw error
  return data ?? []
}
