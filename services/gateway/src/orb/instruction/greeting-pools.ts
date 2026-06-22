/**
 * BOOTSTRAP-ORB-MOVE: Phase 2 (move-only) — short-gap greeting phrase pool
 * plus the randomizer that injects a subset into the system instruction.
 *
 * Gemini tends to converge on a single translation every short-gap reopening.
 * To avoid the same phrase every time the user reopens the orb after seconds
 * or minutes, we maintain a per-language pool of short, warm openers and
 * inject a random subset into the greeting prompt each turn. Applies ONLY to
 * the short-gap buckets (reconnect, recent, same_day) — new-day greetings keep
 * the polite "Good morning, [Name]" pattern untouched.
 */

// VTID-03090: every phrase below MUST sound like a warm, service-grade
// concierge — never dismissive, never street-casual, never the kind of
// thing a busy receptionist says to get rid of you.
//
// Banned tonal patterns (these were in the prior pool and got cut):
//   - one-word interrogatives: "Yes?", "Ja bitte?", "Oui ?", "¿Sí?",
//     "Да?", "嗯？" — these read as impatient.
//   - "what's new" casuals: "Was gibt's Neues?", "Quoi de neuf ?",
//     "¿Qué hay?", "Что нового?", "Шта има ново?", "有什么新鲜事？"
//   - curt commands: "Go ahead.", "Bereit.", "Lista.", "请说。"
//   - colloquial "what's up": "Was liegt an?", "Worum geht's?"
//
// VTID-03256 — every phrase greets warmly, then LEADS to the next step.
// Vitana proposes the move; she never asks the user's preference ("what would
// you like?") — a returning user is here to continue, so we continue them.
//
// HARD RULE (broken-promise fix): this is the GENERIC fallback pool, used when
// there is NO loaded last-session context. So a phrase here must NEVER claim to
// resume a remembered conversation ("pick up where we left off", "dort
// anknüpfen, wo wir waren", bare "lass uns weitermachen") — Vitana cannot
// deliver that and the user calls the bluff ("I don't remember where we
// ended"). Lead to the NEXT STEP or SHOW WHERE WE ARE (both grounded in the
// journey/awareness she always has), never to an unrecalled past.
// BOOTSTRAP-ORB-NO-VAGUE-GREETING — this pool flows to EVERY opener consumer
// (the per-turn opener prompt AND the system-instruction greeting block). The
// previous EN/DE lines were content-free "next step" teasers ("let me show you
// your next step" / "lass mich dich zum nächsten Schritt führen") — the exact
// lines the user kept hearing on every reopen — and the other languages were
// "how can I help?" preference questions, which the doctrine forbids (Vitana
// LEADS, never asks the user's preference). Per this file's HARD RULE, a generic
// fallback may "SHOW WHERE WE ARE" (grounded in the standing/overview Vitana
// always has) but must NEVER claim an unrecalled past or dangle a content-free
// teaser. Every line below now leads to the user's current standing.
export const SHORT_GAP_GREETING_PHRASES: Record<string, string[]> = {
  en: [
    "Welcome back. Let's look at where you stand.",
    "Good to have you back. Let's go over your overview.",
    "Hi again. Let's see where you are right now.",
    "Nice to hear you. Let's look at where things stand.",
    "Welcome back. Let's check your current standing.",
    "Good to see you again. Let's go over where you are.",
    "Welcome back. Let's look at your overview together.",
    "Good to have you back. Let's see where you stand.",
  ],
  de: [
    "Schön, dich wieder zu hören. Schauen wir, wo du gerade stehst.",
    "Willkommen zurück. Sehen wir uns deine Übersicht an.",
    "Schön, dass du wieder da bist. Schauen wir, wo du stehst.",
    "Hallo nochmal. Schauen wir uns gemeinsam deinen Stand an.",
    "Gut, dich wieder zu hören. Sehen wir, wo du gerade stehst.",
    "Schön, dass du wieder hier bist. Werfen wir einen Blick auf deine Übersicht.",
    "Willkommen zurück. Schauen wir uns deinen aktuellen Stand an.",
    "Schön, dich wieder zu sehen. Sehen wir, wo du stehst.",
  ],
  fr: [
    "Content de te revoir. Voyons où tu en es.",
    "Bienvenue. Regardons ton aperçu ensemble.",
    "Heureuse de t'entendre. Voyons où tu en es maintenant.",
    "Bonjour à nouveau. Regardons où tu en es.",
    "Je suis là pour toi. Faisons le point sur ta situation.",
    "Content de te revoir. Voyons où tu en es aujourd'hui.",
    "Ravi de t'entendre. Regardons ton aperçu.",
    "Bienvenue. Voyons où tu en es.",
  ],
  es: [
    "Bienvenido de nuevo. Veamos dónde estás.",
    "Me alegra escucharte. Veamos tu resumen.",
    "Hola de nuevo. Veamos dónde te encuentras ahora.",
    "Bienvenido. Veamos cómo vas.",
    "Aquí estoy para ti. Veamos tu situación actual.",
    "Qué bueno verte de nuevo. Veamos dónde estás.",
    "Encantada de escucharte. Veamos tu resumen.",
    "Hola. Veamos dónde estás hoy.",
  ],
  ar: [
    "أهلاً بعودتك. لنرَ أين وصلت.",
    "سعيدة بسماعك مجدداً. لنلقِ نظرة على ملخصك.",
    "مرحباً مرة أخرى. لنرَ أين أنت الآن.",
    "أنا هنا من أجلك. لنرَ وضعك الحالي.",
    "أهلاً بك. لنرَ أين وصلت اليوم.",
    "تسعدني عودتك. لنرَ أين أنت.",
    "مرحباً. لنلقِ نظرة على ملخصك.",
    "يسعدني سماعك. لنرَ أين وصلت.",
  ],
  zh: [
    "欢迎回来。我们来看看你目前的情况。",
    "很高兴再次听到你。我们来看看你的概览。",
    "你好，再次见到你。我们来看看你现在的进度。",
    "我在这里为你服务。我们来看看你目前的状态。",
    "欢迎回来。我们来看看你的现状。",
    "很高兴你回来了。我们来看看你的进展。",
    "你好。我们来看看你的概览。",
    "再次见到你真好。我们看看你目前在哪一步。",
  ],
  ru: [
    "Рада снова тебя слышать. Давай посмотрим, где ты сейчас.",
    "Добро пожаловать. Давай взглянем на твой обзор.",
    "Снова здравствуй. Посмотрим, где ты сейчас.",
    "Я здесь для тебя. Давай посмотрим, на каком ты этапе.",
    "Приятно снова тебя слышать. Давай посмотрим, где ты.",
    "С возвращением. Давай посмотрим на твой текущий статус.",
    "Здравствуй ещё раз. Посмотрим на твой обзор.",
    "Рада, что ты снова здесь. Давай посмотрим, где ты сейчас.",
  ],
  sr: [
    "Драго ми је што те поново чујем. Хајде да видимо где си сада.",
    "Добро дошао назад. Погледајмо твој преглед.",
    "Здраво поново. Да видимо где си тренутно.",
    "Ту сам за тебе. Погледајмо твоју тренутну ситуацију.",
    "Драго ми је што те видим поново. Да видимо где си.",
    "Добро дошао. Погледајмо твој тренутни напредак.",
    "Поздрав. Погледајмо твој преглед.",
    "Лепо што си се вратио. Да видимо где си сада.",
  ],
};

/**
 * Pick N phrases from the lang pool without replacement. Randomized per call
 * so the system instruction and the turn-start prompt each see a fresh
 * ordering — Gemini strongly biases toward the first option in a list, so
 * rotating the order is the cheapest effective variety lever.
 */
export function pickShortGapGreetings(lang: string, count: number): string[] {
  const pool = SHORT_GAP_GREETING_PHRASES[lang] || SHORT_GAP_GREETING_PHRASES.en;
  const copy = pool.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(count, copy.length));
}
