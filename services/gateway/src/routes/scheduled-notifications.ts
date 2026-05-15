/**
 * Scheduled Notification Webhook Endpoints
 *
 * Cloud Scheduler (or manual cron) triggers these endpoints to dispatch
 * time-based notifications to all active users in a tenant.
 *
 * Endpoints:
 *   POST /api/v1/scheduled-notifications/morning-briefing
 *   POST /api/v1/scheduled-notifications/diary-reminder
 *   POST /api/v1/scheduled-notifications/weekly-digest
 *   POST /api/v1/scheduled-notifications/weekly-summary
 *   POST /api/v1/scheduled-notifications/weekly-reflection
 *   POST /api/v1/scheduled-notifications/meetup-reminders
 *   POST /api/v1/scheduled-notifications/upcoming-events
 *   POST /api/v1/scheduled-notifications/recommendation-expiry
 *   POST /api/v1/scheduled-notifications/signal-cleanup
 */

import { Router, Request, Response } from 'express';
import { notifyUserAsync, sendPushToUser, sendAppilixPush } from '../services/notification-service';
import { generatePersonalRecommendations } from '../services/recommendation-engine';
import { LangCode, resolveLanguage } from '../services/recommendation-engine/analyzers/community-user-analyzer';

const router = Router();

// ── Helper: get service-role Supabase client ─────────────────
async function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(url, key);
}

// ── Helper: get all active users for a tenant ────────────────
async function getActiveUsers(supabase: any, tenantId: string): Promise<Array<{ user_id: string }>> {
  const { data } = await supabase
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('is_primary', true);
  return data || [];
}

// ── Helper: extract tenant_id from body or use default ───────
function getTenantId(req: Request): string | null {
  return req.body?.tenant_id || process.env.DEFAULT_TENANT_ID || null;
}

// =============================================================================
// POST /morning-briefing — Daily 7 AM UTC (Personalized from Maxina)
// =============================================================================

const GREETINGS: Record<LangCode, string[]> = {
  en: ['Good morning', 'Rise and shine', 'Hello', 'Hey'],
  de: ['Guten Morgen', 'Schönen guten Morgen', 'Einen wunderschönen Morgen', 'Hey', 'Hallo', 'Moin'],
  fr: ['Bonjour', 'Bien le bonjour', 'Salut', 'Coucou'],
  es: ['Buenos días', 'Hola', 'Buen día', 'Hey'],
  ar: ['صباح الخير', 'مرحباً', 'أهلاً'],
  zh: ['早上好', '你好', '嗨'],
  ru: ['Доброе утро', 'Привет', 'Здравствуй'],
  sr: ['Dobro jutro', 'Zdravo', 'Ćao'],
};

const CLOSINGS: Record<LangCode, string[]> = {
  en: ['Your Maxina wishes you a great day!', "I'm here when you need me. Your Maxina.", "Let's make today a good one!", 'You got this! Your Maxina.', 'Maxina believes in you!', 'Make the best of today! Your Maxina.'],
  de: ['Deine Maxina wünscht dir einen tollen Tag!', 'Ich bin da, wenn du mich brauchst. Deine Maxina.', 'Lass uns gemeinsam einen guten Tag machen!', 'Du schaffst das! Deine Maxina.', 'Einen schönen Tag wünscht dir Maxina.', 'Maxina glaubt an dich!', 'Mach das Beste aus heute! Deine Maxina.'],
  fr: ['Ta Maxina te souhaite une super journée !', 'Je suis là quand tu as besoin de moi. Ta Maxina.', 'Faisons de cette journée une belle journée !', 'Tu vas y arriver ! Ta Maxina.', 'Maxina croit en toi !', 'Profite bien de ta journée ! Ta Maxina.'],
  es: ['¡Tu Maxina te desea un gran día!', 'Estoy aquí cuando me necesites. Tu Maxina.', '¡Hagamos de hoy un buen día!', '¡Tú puedes! Tu Maxina.', '¡Maxina cree en ti!', '¡Aprovecha el día! Tu Maxina.'],
  ar: ['ماكسينا تتمنى لك يوماً رائعاً!', 'أنا هنا عندما تحتاجني. ماكسينا.', 'لنجعل اليوم يوماً جميلاً!', 'يمكنك ذلك! ماكسينا.', 'ماكسينا تؤمن بك!'],
  zh: ['你的Maxina祝你度过美好的一天！', '需要我的时候我就在。你的Maxina。', '让我们一起度过美好的一天！', '你可以的！你的Maxina。', 'Maxina相信你！'],
  ru: ['Твоя Максина желает тебе отличного дня!', 'Я рядом, когда нужна. Твоя Максина.', 'Давай сделаем сегодня хорошим днём!', 'У тебя получится! Твоя Максина.', 'Максина верит в тебя!'],
  sr: ['Tvoja Maxina ti želi divan dan!', 'Tu sam kad me trebaš. Tvoja Maxina.', 'Hajde da napravimo dobar dan!', 'Možeš ti to! Tvoja Maxina.', 'Maxina veruje u tebe!'],
};

