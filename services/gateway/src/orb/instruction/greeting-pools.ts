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

export const SHORT_GAP_GREETING_PHRASES: Record<string, string[]> = {
  en: [
    "I'm listening.",
    "I'm all ears.",
    "Go ahead.",
    "Ready for you.",
    "How can I help?",
    "What's on your mind?",
    "What would you like to know?",
    "What do you need?",
    "How can I support you?",
    "Yes?",
    "I'm here.",
    "At your service.",
  ],
  de: [
    "Ich bin ganz Ohr!",
    "Ich höre!",
    "Ich höre dir zu.",
    "Ja bitte?",
    "Was gibt's Neues?",
    "Stets zu Diensten!",
    "Womit kann ich helfen?",
    "Was möchtest du wissen?",
    "Worum geht's?",
    "Was liegt an?",
    "Bereit.",
    "Ich bin da.",
    "Was brauchst du?",
  ],
  fr: [
    "Je t'écoute.",
    "Je suis tout ouïe.",
    "À ton service.",
    "Oui ?",
    "Quoi de neuf ?",
    "Comment puis-je aider ?",
    "De quoi as-tu besoin ?",
    "Que veux-tu savoir ?",
    "Je suis là.",
    "Prête.",
  ],
  es: [
    "Te escucho.",
    "Soy toda oídos.",
    "A tu servicio.",
    "¿Sí?",
    "¿Qué hay?",
    "¿En qué puedo ayudar?",
    "¿Qué necesitas?",
    "¿Qué quieres saber?",
    "Aquí estoy.",
    "Lista.",
  ],
  ar: [
    "أنا أسمعك.",
    "تفضل.",
    "في خدمتك.",
    "نعم؟",
    "كيف يمكنني المساعدة؟",
    "ماذا تحتاج؟",
    "ماذا تريد أن تعرف؟",
    "أنا هنا.",
  ],
  zh: [
    "我在听。",
    "请说。",
    "为你服务。",
    "嗯？",
    "有什么新鲜事？",
    "有什么我可以帮忙的？",
    "你需要什么？",
    "你想知道什么？",
    "我在这里。",
  ],
  ru: [
    "Я слушаю.",
    "Я вся внимание.",
    "К твоим услугам.",
    "Да?",
    "Что нового?",
    "Чем могу помочь?",
    "Что вас интересует?",
    "Что тебе нужно?",
    "Я здесь.",
  ],
  sr: [
    "Слушам те.",
    "Сва сам уши.",
    "На услузи.",
    "Да?",
    "Шта има ново?",
    "Како могу да помогнем?",
    "Шта ти треба?",
    "Шта те занима?",
    "Ту сам.",
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
