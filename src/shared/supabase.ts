import { createClient, SupabaseClient } from '@supabase/supabase-js';
import 'dotenv/config';

const { SUPABASE_URL, SUPABASE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('SUPABASE_URL or SUPABASE_KEY not set');
}

let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    supabaseClient = createClient(SUPABASE_URL as string, SUPABASE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseClient;
}


