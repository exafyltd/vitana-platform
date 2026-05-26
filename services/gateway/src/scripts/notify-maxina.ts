/**
 * Notify-only backfill for a MAXINA broadcast campaign. Reads chat_messages
 * rows tagged metadata.campaign=<campaign> and fires notifyUsersAsync for
 * each unique receiver. Does NOT insert any chat_messages — safe to re-run
 * (e.g. after a network blip dropped the push fan-out during a broadcast).
 *
 * Run from services/gateway:
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... \
 *   APPILIX_APP_KEY=... APPILIX_API_KEY=... GCP_PROJECT_ID=... \
 *     npx tsx src/scripts/notify-maxina.ts --campaign maxina_day7
 *
 * Optional: --body "custom push body text"
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const TAG = '[NotifyMaxina]';

function parseArgs(argv: string[]): { campaign: string; body?: string } {
  let campaign = '';
  let body: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--campaign') campaign = argv[++i];
    else if (argv[i] === '--body') body = argv[++i];
  }
  if (!campaign) throw new Error('--campaign <id> is required');
  return { campaign, body };
}

async function sb<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE!,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status} ${path}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const { campaign, body } = parseArgs(process.argv.slice(2));
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set');
  }

  const rows = await sb<Array<{ tenant_id: string; receiver_id: string }>>(
    `/chat_messages?metadata->>campaign=eq.${encodeURIComponent(campaign)}&select=tenant_id,receiver_id`,
  );
  if (!rows.length) {
    console.log(`${TAG} No rows for campaign ${campaign}. Nothing to notify.`);
    return;
  }

  const tenantId = rows[0].tenant_id;
  const receiverIds = Array.from(new Set(rows.map((r) => r.receiver_id)));
  console.log(`${TAG} Campaign ${campaign}: notifying ${receiverIds.length} unique receivers in tenant ${tenantId}`);

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });
  const { notifyUsersAsync } = await import('../services/notification-service');

  const payload = {
    title: 'Vitana',
    body: body || 'Du hast eine neue Nachricht von Vitana. ✨',
    data: { url: '/inbox', source: campaign },
  };

  notifyUsersAsync(receiverIds, tenantId, 'new_chat_message', payload, supabase as any);
  console.log(`${TAG} Queued. Waiting 60s for fire-and-forget dispatch to drain…`);
  await new Promise((r) => setTimeout(r, 60_000));
  console.log(`${TAG} Done.`);
}

main().catch((err) => {
  console.error(`${TAG} Fatal: ${err.message || err}`);
  process.exit(1);
});
