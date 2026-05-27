/**
 * Notify-only backfill for a MAXINA broadcast campaign, with bounded
 * concurrency + retry so it survives flaky Cloud Shell networking.
 *
 * Reads chat_messages rows tagged metadata.campaign=<campaign> and calls
 * notifyUser for each unique receiver, at most CONCURRENCY at a time.
 * Does NOT insert chat_messages — safe to re-run.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... \
 *   APPILIX_APP_KEY=... APPILIX_API_KEY=... GCP_PROJECT_ID=... \
 *     npx tsx src/scripts/notify-maxina.ts --campaign maxina_day8 \
 *       [--body "custom push body"] [--concurrency 5] [--retries 2]
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const TAG = '[NotifyMaxina]';

interface Args {
  campaign: string;
  body?: string;
  concurrency: number;
  retries: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { campaign: '', concurrency: 5, retries: 2 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--campaign') out.campaign = argv[++i];
    else if (argv[i] === '--body') out.body = argv[++i];
    else if (argv[i] === '--concurrency') out.concurrency = parseInt(argv[++i], 10);
    else if (argv[i] === '--retries') out.retries = parseInt(argv[++i], 10);
  }
  if (!out.campaign) throw new Error('--campaign <id> is required');
  return out;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set');
  }

  const rows = await sb<Array<{ tenant_id: string; receiver_id: string }>>(
    `/chat_messages?metadata->>campaign=eq.${encodeURIComponent(args.campaign)}&select=tenant_id,receiver_id`,
  );
  if (!rows.length) {
    console.log(`${TAG} No rows for campaign ${args.campaign}. Nothing to notify.`);
    return;
  }

  const tenantId = rows[0].tenant_id;
  const receiverIds = Array.from(new Set(rows.map((r) => r.receiver_id)));
  console.log(
    `${TAG} Campaign ${args.campaign}: ${receiverIds.length} receivers, concurrency=${args.concurrency}, retries=${args.retries}`,
  );

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });
  const { notifyUser } = await import('../services/notification-service');

  const payload = {
    title: 'Vitana',
    body: args.body || 'Du hast eine neue Nachricht von Vitana. ✨',
    data: { url: '/inbox', source: args.campaign },
  };

  let ok = 0;
  let failed = 0;
  const failedIds: string[] = [];

  async function processOne(userId: string): Promise<void> {
    for (let attempt = 0; attempt <= args.retries; attempt++) {
      try {
        await notifyUser(userId, tenantId, 'new_chat_message', payload, supabase as any);
        ok++;
        return;
      } catch (err: any) {
        if (attempt < args.retries) {
          await sleep(500 * (attempt + 1)); // backoff: 0.5s, 1s, …
          continue;
        }
        failed++;
        failedIds.push(userId);
        console.warn(`${TAG} FAILED ${userId.slice(0, 8)}… after ${args.retries + 1} tries: ${err.message || err}`);
      }
    }
  }

  // Bounded-concurrency worker pool
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < receiverIds.length) {
      const myId = receiverIds[idx++];
      await processOne(myId);
    }
  }
  const workers = Array.from({ length: Math.max(1, args.concurrency) }, () => worker());
  await Promise.all(workers);

  console.log(`${TAG} Done. ok=${ok} failed=${failed} / ${receiverIds.length}`);
  if (failedIds.length) {
    console.log(`${TAG} Re-run to retry the ${failedIds.length} that failed (idempotent).`);
  }
}

main().catch((err) => {
  console.error(`${TAG} Fatal: ${err.message || err}`);
  process.exit(1);
});