const MOOD_MESSAGES: Record<LangCode, Record<string, string>> = {
  en: {
    sad: 'Yesterday was a tough day. Today will be better!',
    anxious: "I see you weren't feeling great. I'm here for you.",
    stressed: "Let's take it easy today.",
    happy: "Great that you're feeling good! Keep it up!",
    energetic: 'You had lots of energy yesterday!',
    calm: "Nice that you're feeling balanced.",
    tired: 'Take some time for yourself today.',
  },
  de: {
    sad: 'Gestern war ein schwieriger Tag. Heute wird besser!',
    anxious: 'Ich sehe, dass es dir nicht so gut ging. Ich bin für dich da.',
    stressed: 'Lass uns heute etwas ruhiger angehen.',
    happy: 'Toll, dass es dir gut geht! Weiter so!',
    energetic: 'Du hattest gestern richtig viel Energie!',
    calm: 'Schön, dass du ausgeglichen bist.',
    tired: 'Nimm dir heute Zeit für dich.',
  },
  fr: {
    sad: "Hier était une journée difficile. Aujourd'hui sera mieux !",
    anxious: "Je vois que ça n'allait pas très bien. Je suis là pour toi.",
    stressed: 'Prenons les choses doucement aujourd\'hui.',
    happy: 'Super que tu te sentes bien ! Continue comme ça !',
    energetic: "Tu avais beaucoup d'énergie hier !",
    calm: "C'est bien que tu sois équilibré(e).",
    tired: "Prends du temps pour toi aujourd'hui.",
  },
  es: {
    sad: 'Ayer fue un día difícil. ¡Hoy será mejor!',
    anxious: 'Veo que no te sentías bien. Estoy aquí para ti.',
    stressed: 'Vamos con calma hoy.',
    happy: '¡Qué bien que te sientas bien! ¡Sigue así!',
    energetic: '¡Ayer tenías mucha energía!',
    calm: 'Qué bueno que estés equilibrado/a.',
    tired: 'Tómate tiempo para ti hoy.',
  },
  ar: {
    sad: 'كان أمس يوماً صعباً. اليوم سيكون أفضل!',
    anxious: 'أرى أنك لم تكن بخير. أنا هنا من أجلك.',
    stressed: 'لنأخذ الأمور ببساطة اليوم.',
    happy: 'رائع أنك تشعر بالارتياح! استمر!',
    energetic: 'كانت لديك طاقة كبيرة أمس!',
    calm: 'جميل أنك متوازن.',
    tired: 'خذ بعض الوقت لنفسك اليوم.',
  },
  zh: {
    sad: '昨天是艰难的一天。今天会更好！',
    anxious: '我看到你感觉不太好。我在你身边。',
    stressed: '今天我们慢慢来。',
    happy: '很高兴你感觉不错！继续保持！',
    energetic: '你昨天精力充沛！',
    calm: '很好，你很平衡。',
    tired: '今天给自己一些时间。',
  },
  ru: {
    sad: 'Вчера был трудный день. Сегодня будет лучше!',
    anxious: 'Вижу, что тебе было нелегко. Я рядом.',
    stressed: 'Давай сегодня полегче.',
    happy: 'Здорово, что тебе хорошо! Так держать!',
    energetic: 'Вчера у тебя было много энергии!',
    calm: 'Хорошо, что ты в равновесии.',
    tired: 'Удели сегодня время себе.',
  },
  sr: {
    sad: 'Juče je bio težak dan. Danas će biti bolje!',
    anxious: 'Vidim da ti nije bilo lako. Tu sam za tebe.',
    stressed: 'Hajde da danas idemo lagano.',
    happy: 'Super da se dobro osećaš! Nastavi tako!',
    energetic: 'Juče si imao/la puno energije!',
    calm: 'Lepo da si uravnotežen/a.',
    tired: 'Uzmi danas malo vremena za sebe.',
  },
};

