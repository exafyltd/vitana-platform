/**
 * One-off broadcast: send the "Bereit für Tag 2?" Day-2 onboarding nudge
 * from the Vitana bot to every MAXINA community member.
 *
 * Run:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... \
 *     npx tsx services/gateway/src/scripts/broadcast-maxina-day2.ts [--dry-run]
 *
 * The script:
 *   1. Resolves tenant id for slug='maxina'
 *   2. Selects user_tenants where active_role='community' (excludes the bot)
 *   3. Batch-inserts chat_messages rows (sender = VITANA_BOT_USER_ID)
 *   4. Best-effort fires `new_chat_message` notifications via notifyUsersAsync
 *      (skipped silently if firebase-admin ADC isn't available locally)
 *
 * Insert shape mirrors services/gateway/src/services/welcome-chat-service.ts.
 */

import { VITANA_BOT_USER_ID } from '../lib/vitana-bot';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 50;

const TAG = '[BroadcastMaxinaDay2]';

const MESSAGE = [
  'Bereit für Tag 2? ✨',
  '',
  'Heute geht es darum, zu lernen, wie du mit Vitana sprichst und wie du dich von ihr durch die MAXINA App führen lassen kannst.',
  '',
  'Du musst nicht wissen, wo sich alles befindet. Stell dir heute einfach vor, dass du komplett neu bist. Stelle einfache Fragen. Sag:',
  '',
  '   „Ich weiß es nicht."',
  '',
  'Bitte Vitana, dir Dinge zu erklären, dir etwas zu zeigen, Bildschirme zu öffnen und dich zu verschiedenen Bereichen in der App zu führen.',
  '',
  '────────────────────────────',
  '',
  '1) Öffne MAXINA und tippe auf den schwebenden Vitana Orb.',
  '',
  'Sage laut:',
  '',
  '   „Hallo Vitana, ich weiß nicht, wo ich anfangen soll. Bitte erkläre mir MAXINA."',
  '',
  'Wenn du den Vitana Orb wieder schließen möchtest, tippe einfach auf das X.',
  '',
  '────────────────────────────',
  '',
  '2) Bitte Vitana, dich durch die App zu führen.',
  '',
  'Du kannst zum Beispiel sagen:',
  '',
  '   „Ich weiß nicht, wo die wichtigen Dinge sind. Bring mich zu dem Bildschirm, auf dem ich andere Menschen kennenlernen kann."',
  '',
  '   „Zeig mir, wo ich Events und Aktivitäten finden kann."',
  '',
  '────────────────────────────',
  '',
  '3) Bitte Vitana, bestimmte Bildschirme für dich zu öffnen.',
  '',
  'Probiere diese Befehle aus:',
  '',
  '   • „Öffne den Events-Bildschirm."',
  '   • „Bring mich zum Health-Bildschirm."',
  '   • „Zeig mir, wo ich mit anderen Menschen chatten kann."',
  '   • „Öffne den Bildschirm, auf dem ich Beiträge oder Updates sehen kann."',
  '',
  '────────────────────────────',
  '',
  '4) Wähle einen Bildschirm aus und bitte Vitana, ihn dir so zu erklären, als wärst du ganz neu.',
  '',
  'Sage:',
  '',
  '   „Ich weiß nicht, wofür dieser Bildschirm da ist. Erkläre ihn mir."',
  '',
  '   „Erzähl mir mehr darüber. Was soll ich hier machen?"',
  '',
  '────────────────────────────',
  '',
  'Für heute ist deine Aufgabe ganz einfach:',
  '',
  'Tu so, als wüsstest du noch nichts, und lass dich von Vitana unterrichten. Bitte sie, Dinge zu erklären. Bitte sie, Bildschirme zu öffnen. Bitte sie, dich dorthin zu bringen, wo du hinmöchtest.',
  '',
  'Und wenn etwas nicht funktioniert, sag einfach zum Vitana Orb:',
  '',
  '   „Das hat nicht funktioniert."',
  '',
  'Dein Feedback hilft uns, MAXINA einfacher, wärmer und lebendiger für alle zu machen. 💛',
].join('\n');

