/**
 * Backfill push + in-app notifications for the previously-inserted
 * maxina_day2 broadcast. Reads chat_messages rows tagged
 * metadata.campaign='maxina_day2' and fires notifyUsersAsync for each
 * unique receiver. Does NOT insert any new chat_messages.
 *
 * Run from services/gateway (Cloud Shell where ADC for firebase is available):
 *
 *   npm install   # needed once for @supabase/supabase-js + firebase-admin
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... \
 *     npx tsx src/scripts/notify-maxina-day2.ts
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const TAG = '[NotifyMaxinaDay2]';

const NOTIFICATION_PAYLOAD = {
  title: 'Vitana',
  body: 'Bereit für Tag 2? ✨ Lass dich heute von Vitana durch MAXINA führen.',
  data: { url: '/inbox', source: 'maxina_day2' },
};

async function sb<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE!,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${res.status} ${path}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set');
  }

  const rows = await sb<Array<{ tenant_id: string; receiver_id: string }>>(
    '/chat_messages?metadata->>campaign=eq.maxina_day2&select=tenant_id,receiver_id',
  );
  if (!rows.length) {
    console.log(`${TAG} No maxina_day2 rows found. Nothing to notify.`);
    return;
  }

  const tenantId = rows[0].tenant_id;
  const receiverIds = Array.from(new Set(rows.map((r) => r.receiver_id)));
  console.log(`${TAG} Notifying ${receiverIds.length} unique receivers in tenant ${tenantId}`);

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });
  const { notifyUsersAsync } = await import('../services/notification-service');

  notifyUsersAsync(receiverIds, tenantId, 'new_chat_message', NOTIFICATION_PAYLOAD, supabase as any);

  console.log(`${TAG} Queued. Waiting 30s for fire-and-forget dispatch to drain…`);
  await new Promise((r) => setTimeout(r, 30_000));
  console.log(`${TAG} Done.`);
}

main().catch((err) => {
  console.error(`${TAG} Fatal: ${err.message || err}`);
  process.exit(1);
});