const BRIEFING_TEXT: Record<LangCode, {
  vitanaIndex: string;
  trendUp: string;
  trendDown: string;
  trendStable: string;
  streakHigh: string;
  streakMid: string;
  matchesPending: string;
  recsReady: string;
  fallbackTitle: string;
  fallbackBody: string;
}> = {
  en: { vitanaIndex: 'Your Vitana Index: {score}/100', trendUp: '↑', trendDown: '↓', trendStable: '→', streakHigh: '{count}-day diary streak! Impressive!', streakMid: '{count} days in a row journaling. Keep it up!', matchesPending: '{count} new match(es) waiting for you.', recsReady: '{count} Autopilot action(s) ready.', fallbackTitle: 'Good morning!', fallbackBody: 'Your daily briefing is ready. Take a look!' },
  de: { vitanaIndex: 'Dein Vitana-Index: {score}/100', trendUp: '↑', trendDown: '↓', trendStable: '→', streakHigh: '{count}-Tage-Tagebuch-Serie! Beeindruckend!', streakMid: 'Schon {count} Tage in Folge Tagebuch geschrieben. Bleib dran!', matchesPending: '{count} neue Match(es) warten auf dich.', recsReady: '{count} Autopilot-Aktion(en) bereit.', fallbackTitle: 'Guten Morgen!', fallbackBody: 'Dein tägliches Briefing ist bereit. Schau mal rein!' },
  fr: { vitanaIndex: 'Ton indice Vitana : {score}/100', trendUp: '↑', trendDown: '↓', trendStable: '→', streakHigh: 'Série de {count} jours de journal ! Impressionnant !', streakMid: '{count} jours de suite. Continue !', matchesPending: '{count} nouveau(x) match(s) en attente.', recsReady: '{count} action(s) Autopilot prête(s).', fallbackTitle: 'Bonjour !', fallbackBody: 'Ton briefing quotidien est prêt. Jette un œil !' },
  es: { vitanaIndex: 'Tu índice Vitana: {score}/100', trendUp: '↑', trendDown: '↓', trendStable: '→', streakHigh: '¡Racha de {count} días de diario! ¡Impresionante!', streakMid: '{count} días seguidos. ¡Sigue así!', matchesPending: '{count} match(es) nuevo(s) esperándote.', recsReady: '{count} acción(es) Autopilot lista(s).', fallbackTitle: '¡Buenos días!', fallbackBody: 'Tu briefing diario está listo. ¡Échale un vistazo!' },
  ar: { vitanaIndex: 'مؤشر فيتانا: {score}/100', trendUp: '↑', trendDown: '↓', trendStable: '→', streakHigh: 'سلسلة {count} يوم من اليوميات! مثير للإعجاب!', streakMid: '{count} يوم متتالي. استمر!', matchesPending: '{count} تطابق(ات) جديدة بانتظارك.', recsReady: '{count} إجراء(ات) Autopilot جاهزة.', fallbackTitle: 'صباح الخير!', fallbackBody: 'ملخصك اليومي جاهز. ألقِ نظرة!' },
  zh: { vitanaIndex: '你的Vitana指数：{score}/100', trendUp: '↑', trendDown: '↓', trendStable: '→', streakHigh: '{count}天日记连续！令人印象深刻！', streakMid: '连续{count}天。继续坚持！', matchesPending: '{count}个新匹配等着你。', recsReady: '{count}个Autopilot操作已就绪。', fallbackTitle: '早上好！', fallbackBody: '你的每日简报已准备好。看看吧！' },
  ru: { vitanaIndex: 'Твой индекс Vitana: {score}/100', trendUp: '↑', trendDown: '↓', trendStable: '→', streakHigh: 'Серия {count} дней дневника! Впечатляет!', streakMid: '{count} дней подряд. Так держать!', matchesPending: '{count} новых совпадений ждут тебя.', recsReady: '{count} действий Autopilot готово.', fallbackTitle: 'Доброе утро!', fallbackBody: 'Твой ежедневный брифинг готов. Загляни!' },
  sr: { vitanaIndex: 'Tvoj Vitana indeks: {score}/100', trendUp: '↑', trendDown: '↓', trendStable: '→', streakHigh: 'Serija od {count} dana dnevnika! Impresivno!', streakMid: '{count} dana zaredom. Nastavi!', matchesPending: '{count} novih poklapanja te čeka.', recsReady: '{count} Autopilot akcija spremno.', fallbackTitle: 'Dobro jutro!', fallbackBody: 'Tvoj dnevni brifing je spreman. Pogledaj!' },
};

interface BriefingContext {
  userName: string | null;
  language: LangCode;
  healthScore: number | null;
  healthTrend: 'up' | 'stable' | 'down' | null;
  diaryMood: string | null;
  diaryStreak: number;
  pendingMatchCount: number;
  newRecCount: number;
  connectionCount: number;
}