const NOTIFICATION_PAYLOAD = {
  title: 'Vitana',
  body: 'Bereit für Tag 2? ✨ Lass dich heute von Vitana durch MAXINA führen.',
  data: { url: '/inbox', source: 'maxina_day2' },
};

function assertEnv(): void {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set in the environment',
    );
  }
}

async function sb<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE!,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      Prefer: 'return=minimal',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status} ${path}: ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    return undefined as unknown as T;
  }
  const txt = await res.text();
  return (txt ? JSON.parse(txt) : undefined) as T;
}

async function resolveMaxinaTenantId(): Promise<string> {
  const rows = await sb<Array<{ tenant_id: string }>>(
    '/tenants?slug=eq.maxina&select=tenant_id&limit=1',
    { headers: { Prefer: 'return=representation' } },
  );
  if (!rows || rows.length === 0) {
    throw new Error('MAXINA tenant not found (slug=maxina)');
  }
  return rows[0].tenant_id;
}

async function fetchCommunityMemberIds(tenantId: string): Promise<string[]> {
  const rows = await sb<Array<{ user_id: string }>>(
    `/user_tenants?tenant_id=eq.${tenantId}&active_role=eq.community&user_id=neq.${VITANA_BOT_USER_ID}&select=user_id`,
    { headers: { Prefer: 'return=representation' } },
  );
  return (rows || []).map((r) => r.user_id);
}

async function insertBatch(tenantId: string, receiverIds: string[]): Promise<void> {
  const now = new Date().toISOString();
  const rows = receiverIds.map((rid) => ({
    tenant_id: tenantId,
    sender_id: VITANA_BOT_USER_ID,
    receiver_id: rid,
    content: MESSAGE,
    message_type: 'text',
    metadata: { source: 'admin_broadcast', campaign: 'maxina_day2', automated: true },
    created_at: now,
  }));
  await sb('/chat_messages', {
    method: 'POST',
    body: JSON.stringify(rows),
  });
}

async function fireNotifications(tenantId: string, receiverIds: string[]): Promise<void> {
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE!, {
      auth: { persistSession: false },
    });
    const { notifyUsersAsync } = await import('../services/notification-service');
    notifyUsersAsync(receiverIds, tenantId, 'new_chat_message', NOTIFICATION_PAYLOAD, supabase as any);
    console.log(`${TAG} Notifications queued for ${receiverIds.length} users (fire-and-forget)`);
    // Give async fan-out a moment to dispatch before the process exits.
    await new Promise((r) => setTimeout(r, 5000));
  } catch (err: any) {
    console.warn(
      `${TAG} Skipping push notifications (notification-service unavailable): ${err.message || err}`,
    );
  }
}

async function main(): Promise<void> {
  assertEnv();
  console.log(`${TAG} Mode: ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`);

  const tenantId = await resolveMaxinaTenantId();
  console.log(`${TAG} MAXINA tenant_id = ${tenantId}`);

  const recipients = await fetchCommunityMemberIds(tenantId);
  console.log(`${TAG} Resolved ${recipients.length} community recipients`);

  if (recipients.length === 0) {
    console.log(`${TAG} Nothing to send — aborting.`);
    return;
  }

  console.log(`${TAG} Sample receiver ids: ${recipients.slice(0, 3).join(', ')}${recipients.length > 3 ? ', …' : ''}`);
  console.log(`${TAG} Message length: ${MESSAGE.length} chars`);

  if (DRY_RUN) {
    console.log(`${TAG} DRY-RUN — no rows inserted. Re-run without --dry-run to deliver.`);
    return;
  }

  let inserted = 0;
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    try {
      await insertBatch(tenantId, batch);
      inserted += batch.length;
      console.log(`${TAG} Batch ${Math.floor(i / BATCH_SIZE) + 1}: inserted ${batch.length} (total ${inserted}/${recipients.length})`);
    } catch (err: any) {
      console.error(`${TAG} Batch starting at offset ${i} failed: ${err.message || err}`);
    }
  }

  console.log(`${TAG} Inserts complete: ${inserted}/${recipients.length}`);

  await fireNotifications(tenantId, recipients);

  console.log(`${TAG} Done.`);
}

main().catch((err) => {
  console.error(`${TAG} Fatal: ${err.message || err}`);
  process.exit(1);
});
