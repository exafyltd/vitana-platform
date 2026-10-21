/**
 * VTID-05095: the real dependencies of the phone verification service —
 * service-role PostgREST, Supabase Auth admin, the strict test/service
 * account exclusion and AWS End User Messaging SMS.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { db, enc } from '../connected-apps/db';
import { fetchExcludedTestServiceAccountIdsStrict } from '../../lib/excluded-test-service-accounts';
import { getUserLocale } from '../../i18n/server-locale';
import { sendVerificationSms } from './sms-sender';
import type { PhoneVerificationDeps, ProfilePhone } from './service';

let admin: SupabaseClient | null = null;

function adminClient(): SupabaseClient {
  if (!admin) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE;
    if (!url || !key) throw new Error('supabase_config_missing');
    admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return admin;
}

export const phoneVerificationDeps: PhoneVerificationDeps = {
  async rpc(name, args) {
    return db(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
  },

  async getProfilePhone(userId) {
    const rows = (await db(
      `profiles?select=phone_e164,phone_verified,discoverable_by_phone&user_id=eq.${enc(userId)}&limit=1`,
    )) as ProfilePhone[] | null;
    return rows?.[0] ?? null;
  },

  async phoneVerifiedByOther(phoneE164, userId) {
    const rows = (await db(
      `profiles?select=user_id&phone_e164=eq.${enc(phoneE164)}&phone_verified=is.true&user_id=neq.${enc(userId)}&limit=1`,
    )) as Array<{ user_id: string }> | null;
    return (rows?.length ?? 0) > 0;
  },

  async updateAuthPhone(userId, attrs) {
    const { error } = await adminClient().auth.admin.updateUserById(userId, attrs);
    return { error: error ? { message: error.message, status: (error as any).status, code: (error as any).code } : null };
  },

  async excludedAccountIds() {
    return fetchExcludedTestServiceAccountIdsStrict(adminClient());
  },

  async userLocale(userId) {
    return getUserLocale(adminClient(), userId);
  },

  sendSms: sendVerificationSms,
};