async function gatherBriefingContext(supa: any, userId: string, tenantId: string): Promise<BriefingContext> {
  const [factsResult, healthResult, diaryResult, matchResult, recResult, connResult, streakResult] = await Promise.all([
    supa.from('memory_facts').select('fact_key, fact_value').eq('user_id', userId).in('fact_key', ['display_name', 'name', 'preferred_language']),
    supa.from('vitana_index_scores').select('score_total').eq('user_id', userId).order('created_at', { ascending: false }).limit(2),
    supa.from('memory_items').select('tags, metadata').eq('user_id', userId).eq('item_type', 'diary').order('created_at', { ascending: false }).limit(1),
    supa.from('matches_daily').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('tenant_id', tenantId).is('feedback', null),
    supa.from('autopilot_recommendations').select('id', { count: 'exact', head: true }).eq('status', 'new').or(`user_id.is.null,user_id.eq.${userId}`),
    supa.from('relationship_edges').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('tenant_id', tenantId).eq('target_type', 'person').eq('relationship_type', 'connected'),
    supa.from('memory_items').select('created_at').eq('user_id', userId).eq('item_type', 'diary').order('created_at', { ascending: false }).limit(14),
  ]);

  // Parse facts
  const facts = factsResult.data || [];
  const userName = facts.find((f: any) => f.fact_key === 'display_name' || f.fact_key === 'name')?.fact_value || null;
  const langFact = facts.find((f: any) => f.fact_key === 'preferred_language')?.fact_value;
  const language = resolveLanguage(langFact);

  // Parse health trend
  const healthRows = healthResult.data || [];
  let healthScore: number | null = null;
  let healthTrend: 'up' | 'stable' | 'down' | null = null;
  if (healthRows.length > 0) {
    healthScore = healthRows[0].score_total;
    if (healthRows.length > 1) {
      const delta = healthRows[0].score_total - healthRows[1].score_total;
      healthTrend = delta > 2 ? 'up' : delta < -2 ? 'down' : 'stable';
    }
  }

  // Parse diary mood
  let diaryMood: string | null = null;
  if (diaryResult.data?.length > 0) {
    const meta = diaryResult.data[0].metadata as any;
    const tags = diaryResult.data[0].tags as string[] || [];
    diaryMood = meta?.mood || tags.find((t: string) => ['happy', 'sad', 'anxious', 'calm', 'stressed', 'energetic', 'tired'].includes(t)) || null;
  }

  // Calculate diary streak
  let diaryStreak = 0;
  const entries = streakResult.data || [];
  if (entries.length > 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let checkDate = new Date(today);
    for (const entry of entries) {
      const entryDate = new Date(entry.created_at);
      entryDate.setHours(0, 0, 0, 0);
      if (entryDate.getTime() === checkDate.getTime()) {
        diaryStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else if (entryDate.getTime() < checkDate.getTime()) {
        if (checkDate.getTime() - entryDate.getTime() <= 86400000) {
          checkDate = new Date(entryDate);
          diaryStreak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    }
  }

  return {
    userName,
    language,
    healthScore,
    healthTrend,
    diaryMood,
    diaryStreak,
    pendingMatchCount: matchResult.count || 0,
    newRecCount: recResult.count || 0,
    connectionCount: connResult.count || 0,
  };
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function composeMorningBriefing(ctx: BriefingContext): string {
  const lang = ctx.language;
  const bt = BRIEFING_TEXT[lang] ?? BRIEFING_TEXT['en'];
  const parts: string[] = [];

  // 1. Greeting
  const greetings = GREETINGS[lang] ?? GREETINGS['en'];
  const greeting = pick(greetings);
  parts.push(ctx.userName ? `${greeting}, ${ctx.userName}!` : `${greeting}!`);

  // 2. Health pulse
  if (ctx.healthScore !== null) {
    const trendEmoji = ctx.healthTrend === 'up' ? bt.trendUp : ctx.healthTrend === 'down' ? bt.trendDown : bt.trendStable;
    parts.push(`${bt.vitanaIndex.replace('{score}', String(ctx.healthScore))} ${trendEmoji}`);
  }

  // 3. Mood acknowledgment
  if (ctx.diaryMood) {
    const moods = MOOD_MESSAGES[lang] ?? MOOD_MESSAGES['en'];
    if (moods[ctx.diaryMood]) {
      parts.push(moods[ctx.diaryMood]);
    }
  }

  // 4. Streak celebration
  if (ctx.diaryStreak >= 7) {
    parts.push(bt.streakHigh.replace('{count}', String(ctx.diaryStreak)));
  } else if (ctx.diaryStreak >= 3) {
    parts.push(bt.streakMid.replace('{count}', String(ctx.diaryStreak)));
  }

  // 5. Social pulse
  if (ctx.pendingMatchCount > 0) {
    parts.push(bt.matchesPending.replace('{count}', String(ctx.pendingMatchCount)));
  }

  // 6. Recommendations
  if (ctx.newRecCount > 0) {
    parts.push(bt.recsReady.replace('{count}', String(ctx.newRecCount)));
  }

  // 7. Closing
  const closings = CLOSINGS[lang] ?? CLOSINGS['en'];
  parts.push(pick(closings));

  return parts.join(' ');
}

router.post('/morning-briefing', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;

  for (const { user_id } of users) {
    try {
      // Generate fresh personal recommendations for this user
      await generatePersonalRecommendations(user_id, tenantId, { trigger_type: 'scheduled' });

      // Gather briefing context and compose personalized message
      const ctx = await gatherBriefingContext(supa, user_id, tenantId);
      const briefingBody = composeMorningBriefing(ctx);

      const greetings = GREETINGS[ctx.language] ?? GREETINGS['en'];
      const greetingTitle = ctx.userName ? `${pick(greetings)}, ${ctx.userName}!` : `${pick(greetings)}!`;

      notifyUserAsync(user_id, tenantId, 'morning_briefing_ready', {
        title: greetingTitle,
        body: briefingBody,
        data: { url: '/dashboard' },
      }, supa);
      dispatched++;
    } catch (err: any) {
      console.warn(`[Scheduled] morning_briefing error for ${user_id.slice(0, 8)}: ${err.message}`);
      // Fallback to basic notification (English default)
      const fb = BRIEFING_TEXT['en'];
      notifyUserAsync(user_id, tenantId, 'morning_briefing_ready', {
        title: fb.fallbackTitle,
        body: fb.fallbackBody,
        data: { url: '/dashboard' },
      }, supa);
      dispatched++;
    }
  }

  console.log(`[Scheduled] morning_briefing_ready → ${dispatched} users (personalized)`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /diary-reminder — Daily 9 PM UTC
// =============================================================================
router.post('/diary-reminder', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;

  for (const { user_id } of users) {
    notifyUserAsync(user_id, tenantId, 'daily_diary_reminder', {
      title: 'Diary Reminder',
      body: 'Take a moment to reflect on your day.',
      data: { url: '/diary' },
    }, supa);
    dispatched++;
  }

  console.log(`[Scheduled] daily_diary_reminder → ${dispatched} users`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /weekly-digest — Sunday 6 PM UTC
// =============================================================================
router.post('/weekly-digest', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;

  for (const { user_id } of users) {
    notifyUserAsync(user_id, tenantId, 'weekly_community_digest', {
      title: 'Weekly Community Digest',
      body: 'See what happened in your community this week.',
      data: { url: '/community' },
    }, supa);
    dispatched++;
  }

  console.log(`[Scheduled] weekly_community_digest → ${dispatched} users`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /weekly-summary — Sunday 8 AM UTC
// =============================================================================
router.post('/weekly-summary', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;

  for (const { user_id } of users) {
    notifyUserAsync(user_id, tenantId, 'weekly_activity_summary', {
      title: 'Your Weekly Summary',
      body: 'Here\'s a snapshot of your activity and progress this week.',
      data: { url: '/dashboard' },
    }, supa);
    dispatched++;
  }

  console.log(`[Scheduled] weekly_activity_summary → ${dispatched} users`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /weekly-reflection — Friday 8 PM UTC
// =============================================================================
router.post('/weekly-reflection', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const users = await getActiveUsers(supa, tenantId);
  let dispatched = 0;

  for (const { user_id } of users) {
    notifyUserAsync(user_id, tenantId, 'weekly_reflection_prompt', {
      title: 'Weekly Reflection',
      body: 'Take a few minutes to reflect on your week and set intentions.',
      data: { url: '/diary' },
    }, supa);
    dispatched++;
  }

  console.log(`[Scheduled] weekly_reflection_prompt → ${dispatched} users`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /meetup-reminders — Every 15 minutes
// =============================================================================
router.post('/meetup-reminders', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const now = new Date();
  const in15min = new Date(now.getTime() + 15 * 60 * 1000);
  const in5min = new Date(now.getTime() + 5 * 60 * 1000);

  let dispatched = 0;

  // Meetups starting in ~15 minutes (meetup_starting_soon)
  const { data: soonMeetups } = await supa
    .from('community_meetups')
    .select('id, title, starts_at')
    .eq('tenant_id', tenantId)
    .gte('starts_at', now.toISOString())
    .lte('starts_at', in15min.toISOString());

  for (const meetup of soonMeetups || []) {
    // Get RSVP'd users
    const { data: rsvps } = await supa
      .from('community_meetup_attendance')
      .select('user_id')
      .eq('meetup_id', meetup.id)
      .eq('status', 'rsvp');

    for (const { user_id } of rsvps || []) {
      notifyUserAsync(user_id, tenantId, 'meetup_starting_soon', {
        title: 'Meetup Starting Soon',
        body: `"${meetup.title || 'A meetup'}" starts in about 15 minutes.`,
        data: { url: `/community/meetups/${meetup.id}`, meetup_id: meetup.id, entity_id: meetup.id },
      }, supa);
      dispatched++;
    }
  }

  // Meetups starting in ~5 minutes (meetup_starting_now)
  const { data: nowMeetups } = await supa
    .from('community_meetups')
    .select('id, title, starts_at')
    .eq('tenant_id', tenantId)
    .gte('starts_at', now.toISOString())
    .lte('starts_at', in5min.toISOString());

  for (const meetup of nowMeetups || []) {
    const { data: rsvps } = await supa
      .from('community_meetup_attendance')
      .select('user_id')
      .eq('meetup_id', meetup.id)
      .eq('status', 'rsvp');

    for (const { user_id } of rsvps || []) {
      notifyUserAsync(user_id, tenantId, 'meetup_starting_now', {
        title: 'Meetup Starting Now!',
        body: `"${meetup.title || 'A meetup'}" is starting now. Join in!`,
        data: { url: `/community/meetups/${meetup.id}`, meetup_id: meetup.id, entity_id: meetup.id },
      }, supa);
      dispatched++;
    }
  }

  console.log(`[Scheduled] meetup_reminders → ${dispatched} notifications`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /upcoming-events — Daily 8 AM UTC (BOOTSTRAP-NOTIF-SYSTEM-EVENTS)
// Fires `upcoming_event_today` per user for each calendar event scheduled
// today. Push-only (channel='push' in TYPE_META) so it doesn't clutter the
// in-app inbox.
// =============================================================================
router.post('/upcoming-events', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  // Calendar events: fetch every user's events for today in one query so we
  // don't N+1 per user. Sort ascending so each user's first scheduled event
  // surfaces first.
  const { data: events, error } = await supa
    .from('calendar_events')
    .select('id, user_id, title, start_time, status')
    .neq('status', 'cancelled')
    .gte('start_time', todayStart.toISOString())
    .lte('start_time', todayEnd.toISOString())
    .order('start_time', { ascending: true });

  if (error) {
    console.error('[Scheduled] upcoming-events query error:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  // Deduplicate to one notification per user (their first event of the day).
  // Multiple events on the same day would otherwise spam the lock screen.
  const seenUsers = new Set<string>();
  let dispatched = 0;

  for (const ev of events || []) {
    if (seenUsers.has(ev.user_id)) continue;
    seenUsers.add(ev.user_id);

    const start = new Date(ev.start_time);
    const hhmm = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;

    notifyUserAsync(ev.user_id, tenantId, 'upcoming_event_today', {
      title: 'You have an event today',
      body: `"${ev.title || 'Event'}" at ${hhmm}.`,
      data: { url: '/calendar', entity_id: ev.id, event_id: ev.id, start_time: ev.start_time },
    }, supa);
    dispatched++;
  }

  console.log(`[Scheduled] upcoming_event_today → ${dispatched} users`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /recommendation-expiry — Daily 10 AM UTC
// =============================================================================
router.post('/recommendation-expiry', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  // Find recommendations expiring in the next 24 hours
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const { data: expiring } = await supa
    .from('autopilot_recommendations')
    .select('id, user_id, title')
    .eq('tenant_id', tenantId)
    .eq('status', 'pending')
    .lte('expires_at', tomorrow.toISOString())
    .gte('expires_at', new Date().toISOString());

  let dispatched = 0;
  for (const rec of expiring || []) {
    notifyUserAsync(rec.user_id, tenantId, 'recommendation_expires_soon', {
      title: 'Recommendation Expiring',
      body: `"${rec.title || 'A recommendation'}" expires soon. Act now!`,
      data: { url: '/autopilot', entity_id: rec.id, recommendation_id: rec.id },
    }, supa);
    dispatched++;
  }

  console.log(`[Scheduled] recommendation_expires_soon → ${dispatched} notifications`);
  return res.status(200).json({ ok: true, dispatched });
});

// =============================================================================
// POST /signal-cleanup — Daily 3 AM UTC
// =============================================================================
router.post('/signal-cleanup', async (req: Request, res: Response) => {
  const tenantId = getTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id required' });

  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  // Find active signals that have expired
  const { data: expired } = await supa
    .from('d44_predictive_signals')
    .select('id, user_id')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .lte('expires_at', new Date().toISOString());

  let cleaned = 0;
  for (const signal of expired || []) {
    // Mark as expired
    await supa
      .from('d44_predictive_signals')
      .update({ status: 'expired' })
      .eq('id', signal.id);

    // Silent notification (no push, in-app only for audit)
    notifyUserAsync(signal.user_id, tenantId, 'signal_expired', {
      title: 'Signal Expired',
      body: 'A predictive signal has expired.',
      data: { entity_id: signal.id },
    }, supa);
    cleaned++;
  }

  console.log(`[Scheduled] signal_cleanup → ${cleaned} signals expired`);
  return res.status(200).json({ ok: true, cleaned });
});

// =============================================================================
// POST /push-dispatch — Every 30 seconds (Cloud Scheduler)
// Picks up trigger-created notifications that haven't had FCM push sent yet.
// DB triggers (chat messages, group invites, predictive signals, etc.) write
// to user_notifications but can't send FCM. This cron bridges the gap.
// =============================================================================
router.post('/push-dispatch', async (req: Request, res: Response) => {
  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  // Find notifications created by DB triggers that haven't been pushed yet.
  // push_sent_at IS NULL  → not yet pushed
  // channel includes push → should be pushed
  // created in last 5 min → don't bother with very old ones
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: pending, error } = await supa
    .from('user_notifications')
    .select('id, user_id, tenant_id, type, title, body, data, channel, priority')
    .is('push_sent_at', null)
    .in('channel', ['push', 'push_and_inapp'])
    .gte('created_at', fiveMinAgo)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) {
    console.error('[PushDispatch] Query error:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }

  if (!pending?.length) {
    return res.status(200).json({ ok: true, dispatched: 0, message: 'no pending pushes' });
  }

  let dispatched = 0;
  let skipped = 0;

  for (const notif of pending) {
    try {
      // Check user preferences (DND, category toggles, push_enabled)
      const { data: prefs } = await supa
        .from('user_notification_preferences')
        .select('*')
        .eq('user_id', notif.user_id)
        .eq('tenant_id', notif.tenant_id)
        .maybeSingle();

      // If push disabled globally, skip push but still mark as handled
      if (prefs?.push_enabled === false) {
        await supa.from('user_notifications')
          .update({ push_sent_at: new Date().toISOString() })
          .eq('id', notif.id);
        skipped++;
        continue;
      }

      // DND check — p0 bypasses DND
      if (prefs?.dnd_enabled && prefs.dnd_start_time && prefs.dnd_end_time && notif.priority !== 'p0') {
        const now = new Date();
        const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const start = prefs.dnd_start_time;
        const end = prefs.dnd_end_time;
        const inDnd = start > end ? (hhmm >= start || hhmm < end) : (hhmm >= start && hhmm < end);
        if (inDnd) {
          await supa.from('user_notifications')
            .update({ push_sent_at: new Date().toISOString() })
            .eq('id', notif.id);
          skipped++;
          continue;
        }
      }

      // Send FCM web push + Appilix native push
      const pushPayload = {
        title: notif.title || 'Vitana',
        body: notif.body || '',
        data: typeof notif.data === 'object' && notif.data !== null
          ? Object.fromEntries(Object.entries(notif.data).map(([k, v]) => [k, String(v)]))
          : undefined,
      };
      const sent = await sendPushToUser(notif.user_id, notif.tenant_id, pushPayload, supa);
      const appilixSent = await sendAppilixPush(notif.user_id, pushPayload);

      // Mark as dispatched
      await supa.from('user_notifications')
        .update({ push_sent_at: new Date().toISOString() })
        .eq('id', notif.id);

      if (sent > 0 || appilixSent) dispatched++;
      else skipped++; // No device tokens found and Appilix not configured
    } catch (err: any) {
      console.error(`[PushDispatch] Failed for notification ${notif.id}:`, err.message || err);
      // Still mark as sent to avoid infinite retries
      await supa.from('user_notifications')
        .update({ push_sent_at: new Date().toISOString() })
        .eq('id', notif.id);
      skipped++;
    }
  }

  console.log(`[PushDispatch] dispatched=${dispatched} skipped=${skipped} total=${pending.length}`);
  return res.status(200).json({ ok: true, dispatched, skipped, total: pending.length });
});

// =============================================================================
// POST /recommendation-cleanup — Daily 3 AM UTC (alongside signal-cleanup)
// VTID-01185: Clean up expired/stale recommendations
// =============================================================================
router.post('/recommendation-cleanup', async (_req: Request, res: Response) => {
  try {
    const supa = await getServiceClient();
    if (!supa) return res.status(500).json({ ok: false, error: 'Missing Supabase credentials' });

    const now = new Date().toISOString();
    let expired = 0;
    let unsnoozed = 0;
    let stalePurged = 0;

    // 1. Expire recommendations past their expires_at
    const { count: expiredCount } = await supa
      .from('autopilot_recommendations')
      .update({ status: 'rejected', updated_at: now })
      .eq('status', 'new')
      .not('expires_at', 'is', null)
      .lt('expires_at', now);
    expired = expiredCount || 0;

    // 2. Unsnoze past-due snoozed recommendations
    const { count: unsnoozedCount } = await supa
      .from('autopilot_recommendations')
      .update({ status: 'new', snoozed_until: null, updated_at: now })
      .eq('status', 'snoozed')
      .lt('snoozed_until', now);
    unsnoozed = unsnoozedCount || 0;

    // 3. Purge stale seed data (no fingerprint, >30 days old)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { count: staleCount } = await supa
      .from('autopilot_recommendations')
      .update({ status: 'rejected', updated_at: now })
      .eq('status', 'new')
      .is('fingerprint', null)
      .lt('created_at', thirtyDaysAgo);
    stalePurged = staleCount || 0;

    // 4. Try RPC cleanup if available
    try {
      await supa.rpc('cleanup_expired_autopilot_recommendations');
    } catch {
      // RPC may not exist yet
    }

    console.log(`[RecommendationCleanup] expired=${expired} unsnoozed=${unsnoozed} stale_purged=${stalePurged}`);
    return res.status(200).json({
      ok: true,
      expired,
      unsnoozed,
      stale_purged: stalePurged,
      timestamp: now,
    });
  } catch (err: any) {
    console.error('[RecommendationCleanup] Error:', err.message || err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// VTID-02601 — POST /reminders-tick — every 30 seconds (Cloud Scheduler)
//
// Picks up reminders whose next_fire_at is within 15 seconds, atomically
// claims them via FOR UPDATE SKIP LOCKED, marks them 'fired', and lets the
// LISTEN/NOTIFY trigger fan out to SSE subscribers (PR-2 wires consumers).
// FCM fallback (PR-4) is scheduled at fire+5s if the row stays unacked.
// =============================================================================
router.post('/reminders-tick', async (_req: Request, res: Response) => {
  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  try {
    // Atomic claim + mark dispatching. Look-ahead window: 15s. Limit batch
    // size to avoid runaway under load — operators should run this every
    // 30s so the worst-case fire latency stays under ~30s late / ~15s early.
    const { data: claimed, error: claimErr } = await supa.rpc('reminders_claim_due', {
      p_lookahead_seconds: 15,
      p_limit: 200,
    });

    // RPC may not exist on older DBs — fall back to a non-atomic UPDATE for
    // dev. In production the migration creates the RPC. The fallback is best-
    // effort and will deliver-at-most-once across pods due to status filter.
    let rows: any[] = [];
    if (claimErr) {
      const lookahead = new Date(Date.now() + 15_000).toISOString();
      const { data: fallback, error: fallbackErr } = await supa
        .from('reminders')
        .update({
          status: 'dispatching',
          dispatch_started_at: new Date().toISOString(),
        })
        .eq('status', 'pending')
        .lte('next_fire_at', lookahead)
        .select('*')
        .limit(200);
      if (fallbackErr) {
        console.error('[reminders-tick] claim fallback failed:', fallbackErr.message);
        return res.status(500).json({ ok: false, error: fallbackErr.message });
      }
      rows = fallback || [];
    } else {
      rows = claimed || [];
    }

    if (!rows.length) {
      return res.status(200).json({ ok: true, fired: 0, message: 'no due reminders' });
    }

    let fired = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        // Mark fired — this triggers pg_notify('reminder_fired', ...) for any
        // SSE pod that is LISTENing. PR-2 wires the listener.
        const { error: fireErr } = await supa
          .from('reminders')
          .update({
            status: 'fired',
            fired_at: new Date().toISOString(),
          })
          .eq('id', row.id);
        if (fireErr) {
          console.error(`[reminders-tick] mark fired failed for ${row.id}:`, fireErr.message);
          failed++;
          continue;
        }

        // Emit OASIS event for observability — one row per fire.
        try {
          const { emitOasisEvent } = await import('../services/oasis-event-service');
          await emitOasisEvent({
            type: 'reminder.fired' as any,
            source: 'gateway',
            vtid: 'VTID-REMINDER',
            status: 'info',
            message: `Reminder fired`,
            payload: {
              reminder_id: row.id,
              user_id: row.user_id,
              tenant_id: row.tenant_id,
              scheduled_for: row.next_fire_at,
              latency_ms: Date.now() - new Date(row.next_fire_at).getTime(),
            },
          });
        } catch {}

        // VTID-02601 FCM fallback: 5s after fire, if SSE didn't ack the row,
        // send an OS-level push notification so the user gets the reminder
        // even if the app is closed / phone locked / WebView suspended.
        // SSE wins for active clients (it acks within ~3s); FCM catches the
        // rest. Best-effort, fully detached — does not block the tick.
        scheduleReminderFcmFallback(supa, row).catch((e) =>
          console.warn(`[reminders-tick] FCM fallback schedule failed for ${row.id}:`, e?.message),
        );

        fired++;
      } catch (err: any) {
        console.error(`[reminders-tick] error firing ${row.id}:`, err?.message);
        failed++;
      }
    }

    console.log(`[reminders-tick] fired=${fired} failed=${failed} total=${rows.length}`);
    return res.status(200).json({ ok: true, fired, failed, total: rows.length });
  } catch (err: any) {
    console.error('[reminders-tick] error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'internal' });
  }
});

// =============================================================================
// VTID-02601 — POST /reminders-sweeper — every 5 minutes (Cloud Scheduler)
//
// Recovers rows stuck in 'dispatching' for >2min (pod crash mid-fire).
// Resets to 'pending' with attempts++. Circuit-break at attempts>=5 → 'failed'.
// =============================================================================
router.post('/reminders-sweeper', async (_req: Request, res: Response) => {
  const supa = await getServiceClient();
  if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });

  try {
    const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    // First find stuck rows so we can decide attempts++ vs 'failed' per row.
    const { data: stuck, error: queryErr } = await supa
      .from('reminders')
      .select('id, dispatch_attempts')
      .eq('status', 'dispatching')
      .lt('dispatch_started_at', cutoff)
      .limit(500);
    if (queryErr) throw new Error(queryErr.message);
    if (!stuck?.length) {
      return res.status(200).json({ ok: true, recovered: 0, failed: 0 });
    }

    let recovered = 0;
    let exhausted = 0;
    for (const r of stuck) {
      const attempts = (r.dispatch_attempts || 0) + 1;
      const newStatus = attempts >= 5 ? 'failed' : 'pending';
      const { error: updErr } = await supa
        .from('reminders')
        .update({
          status: newStatus,
          dispatch_attempts: attempts,
          dispatch_started_at: null,
        })
        .eq('id', r.id);
      if (updErr) {
        console.error(`[reminders-sweeper] update ${r.id} failed:`, updErr.message);
        continue;
      }
      if (newStatus === 'pending') recovered++;
      else exhausted++;
    }

    console.log(`[reminders-sweeper] recovered=${recovered} exhausted=${exhausted} total=${stuck.length}`);
    return res.status(200).json({ ok: true, recovered, exhausted, total: stuck.length });
  } catch (err: any) {
    console.error('[reminders-sweeper] error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'internal' });
  }
});

// =============================================================================
// VTID-02601 — scheduleReminderFcmFallback
//
// 5 seconds after a reminder is marked 'fired', re-check `acked_at`. If the
// SSE listener already acked the row (because the app is open and the user
// got the chime + voice + banner), skip — the user has been notified. If
// not, send an FCM web push so the OS surfaces a notification. Also try
// Appilix native push for the Maxina installed app (currently 522 per memory,
// but worth retrying — fails silently if API is down).
//
// Detached from the request handler — Cloud Run keeps the function instance
// alive long enough for the 5-second timer because the gateway has CPU
// always-on (set in EXEC-DEPLOY). Worst case (instance scales to zero),
// the FCM is dropped and the next tick poll picks it up via the existing
// fired+unacked SSE flow.
// =============================================================================
async function scheduleReminderFcmFallback(
  supa: any,
  row: { id: string; user_id: string; tenant_id: string; action_text: string; spoken_message: string | null }
): Promise<void> {
  await new Promise((r) => setTimeout(r, 5000));

  // Re-check acked_at — SSE may have already delivered + the user dismissed.
  const { data: fresh } = await supa
    .from('reminders')
    .select('id, acked_at, delivery_via')
    .eq('id', row.id)
    .maybeSingle();
  if (fresh?.acked_at) {
    console.log(`[reminders-tick] FCM skip — already acked via ${fresh.delivery_via} (${row.id})`);
    return;
  }

  const payload = {
    title: '🔔 Reminder',
    body: row.action_text,
    data: {
      type: 'reminder.fire',
      reminder_id: row.id,
      url: '/reminders',
      spoken_message: row.spoken_message || '',
    },
  };

  try {
    const fcmSent = await sendPushToUser(row.user_id, row.tenant_id, payload, supa);
    const appilixSent = await sendAppilixPush(row.user_id, payload);
    console.log(`[reminders-tick] FCM fallback for ${row.id}: fcm=${fcmSent} appilix=${appilixSent}`);

    // Mark delivery_via=fcm if we sent at least one push and the row is still
    // unacked. The SSE flow may still race-deliver later — that's fine, the
    // overlay's seen-set dedups so the user never sees the same fire twice.
    if (fcmSent > 0 || appilixSent) {
      await supa
        .from('reminders')
        .update({ delivery_via: 'fcm' })
        .eq('id', row.id)
        .is('acked_at', null);
    }

    try {
      const { emitOasisEvent } = await import('../services/oasis-event-service');
      await emitOasisEvent({
        type: 'reminder.fcm_fallback' as any,
        source: 'gateway',
        vtid: 'VTID-REMINDER',
        status: 'info',
        message: `Reminder FCM fallback sent`,
        payload: {
          reminder_id: row.id,
          user_id: row.user_id,
          fcm_devices: fcmSent,
          appilix_sent: !!appilixSent,
        },
      });
    } catch {}
  } catch (err: any) {
    console.error(`[reminders-tick] FCM fallback error for ${row.id}:`, err?.message);
  }
}

// =============================================================================
// Health check
// =============================================================================
router.get('/health', (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true, service: 'scheduled-notifications' });
});

export default router;
