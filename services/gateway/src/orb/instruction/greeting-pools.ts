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
// Every remaining phrase greets the user warmly, then offers help.
export const SHORT_GAP_GREETING_PHRASES: Record<string, string[]> = {
  en: [
    "Welcome back. How can I help you?",
    "Good to have you back. What would you like to do?",
    "Hi again. How can I support you?",
    "Nice to hear you. What can I help with?",
    "Welcome back. What is on your mind?",
    "I'm here for you. How can I help?",
    "Good to see you again. What would you like to focus on?",
    "Welcome back. What would you like to pick up on?",
  ],
  de: [
    "Schön, dich wieder zu hören. Wie kann ich dir helfen?",
    "Willkommen zurück. Womit kann ich dich unterstützen?",
    "Schön, dass du wieder da bist. Womit kann ich helfen?",
    "Hallo nochmal. Wie kann ich dir helfen?",
    "Gut, dich wieder zu hören. Worauf möchtest du eingehen?",
    "Schön, dass du wieder hier bist. Was kann ich für dich tun?",
    "Willkommen zurück. Was steht für dich an?",
    "Ich bin für dich da. Wie kann ich dir helfen?",
  ],
  fr: [
    "Content de te revoir. Comment puis-je t'aider ?",
    "Bienvenue. Comment puis-je t'accompagner ?",
    "Heureuse de t'entendre. Que veux-tu faire ?",
    "Bonjour à nouveau. Comment puis-je aider ?",
    "Je suis là pour toi. Comment puis-je t'aider ?",
    "Content de te revoir. Sur quoi veux-tu te concentrer ?",
    "Ravi de t'entendre. Comment puis-je t'aider ?",
    "Bienvenue. Que puis-je faire pour toi ?",
  ],
  es: [
    "Bienvenido de nuevo. ¿En qué puedo ayudarte?",
    "Me alegra escucharte. ¿En qué puedo ayudarte?",
    "Hola de nuevo. ¿Cómo puedo apoyarte?",
    "Bienvenido. ¿En qué te puedo ayudar?",
    "Aquí estoy para ti. ¿En qué puedo ayudar?",
    "Qué bueno verte de nuevo. ¿En qué quieres enfocarte?",
    "Encantada de escucharte. ¿Cómo puedo ayudarte?",
    "Hola. ¿En qué puedo apoyarte hoy?",
  ],
  ar: [
    "أهلاً بعودتك. كيف يمكنني مساعدتك؟",
    "سعيدة بسماعك مجدداً. بماذا يمكنني مساعدتك؟",
    "مرحباً مرة أخرى. كيف يمكنني دعمك؟",
    "أنا هنا من أجلك. كيف يمكنني المساعدة؟",
    "أهلاً بك. كيف يمكنني خدمتك اليوم؟",
    "تسعدني عودتك. كيف يمكنني المساعدة؟",
    "مرحباً. بماذا يمكنني دعمك؟",
    "يسعدني سماعك. كيف يمكنني المساعدة؟",
  ],
  zh: [
    "欢迎回来。我能为你做什么？",
    "很高兴再次听到你。需要我帮什么忙吗？",
    "你好，再次见到你。我能为你提供什么帮助？",
    "我在这里为你服务。需要我帮什么忙吗？",
    "欢迎回来。我可以帮你什么？",
    "很高兴你回来了。今天有什么可以帮你的？",
    "你好。我能为你做些什么？",
    "再次见到你真好。我能为你提供什么支持？",
  ],
  ru: [
    "Рада снова тебя слышать. Чем могу помочь?",
    "Добро пожаловать. Чем я могу помочь?",
    "Снова здравствуй. Как я могу тебя поддержать?",
    "Я здесь для тебя. Чем могу помочь?",
    "Приятно снова тебя слышать. Чем могу помочь?",
    "С возвращением. Чем я могу тебе помочь?",
    "Здравствуй ещё раз. Как я могу тебя поддержать?",
    "Рада, что ты снова здесь. Чем могу помочь?",
  ],
  sr: [
    "Добро дошао назад. Како могу да ти помогнем?",
    "Драго ми је што те поново чујем. Како могу да помогнем?",
    "Здраво поново. Чиме могу да те подржим?",
    "Ту сам за тебе. Како могу да помогнем?",
    "Добро дошао. Шта могу да урадим за тебе?",
    "Драго ми је што те видим поново. Како могу да помогнем?",
    "Поздрав. Како могу да те подржим данас?",
    "Лепо што си се вратио. Како могу да помогнем?",
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
