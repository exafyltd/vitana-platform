/**
 * Daily MAXINA broadcast — send a message from the Vitana bot to every
 * MAXINA member (community + member roles by default) and fire the
 * Appilix push so phones light up.
 *
 * Usage:
 *
 *   npx tsx src/scripts/broadcast-maxina.ts \
 *     --message ./day3.txt \
 *     --campaign maxina_day3 \
 *     [--roles community,member] \
 *     [--dry-run] \
 *     [--no-push]
 *
 * Required env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE
 *
 * Required for push (omit only when --no-push):
 *   APPILIX_APP_KEY, APPILIX_API_KEY, GCP_PROJECT_ID
 *
 * Idempotent: receivers who already have a chat_messages row with the
 * same metadata.campaign are skipped, so re-running the same command is
 * safe.
 */

import { readFileSync } from 'fs';
import { VITANA_BOT_USER_ID } from '../lib/vitana-bot';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const BATCH_SIZE = 50;
const TAG = '[BroadcastMaxina]';
const MAXINA_TENANT_SLUG = 'maxina';

interface Args {
  messageFile: string;
  campaign: string;
  roles: string[];
  dryRun: boolean;
  noPush: boolean;
  onlyUser?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { roles: ['community', 'member'], dryRun: false, noPush: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--message' || a === '--message-file') out.messageFile = argv[++i];
    else if (a === '--campaign') out.campaign = argv[++i];
    else if (a === '--roles') out.roles = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--only-user') out.onlyUser = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-push') out.noPush = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: broadcast-maxina.ts --message <file> --campaign <id> ' +
          '[--roles community,member] [--only-user <user_id>] [--dry-run] [--no-push]',
      );
      process.exit(0);
    } else {
      console.warn(`${TAG} Unknown arg: ${a}`);
    }
  }
  if (!out.messageFile) throw new Error('--message <file> is required');
  if (!out.campaign) throw new Error('--campaign <id> is required');
  return out as Args;
}

async function sb<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE!,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status} ${path}: ${await res.text()}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) return undefined as unknown as T;
  const txt = await res.text();
  return (txt ? JSON.parse(txt) : undefined) as T;
}

async function resolveTenantId(): Promise<string> {
  const rows = await sb<Array<{ tenant_id: string }>>(
    `/tenants?slug=eq.${MAXINA_TENANT_SLUG}&select=tenant_id&limit=1`,
  );
  if (!rows?.length) throw new Error(`Tenant slug=${MAXINA_TENANT_SLUG} not found`);
  return rows[0].tenant_id;
}

async function fetchMemberIds(tenantId: string, roles: string[]): Promise<string[]> {
  const inList = `(${roles.map((r) => `"${r}"`).join(',')})`;
  const rows = await sb<Array<{ user_id: string }>>(
    `/user_tenants?tenant_id=eq.${tenantId}&active_role=in.${inList}&user_id=neq.${VITANA_BOT_USER_ID}&select=user_id`,
  );
  return Array.from(new Set((rows || []).map((r) => r.user_id)));
}

async function fetchAlreadySentReceivers(campaign: string): Promise<Set<string>> {
  const rows = await sb<Array<{ receiver_id: string }>>(
    `/chat_messages?metadata->>campaign=eq.${encodeURIComponent(campaign)}&select=receiver_id`,
  );
  return new Set((rows || []).map((r) => r.receiver_id));
}

async function insertBatch(
  tenantId: string,
  receiverIds: string[],
  message: string,
  campaign: string,
): Promise<void> {
  const now = new Date().toISOString();
  const rows = receiverIds.map((rid) => ({
    tenant_id: tenantId,
    sender_id: VITANA_BOT_USER_ID,
    receiver_id: rid,
    content: message,
    message_type: 'text',
    metadata: { source: 'admin_broadcast', campaign, automated: true },
    created_at: now,
  }));
  await sb('/chat_messages', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
}

function buildNotificationBody(message: string): string {
  const firstLine = message.split('\n').find((l) => l.trim().length > 0) || 'Neue Nachricht von Vitana';
  return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine;
}

async function firePushes(
  tenantId: string,
  receiverIds: string[],
  message: string,
  campaign: string,
): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE!, {
    auth: { persistSession: false },
  });
  const { notifyUsersAsync } = await import('../services/notification-service');
  const payload = {
    title: 'Vitana',
    body: buildNotificationBody(message),
    data: { url: '/inbox', source: campaign },
  };
  notifyUsersAsync(receiverIds, tenantId, 'new_chat_message', payload, supabase as any);
  console.log(`${TAG} Push fan-out queued for ${receiverIds.length} users. Waiting 30s to drain…`);
  await new Promise((r) => setTimeout(r, 30_000));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set');
  }

  const message = readFileSync(args.messageFile, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  if (!message) throw new Error(`Message file is empty: ${args.messageFile}`);

  console.log(`${TAG} Mode: ${args.dryRun ? 'DRY-RUN' : 'LIVE'}`);
  console.log(`${TAG} Campaign: ${args.campaign}`);
  console.log(`${TAG} Roles: ${args.roles.join(', ')}`);
  console.log(`${TAG} Message: ${message.length} chars from ${args.messageFile}`);

  const tenantId = await resolveTenantId();
  console.log(`${TAG} MAXINA tenant_id = ${tenantId}`);

  let memberIds: string[];
  if (args.onlyUser) {
    memberIds = [args.onlyUser];
    console.log(`${TAG} --only-user set, targeting single user: ${args.onlyUser}`);
  } else {
    memberIds = await fetchMemberIds(tenantId, args.roles);
    console.log(`${TAG} Total eligible members: ${memberIds.length}`);
  }

  const alreadySent = await fetchAlreadySentReceivers(args.campaign);
  if (alreadySent.size > 0) {
    console.log(`${TAG} ${alreadySent.size} receivers already have this campaign — skipping`);
  }

  const recipients = memberIds.filter((id) => !alreadySent.has(id));
  console.log(`${TAG} Will deliver to: ${recipients.length}`);

  if (recipients.length > 0) {
    console.log(`${TAG} Sample: ${recipients.slice(0, 3).join(', ')}${recipients.length > 3 ? ' …' : ''}`);
  }

  if (args.dryRun) {
    console.log(`${TAG} DRY-RUN — exiting without inserting or notifying.`);
    return;
  }

  if (recipients.length === 0) {
    console.log(`${TAG} Nothing to send.`);
    return;
  }

  let inserted = 0;
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    try {
      await insertBatch(tenantId, batch, message, args.campaign);
      inserted += batch.length;
      console.log(
        `${TAG} Batch ${Math.floor(i / BATCH_SIZE) + 1}: +${batch.length} (total ${inserted}/${recipients.length})`,
      );
    } catch (err: any) {
      console.error(`${TAG} Batch starting at offset ${i} failed: ${err.message || err}`);
    }
  }
  console.log(`${TAG} Inserts complete: ${inserted}/${recipients.length}`);

  if (args.noPush) {
    console.log(`${TAG} --no-push set, skipping push notifications.`);
  } else {
    try {
      await firePushes(tenantId, recipients, message, args.campaign);
    } catch (err: any) {
      console.warn(`${TAG} Push fan-out failed: ${err.message || err}`);
    }
  }

  console.log(`${TAG} Done.`);
}

main().catch((err) => {
  console.error(`${TAG} Fatal: ${err.message || err}`);
  process.exit(1);
});
