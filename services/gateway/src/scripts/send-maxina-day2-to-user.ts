/**
 * One-off: deliver the maxina_day2 broadcast to a specific user that the
 * main run missed (e.g. role='member', not 'community').
 *
 * Run:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE=... \
 *   APPILIX_APP_KEY=... APPILIX_API_KEY=... \
 *     npx tsx src/scripts/send-maxina-day2-to-user.ts <user_id>
 */

import { VITANA_BOT_USER_ID } from '../lib/vitana-bot';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const TAG = '[SendMaxinaDay2ToUser]';

const MAXINA_TENANT_ID = '2e7528b8-472a-4356-88da-0280d4639cce';

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

async function main(): Promise<void> {
  const userId = process.argv[2];
  if (!userId) throw new Error('Usage: send-maxina-day2-to-user.ts <user_id>');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE must be set');
  }

  console.log(`${TAG} Inserting chat_messages row for ${userId}`);
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/chat_messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE!,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      tenant_id: MAXINA_TENANT_ID,
      sender_id: VITANA_BOT_USER_ID,
      receiver_id: userId,
      content: MESSAGE,
      message_type: 'text',
      metadata: { source: 'admin_broadcast', campaign: 'maxina_day2', automated: true },
      created_at: new Date().toISOString(),
    }),
  });
  if (!insertRes.ok) {
    throw new Error(`Insert failed ${insertRes.status}: ${await insertRes.text()}`);
  }
  console.log(`${TAG} Inserted`);

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });
  const { notifyUserAsync } = await import('../services/notification-service');
  notifyUserAsync(userId, MAXINA_TENANT_ID, 'new_chat_message', NOTIFICATION_PAYLOAD, supabase as any);
  console.log(`${TAG} Notification queued. Waiting 15s for dispatch…`);
  await new Promise((r) => setTimeout(r, 15_000));
  console.log(`${TAG} Done.`);
}

main().catch((err) => {
  console.error(`${TAG} Fatal: ${err.message || err}`);
  process.exit(1);
});
