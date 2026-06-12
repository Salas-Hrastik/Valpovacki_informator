/**
 * Supabase klijent (service-role) — koristi se ISKLJUČIVO na poslužitelju
 * (API rute, cron, skripte). Service-role ključ nikada ne smije dospjeti
 * u klijentski (browser) kod.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from './config';

let _admin: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(
      requireEnv('SUPABASE_URL'),
      requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return _admin;
}
