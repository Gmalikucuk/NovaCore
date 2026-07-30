import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables')
}

// Written out explicitly rather than relying on the (already-true) SDK
// defaults: sessions persist to the device's storage and refresh silently in
// the background, so a signed-in crew member stays logged in indefinitely
// until they explicitly log out. No claimed-identity header fallback here —
// that was the old build's pre-RLS mechanism; every RLS policy in v1 keys
// off a real auth.uid() from Supabase Auth.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
})
