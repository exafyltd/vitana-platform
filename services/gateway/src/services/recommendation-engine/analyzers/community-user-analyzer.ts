/**
 * Community User Analyzer - VTID-01185
 *
 * Per-user personalized recommendation analyzer.
 * Generates community-focused recommendations based on:
 * - Onboarding stage (day 0, 1, 3, 7, 14, 30+)
 * - Health scores & weaknesses
 * - Diary mood/energy
 * - Connection count & group memberships
 * - Pending matches
 * - Diary streak
 * - User's preferred language (8 supported)
 *
 * Unlike system-wide analyzers, this runs for a SINGLE user at a time.
 */

import { createHash } from 'crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import { detectWeaknesses, WeaknessType, HealthScores } from '../../personalization-service';

const LOG_PREFIX = '[VTID-01185:CommunityUser]';

// =============================================================================
// i18n — 8 supported languages
// =============================================================================

export type LangCode = 'en' | 'de' | 'fr' | 'es' | 'ar' | 'zh' | 'ru' | 'sr';

const LANG_NAME_TO_CODE: Record<string, LangCode> = {
  'English': 'en', 'German': 'de', 'Deutsch': 'de',
  'French': 'fr', 'Français': 'fr',
  'Spanish': 'es', 'Español': 'es',
  'Arabic': 'ar', 'Chinese': 'zh',
  'Russian': 'ru', 'Serbian': 'sr',
};

/** Resolve full language name (from memory_facts) → 2-letter code. Default: 'en'. */
export function resolveLanguage(factValue: string | null | undefined): LangCode {
  if (!factValue) return 'en';
  return LANG_NAME_TO_CODE[factValue] ?? 'en';
}

// =============================================================================
// Translation map — key → lang → { title, summary }
// Placeholders: {count}
// =============================================================================

const T: Record<string, Partial<Record<LangCode, { title: string; summary: string }>>> = {
  // ── Onboarding Day 0 ──────────────────────────────────────────────
  onboarding_profile: {
    en: { title: 'Complete your profile', summary: 'A complete profile helps us understand you and give better recommendations.' },
    de: { title: 'Vervollständige dein Profil', summary: 'Ein vollständiges Profil hilft uns, dich besser zu verstehen und passende Empfehlungen zu geben.' },
    fr: { title: 'Complète ton profil', summary: 'Un profil complet nous aide à mieux te comprendre et à te donner de meilleures recommandations.' },
    es: { title: 'Completa tu perfil', summary: 'Un perfil completo nos ayuda a entenderte mejor y darte mejores recomendaciones.' },
    ar: { title: 'أكمل ملفك الشخصي', summary: 'يساعدنا الملف الشخصي الكامل على فهمك بشكل أفضل وتقديم توصيات أفضل.' },
    zh: { title: '完善你的个人资料', summary: '完整的个人资料帮助我们更好地了解你，提供更好的推荐。' },
    ru: { title: 'Заполни свой профиль', summary: 'Полный профиль помогает нам лучше понять тебя и давать лучшие рекомендации.' },
    sr: { title: 'Popuni svoj profil', summary: 'Potpuni profil nam pomaže da te bolje razumemo i damo bolje preporuke.' },
  },
  onboarding_explore: {
    en: { title: 'Explore your community', summary: 'See who is nearby and which groups exist.' },
    de: { title: 'Entdecke deine Community', summary: 'Schau dir an, wer in deiner Nähe ist und welche Gruppen es gibt.' },
    fr: { title: 'Explore ta communauté', summary: 'Découvre qui est près de toi et quels groupes existent.' },
    es: { title: 'Explora tu comunidad', summary: 'Mira quién está cerca y qué grupos hay.' },
    ar: { title: 'استكشف مجتمعك', summary: 'شاهد من بالقرب منك وأي المجموعات موجودة.' },
    zh: { title: '探索你的社区', summary: '看看你附近有谁，有哪些群组。' },
    ru: { title: 'Исследуй своё сообщество', summary: 'Посмотри, кто рядом и какие группы есть.' },
    sr: { title: 'Istraži svoju zajednicu', summary: 'Pogledaj ko je u blizini i koje grupe postoje.' },
  },
  onboarding_maxina: {
    en: { title: 'Say hello to Maxina', summary: 'Your AI companion Maxina is ready to get to know you. Start a conversation!' },
    de: { title: 'Sag Hallo zu Maxina', summary: 'Deine KI-Begleiterin Maxina ist bereit, dich kennenzulernen. Starte ein Gespräch!' },
    fr: { title: 'Dis bonjour à Maxina', summary: 'Ton assistante IA Maxina est prête à te connaître. Lance une conversation !' },
    es: { title: 'Saluda a Maxina', summary: 'Tu compañera IA Maxina está lista para conocerte. ¡Inicia una conversación!' },
    ar: { title: 'قل مرحباً لماكسينا', summary: 'رفيقتك الذكية ماكسينا جاهزة للتعرف عليك. ابدأ محادثة!' },
    zh: { title: '向Maxina问好', summary: '你的AI伙伴Maxina已准备好认识你。开始对话吧！' },
    ru: { title: 'Поздоровайся с Максиной', summary: 'Твой ИИ-компаньон Максина готова познакомиться с тобой. Начни разговор!' },
    sr: { title: 'Pozdravi Maxinu', summary: 'Tvoj AI pratilac Maxina je spremna da te upozna. Započni razgovor!' },
  },

  // ── Onboarding Day 1 ──────────────────────────────────────────────
  onboarding_diary: {
    en: { title: 'Write your first diary entry', summary: 'Record how you feel today. Maxina can help you.' },
    de: { title: 'Schreibe deinen ersten Tagebucheintrag', summary: 'Halte fest, wie du dich heute fühlst. Maxina kann dir dabei helfen.' },
    fr: { title: 'Écris ta première entrée de journal', summary: "Note comment tu te sens aujourd'hui. Maxina peut t'aider." },
    es: { title: 'Escribe tu primera entrada de diario', summary: 'Registra cómo te sientes hoy. Maxina puede ayudarte.' },
    ar: { title: 'اكتب أول إدخال في يومياتك', summary: 'سجّل كيف تشعر اليوم. ماكسينا يمكنها مساعدتك.' },
    zh: { title: '写下你的第一篇日记', summary: '记录你今天的感受。Maxina可以帮助你。' },
    ru: { title: 'Напиши свою первую запись в дневнике', summary: 'Запиши, как ты себя чувствуешь сегодня. Максина поможет тебе.' },
    sr: { title: 'Napiši svoj prvi dnevnički unos', summary: 'Zabeleži kako se danas osećaš. Maxina ti može pomoći.' },
  },
  onboarding_matches: {
    en: { title: 'Check your matches', summary: 'We found people who match you. Take a look!' },
    de: { title: 'Schau dir deine Matches an', summary: 'Wir haben passende Personen für dich gefunden. Schau mal rein!' },
    fr: { title: 'Regarde tes matchs', summary: 'Nous avons trouvé des personnes qui te correspondent. Jette un œil !' },
    es: { title: 'Mira tus matches', summary: 'Encontramos personas compatibles contigo. ¡Échales un vistazo!' },
    ar: { title: 'تحقق من تطابقاتك', summary: 'وجدنا أشخاصاً يناسبونك. ألقِ نظرة!' },
    zh: { title: '查看你的匹配', summary: '我们为你找到了合适的人。看看吧！' },
    ru: { title: 'Посмотри свои совпадения', summary: 'Мы нашли подходящих тебе людей. Загляни!' },
    sr: { title: 'Pogledaj svoje poklapanja', summary: 'Pronašli smo ljude koji ti odgovaraju. Pogledaj!' },
  },
  onboarding_group: {
    en: { title: 'Join a group', summary: 'Groups connect you with like-minded people. Find one that suits you.' },
    de: { title: 'Tritt einer Gruppe bei', summary: 'Gruppen verbinden dich mit Gleichgesinnten. Finde eine, die zu dir passt.' },
    fr: { title: 'Rejoins un groupe', summary: 'Les groupes te connectent avec des gens qui te ressemblent. Trouve celui qui te convient.' },
    es: { title: 'Únete a un grupo', summary: 'Los grupos te conectan con personas afines. Encuentra uno que te guste.' },
    ar: { title: 'انضم إلى مجموعة', summary: 'المجموعات تربطك بأشخاص يشبهونك في التفكير. اعثر على واحدة تناسبك.' },
    zh: { title: '加入一个群组', summary: '群组将你与志同道合的人联系起来。找一个适合你的。' },
    ru: { title: 'Присоединись к группе', summary: 'Группы связывают тебя с единомышленниками. Найди подходящую.' },
    sr: { title: 'Pridruži se grupi', summary: 'Grupe te povezuju sa istomišljenicima. Pronađi onu koja ti odgovara.' },
  },

  // ── Day 3: Engagement ─────────────────────────────────────────────
  engage_matches: {
    en: { title: 'Respond to your matches', summary: 'You have pending match suggestions. Connect with someone!' },
    de: { title: 'Reagiere auf deine Matches', summary: 'Du hast noch offene Match-Vorschläge. Verbinde dich mit jemandem!' },
    fr: { title: 'Réponds à tes matchs', summary: "Tu as des suggestions de matchs en attente. Connecte-toi avec quelqu'un !" },
    es: { title: 'Responde a tus matches', summary: 'Tienes sugerencias de matches pendientes. ¡Conéctate con alguien!' },
    ar: { title: 'رد على تطابقاتك', summary: 'لديك اقتراحات تطابق معلقة. تواصل مع شخص ما!' },
    zh: { title: '回应你的匹配', summary: '你有待处理的匹配建议。与某人联系吧！' },
    ru: { title: 'Ответь на свои совпадения', summary: 'У тебя есть ожидающие предложения. Свяжись с кем-нибудь!' },
    sr: { title: 'Odgovori na svoja poklapanja', summary: 'Imaš predloge poklapanja na čekanju. Poveži se sa nekim!' },
  },
  engage_meetup: {
    en: { title: 'Attend a meetup', summary: 'Real encounters strengthen the community. Find a meetup near you.' },
    de: { title: 'Nimm an einem Treffen teil', summary: 'Echte Begegnungen stärken die Gemeinschaft. Finde ein Treffen in deiner Nähe.' },
    fr: { title: 'Participe à une rencontre', summary: 'Les vraies rencontres renforcent la communauté. Trouve un événement près de toi.' },
    es: { title: 'Asiste a un encuentro', summary: 'Los encuentros reales fortalecen la comunidad. Encuentra uno cerca de ti.' },
    ar: { title: 'احضر لقاءً', summary: 'اللقاءات الحقيقية تقوّي المجتمع. اعثر على لقاء بالقرب منك.' },
    zh: { title: '参加聚会', summary: '真实的交流加强社区联系。找一个你附近的聚会。' },
    ru: { title: 'Посети встречу', summary: 'Реальные встречи укрепляют сообщество. Найди встречу рядом.' },
    sr: { title: 'Poseti okupljanje', summary: 'Pravi susreti jačaju zajednicu. Pronađi okupljanje u blizini.' },
  },
  engage_health: {
    en: { title: 'Check your health scores', summary: 'Your Vitana Index gives you an overview of your well-being.' },
    de: { title: 'Prüfe deine Gesundheitswerte', summary: 'Dein Vitana-Index gibt dir einen Überblick über dein Wohlbefinden.' },
    fr: { title: 'Vérifie tes scores de santé', summary: 'Ton indice Vitana te donne un aperçu de ton bien-être.' },
    es: { title: 'Revisa tus valores de salud', summary: 'Tu índice Vitana te da una visión general de tu bienestar.' },
    ar: { title: 'تحقق من مؤشرات صحتك', summary: 'مؤشر فيتانا يمنحك نظرة عامة على صحتك.' },
    zh: { title: '查看你的健康分数', summary: '你的Vitana指数让你了解自己的健康状况。' },
    ru: { title: 'Проверь свои показатели здоровья', summary: 'Твой индекс Vitana даёт обзор самочувствия.' },
    sr: { title: 'Proveri svoje zdravstvene rezultate', summary: 'Tvoj Vitana indeks ti daje pregled dobrostanja.' },
  },

  // ── Day 7: Deepening ──────────────────────────────────────────────
  deepen_connection: {
    en: { title: 'Deepen a connection', summary: 'Message one of your connections. Together is better!' },
    de: { title: 'Vertiefe eine Verbindung', summary: 'Schreibe einer deiner Verbindungen eine Nachricht. Gemeinsam geht mehr!' },
    fr: { title: 'Approfondis une connexion', summary: "Envoie un message à une de tes connexions. Ensemble, c'est mieux !" },
    es: { title: 'Profundiza una conexión', summary: 'Envía un mensaje a una de tus conexiones. ¡Juntos es mejor!' },
    ar: { title: 'عمّق اتصالاً', summary: 'أرسل رسالة لأحد اتصالاتك. معاً أفضل!' },
    zh: { title: '深化一个联系', summary: '给你的联系人发条消息。一起更好！' },
    ru: { title: 'Углуби связь', summary: 'Напиши одному из своих контактов. Вместе лучше!' },
    sr: { title: 'Produbi vezu', summary: 'Pošalji poruku jednoj od svojih veza. Zajedno je bolje!' },
  },
  set_goal: {
    en: { title: 'Set a health goal', summary: 'Define a personal goal and let Maxina guide you on the way.' },
    de: { title: 'Setze dir ein Gesundheitsziel', summary: 'Definiere ein persönliches Ziel und lass Maxina dich auf dem Weg begleiten.' },
    fr: { title: 'Fixe un objectif santé', summary: 'Définis un objectif personnel et laisse Maxina te guider.' },
    es: { title: 'Establece un objetivo de salud', summary: 'Define un objetivo personal y deja que Maxina te guíe.' },
    ar: { title: 'حدد هدفاً صحياً', summary: 'حدد هدفاً شخصياً ودع ماكسينا ترشدك في الطريق.' },
    zh: { title: '设定健康目标', summary: '设定一个个人目标，让Maxina在路上指导你。' },
    ru: { title: 'Поставь цель для здоровья', summary: 'Определи личную цель и позволь Максине сопровождать тебя.' },
    sr: { title: 'Postavi zdravstveni cilj', summary: 'Definiši lični cilj i pusti Maxinu da te vodi.' },
  },
  invite_friend: {
    en: { title: 'Invite a friend', summary: 'Share Vitana with someone who could benefit from it.' },
    de: { title: 'Lade einen Freund ein', summary: 'Teile Vitana mit jemandem, der davon profitieren könnte.' },
    fr: { title: 'Invite un ami', summary: "Partage Vitana avec quelqu'un qui pourrait en profiter." },
    es: { title: 'Invita a un amigo', summary: 'Comparte Vitana con alguien que pueda beneficiarse.' },
    ar: { title: 'ادعُ صديقاً', summary: 'شارك فيتانا مع شخص يمكن أن يستفيد منها.' },
    zh: { title: '邀请朋友', summary: '与可能受益的人分享Vitana。' },
    ru: { title: 'Пригласи друга', summary: 'Поделись Vitana с тем, кому это может быть полезно.' },
    sr: { title: 'Pozovi prijatelja', summary: 'Podeli Vitanu sa nekim ko bi mogao da ima koristi.' },
  },

  // ── Day 14 ─────────────────────────────────────────────────────────
  share_expertise: {
    en: { title: 'Share your knowledge', summary: 'You have experience that can help others. Start a discussion in a group.' },
    de: { title: 'Teile dein Wissen', summary: 'Du hast Erfahrung, die anderen helfen kann. Starte eine Diskussion in einer Gruppe.' },
    fr: { title: 'Partage tes connaissances', summary: "Tu as de l'expérience qui peut aider les autres. Lance une discussion dans un groupe." },
    es: { title: 'Comparte tu conocimiento', summary: 'Tienes experiencia que puede ayudar a otros. Inicia una discusión en un grupo.' },
    ar: { title: 'شارك معرفتك', summary: 'لديك خبرة يمكن أن تساعد الآخرين. ابدأ نقاشاً في مجموعة.' },
    zh: { title: '分享你的知识', summary: '你的经验可以帮助其他人。在群组中发起讨论。' },
    ru: { title: 'Поделись знаниями', summary: 'У тебя есть опыт, который может помочь другим. Начни обсуждение в группе.' },
    sr: { title: 'Podeli svoje znanje', summary: 'Imaš iskustvo koje može pomoći drugima. Započni diskusiju u grupi.' },
  },
  start_streak: {
    en: { title: 'Start a wellness streak', summary: 'Consistency brings results. Begin a 7-day challenge!' },
    de: { title: 'Starte eine Wellness-Serie', summary: 'Regelmäßigkeit bringt Ergebnisse. Beginne eine 7-Tage-Challenge!' },
    fr: { title: 'Commence une série bien-être', summary: 'La régularité apporte des résultats. Lance un défi de 7 jours !' },
    es: { title: 'Comienza una racha de bienestar', summary: 'La constancia trae resultados. ¡Empieza un reto de 7 días!' },
    ar: { title: 'ابدأ سلسلة عافية', summary: 'الانتظام يجلب النتائج. ابدأ تحدي ٧ أيام!' },
    zh: { title: '开始健康连续打卡', summary: '坚持带来成果。开始7天挑战！' },
    ru: { title: 'Начни серию для здоровья', summary: 'Регулярность приносит результаты. Начни 7-дневный челлендж!' },
    sr: { title: 'Započni wellness seriju', summary: 'Redovnost donosi rezultate. Započni izazov od 7 dana!' },
  },

  // ── Day 30+ ────────────────────────────────────────────────────────
  mentor_new: {
    en: { title: 'Become a mentor for newcomers', summary: 'Your experience is valuable. Help new members get started.' },
    de: { title: 'Werde Mentor für Neue', summary: 'Deine Erfahrung ist wertvoll. Hilf neuen Mitgliedern beim Einstieg.' },
    fr: { title: 'Deviens mentor pour les nouveaux', summary: 'Ton expérience est précieuse. Aide les nouveaux membres à démarrer.' },
    es: { title: 'Sé mentor para los nuevos', summary: 'Tu experiencia es valiosa. Ayuda a los nuevos miembros a empezar.' },
    ar: { title: 'كن مرشداً للجدد', summary: 'خبرتك قيّمة. ساعد الأعضاء الجدد في البداية.' },
    zh: { title: '成为新成员的导师', summary: '你的经验很宝贵。帮助新成员入门。' },
    ru: { title: 'Стань наставником для новичков', summary: 'Твой опыт ценен. Помоги новым участникам начать.' },
    sr: { title: 'Postani mentor novim članovima', summary: 'Tvoje iskustvo je dragoceno. Pomozi novim članovima da počnu.' },
  },
  organize_meetup: {
    en: { title: 'Organize a meetup', summary: 'Bring your community together. Plan a meetup on a topic you care about.' },
    de: { title: 'Organisiere ein Treffen', summary: 'Bringe deine Community zusammen. Plane ein Treffen zu einem Thema, das dir wichtig ist.' },
    fr: { title: 'Organise une rencontre', summary: 'Rassemble ta communauté. Organise une rencontre sur un sujet qui te tient à cœur.' },
    es: { title: 'Organiza un encuentro', summary: 'Reúne a tu comunidad. Planea un encuentro sobre un tema que te importe.' },
    ar: { title: 'نظّم لقاءً', summary: 'اجمع مجتمعك معاً. خطط للقاء حول موضوع يهمك.' },
    zh: { title: '组织一次聚会', summary: '把你的社区聚在一起。策划一个你关心的话题的聚会。' },
    ru: { title: 'Организуй встречу', summary: 'Собери своё сообщество. Запланируй встречу на важную тему.' },
    sr: { title: 'Organizuj okupljanje', summary: 'Okupi svoju zajednicu. Isplaniraj okupljanje na temu koja ti je važna.' },
  },

  // ── Weakness-driven ────────────────────────────────────────────────
  weakness_movement: {
    en: { title: 'Plan some exercise', summary: 'Your activity score is low. Even a short walk can make a big difference!' },
    de: { title: 'Bewegung einplanen', summary: 'Dein Bewegungswert ist niedrig. Ein kurzer Spaziergang kann schon viel bewirken!' },
    fr: { title: "Prévois de l'exercice", summary: "Ton score d'activité est bas. Même une courte marche peut faire la différence !" },
    es: { title: 'Planifica ejercicio', summary: 'Tu puntuación de actividad es baja. ¡Un paseo corto puede marcar la diferencia!' },
    ar: { title: 'خطط لبعض التمارين', summary: 'مؤشر نشاطك منخفض. حتى المشي القصير يمكن أن يحدث فرقاً كبيراً!' },
    zh: { title: '计划一些运动', summary: '你的活动分数偏低。即使短暂散步也能带来很大改善！' },
    ru: { title: 'Запланируй движение', summary: 'Твой показатель активности низкий. Даже короткая прогулка поможет!' },
    sr: { title: 'Isplaniraj vežbanje', summary: 'Tvoj rezultat aktivnosti je nizak. Čak i kratka šetnja može mnogo pomoći!' },
  },
  weakness_stress: {
    en: { title: '2-minute breathing exercise', summary: 'Your stress level is elevated. Try a short breathing exercise.' },
    de: { title: '2-Minuten Atemübung', summary: 'Dein Stresslevel ist erhöht. Probiere eine kurze Atemübung aus.' },
    fr: { title: 'Exercice de respiration de 2 min', summary: 'Ton niveau de stress est élevé. Essaie un court exercice de respiration.' },
    es: { title: 'Ejercicio de respiración de 2 min', summary: 'Tu nivel de estrés está elevado. Prueba un breve ejercicio de respiración.' },
    ar: { title: 'تمرين تنفس لمدة دقيقتين', summary: 'مستوى التوتر لديك مرتفع. جرب تمرين تنفس قصير.' },
    zh: { title: '2分钟呼吸练习', summary: '你的压力水平偏高。试试短暂的呼吸练习。' },
    ru: { title: '2-минутное дыхательное упражнение', summary: 'Твой уровень стресса повышен. Попробуй короткую дыхательную практику.' },
    sr: { title: 'Vežba disanja od 2 minuta', summary: 'Tvoj nivo stresa je povišen. Probaj kratku vežbu disanja.' },
  },
  weakness_social: {
    en: { title: 'Message a connection', summary: 'Social contacts boost your well-being. Say hello to someone!' },
    de: { title: 'Schreibe einer Verbindung', summary: 'Soziale Kontakte stärken dein Wohlbefinden. Sag jemandem Hallo!' },
    fr: { title: 'Écris à une connexion', summary: "Les contacts sociaux renforcent ton bien-être. Dis bonjour à quelqu'un !" },
    es: { title: 'Escribe a una conexión', summary: 'Los contactos sociales mejoran tu bienestar. ¡Saluda a alguien!' },
    ar: { title: 'أرسل رسالة لأحد معارفك', summary: 'التواصل الاجتماعي يعزز صحتك. قل مرحباً لشخص ما!' },
    zh: { title: '给联系人发消息', summary: '社交联系增进你的幸福感。向某人问好！' },
    ru: { title: 'Напиши кому-нибудь', summary: 'Общение укрепляет самочувствие. Поздоровайся с кем-нибудь!' },
    sr: { title: 'Piši nekoj vezi', summary: 'Socijalni kontakti jačaju tvoje blagostanje. Pozdravi nekoga!' },
  },
  weakness_nutrition: {
    en: { title: 'Track your meals', summary: 'Your nutrition score has potential. Note down what you eat today.' },
    de: { title: 'Mahlzeiten dokumentieren', summary: 'Dein Ernährungswert hat Potenzial. Halte heute fest, was du isst.' },
    fr: { title: 'Note tes repas', summary: "Ton score nutritionnel a du potentiel. Note ce que tu manges aujourd'hui." },
    es: { title: 'Registra tus comidas', summary: 'Tu puntuación nutricional tiene potencial. Anota lo que comes hoy.' },
    ar: { title: 'تتبع وجباتك', summary: 'مؤشر التغذية لديك يمتلك إمكانية. دوّن ما تأكله اليوم.' },
    zh: { title: '记录你的饮食', summary: '你的营养分数还有提升空间。记录今天吃了什么。' },
    ru: { title: 'Запиши приёмы пищи', summary: 'Твой показатель питания имеет потенциал. Запиши, что ешь сегодня.' },
    sr: { title: 'Dokumentuj obroke', summary: 'Tvoj rezultat ishrane ima potencijal. Zabeleži šta jedeš danas.' },
  },
  weakness_sleep: {
    en: { title: 'Set up an evening routine', summary: 'Your sleep quality is declining. A consistent evening routine can help.' },
    de: { title: 'Abendroutine einrichten', summary: 'Deine Schlafqualität sinkt. Eine feste Abendroutine kann helfen.' },
    fr: { title: 'Établis une routine du soir', summary: 'Ta qualité de sommeil diminue. Une routine du soir régulière peut aider.' },
    es: { title: 'Establece una rutina nocturna', summary: 'Tu calidad de sueño está bajando. Una rutina nocturna constante puede ayudar.' },
    ar: { title: 'أنشئ روتيناً مسائياً', summary: 'جودة نومك في انخفاض. روتين مسائي ثابت يمكن أن يساعد.' },
    zh: { title: '建立晚间习惯', summary: '你的睡眠质量在下降。固定的晚间习惯有助于改善。' },
    ru: { title: 'Создай вечерний ритуал', summary: 'Качество сна снижается. Регулярный вечерний ритуал поможет.' },
    sr: { title: 'Uvedi večernju rutinu', summary: 'Kvalitet tvog sna opada. Redovna večernja rutina može pomoći.' },
  },

  // ── Mood-driven ────────────────────────────────────────────────────
  mood_support: {
    en: { title: 'Talk to Maxina', summary: 'You had a tough day. Maxina is here to listen.' },
    de: { title: 'Sprich mit Maxina', summary: 'Du hattest einen schwierigen Tag. Maxina ist da, um dir zuzuhören.' },
    fr: { title: 'Parle à Maxina', summary: "Tu as eu une journée difficile. Maxina est là pour t'écouter." },
    es: { title: 'Habla con Maxina', summary: 'Tuviste un día difícil. Maxina está aquí para escucharte.' },
    ar: { title: 'تحدث مع ماكسينا', summary: 'كان يومك صعباً. ماكسينا هنا لتستمع إليك.' },
    zh: { title: '和Maxina聊聊', summary: '你今天过得不太好。Maxina在这里倾听你。' },
    ru: { title: 'Поговори с Максиной', summary: 'У тебя был трудный день. Максина готова выслушать.' },
    sr: { title: 'Razgovaraj sa Maxinom', summary: 'Imao/la si težak dan. Maxina je tu da te sasluša.' },
  },
  mood_energy: {
    en: { title: 'Use your energy', summary: "You're full of energy! How about a community activity?" },
    de: { title: 'Nutze deine Energie', summary: 'Du bist voller Energie! Wie wäre es mit einer Community-Aktivität?' },
    fr: { title: 'Utilise ton énergie', summary: "Tu es plein d'énergie ! Que dirais-tu d'une activité communautaire ?" },
    es: { title: 'Usa tu energía', summary: '¡Estás lleno de energía! ¿Qué tal una actividad comunitaria?' },
    ar: { title: 'استغل طاقتك', summary: 'أنت مليء بالطاقة! ما رأيك بنشاط مجتمعي؟' },
    zh: { title: '利用你的能量', summary: '你充满活力！来一次社区活动怎么样？' },
    ru: { title: 'Используй свою энергию', summary: 'Ты полон энергии! Как насчёт активности в сообществе?' },
    sr: { title: 'Iskoristi svoju energiju', summary: 'Pun/a si energije! Šta kažeš na aktivnost u zajednici?' },
  },

  // ── Streak (dynamic: {count}) ──────────────────────────────────────
  streak_celebration: {
    en: { title: '{count}-day streak! Keep it up!', summary: "You've been journaling for {count} days. That's amazing!" },
    de: { title: '{count}-Tage-Serie! Weiter so!', summary: 'Du schreibst seit {count} Tagen Tagebuch. Das ist großartig!' },
    fr: { title: 'Série de {count} jours ! Continue !', summary: "Tu tiens ton journal depuis {count} jours. C'est incroyable !" },
    es: { title: '¡Racha de {count} días! ¡Sigue así!', summary: 'Llevas {count} días escribiendo tu diario. ¡Increíble!' },
    ar: { title: 'سلسلة {count} يوم! استمر!', summary: 'لقد كتبت يومياتك لمدة {count} يوماً. هذا رائع!' },
    zh: { title: '{count}天连续打卡！继续加油！', summary: '你已经连续写了{count}天日记。太棒了！' },
    ru: { title: 'Серия {count} дней! Так держать!', summary: 'Ты ведёшь дневник уже {count} дней. Потрясающе!' },
    sr: { title: 'Serija od {count} dana! Nastavi tako!', summary: 'Pišeš dnevnik {count} dana zaredom. Sjajno!' },
  },
  streak_continue: {
    en: { title: '{count}-day streak! Stay with it!', summary: '{count} days in a row. Keep going today!' },
    de: { title: '{count}-Tage-Serie! Bleib dran!', summary: 'Schon {count} Tage in Folge. Mach heute weiter!' },
    fr: { title: 'Série de {count} jours ! Tiens bon !', summary: "{count} jours d'affilée. Continue aujourd'hui !" },
    es: { title: '¡Racha de {count} días! ¡No pares!', summary: '{count} días seguidos. ¡Sigue hoy!' },
    ar: { title: 'سلسلة {count} يوم! لا تتوقف!', summary: '{count} يوماً متتالياً. واصل اليوم!' },
    zh: { title: '{count}天连续！坚持住！', summary: '已经连续{count}天了。今天继续！' },
    ru: { title: 'Серия {count} дней! Не останавливайся!', summary: 'Уже {count} дней подряд. Продолжай сегодня!' },
    sr: { title: 'Serija od {count} dana! Drži se!', summary: '{count} dana zaredom. Nastavi danas!' },
  },
};

/** Resolve translation with optional variable substitution. Fallback: English → key. */
function t(key: string, lang: LangCode, vars?: Record<string, string | number>): { title: string; summary: string } {
  const entry = T[key]?.[lang] ?? T[key]?.['en'] ?? { title: key, summary: '' };
  if (!vars) return { ...entry };
  let { title, summary } = entry;
  for (const [k, v] of Object.entries(vars)) {
    const ph = `{${k}}`;
    title = title.split(ph).join(String(v));
    summary = summary.split(ph).join(String(v));
  }
  return { title, summary };
}

// =============================================================================
// Types
// =============================================================================

export type OnboardingStage = 'day0' | 'day1' | 'day3' | 'day7' | 'day14' | 'day30plus';

export interface CommunityUserSignal {
  title: string;
  summary: string;
  domain: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  impact_score: number;
  effort_score: number;
  time_estimate_seconds: number;
  signal_type: string;
  source_detail: string;
}

export interface UserContext {
  userId: string;
  tenantId: string;
  userName: string | null;
  language: LangCode;
  createdAt: Date;
  onboardingStage: OnboardingStage;
  healthScores: HealthScores | null;
  previousHealthScores: HealthScores | null;
  weaknesses: WeaknessType[];
  diaryMood: string | null;
  diaryEnergy: string | null;
  diaryStreak: number;
  connectionCount: number;
  groupCount: number;
  pendingMatchCount: number;
  memoryGoals: string[];
  memoryInterests: string[];
}

export interface CommunityUserAnalysisResult {
  ok: boolean;
  signals: CommunityUserSignal[];
  user_context: {
    stage: OnboardingStage;
    weaknesses: WeaknessType[];
    diary_mood: string | null;
    connection_count: number;
    diary_streak: number;
    language: LangCode;
  };
  error?: string;
}

// =============================================================================
// Onboarding Stage Detection
// =============================================================================

export function detectOnboardingStage(createdAt: Date): OnboardingStage {
  const daysSinceCreation = Math.floor((Date.now() - createdAt.getTime()) / 86400000);

  if (daysSinceCreation < 1) return 'day0';
  if (daysSinceCreation < 3) return 'day1';
  if (daysSinceCreation < 7) return 'day3';
  if (daysSinceCreation < 14) return 'day7';
  if (daysSinceCreation < 30) return 'day14';
  return 'day30plus';
}

// =============================================================================
// User Context Gathering
// =============================================================================

export async function gatherUserContext(
  userId: string,
  tenantId: string,
  supabase: SupabaseClient
): Promise<UserContext> {
  // Run all queries in parallel
  const [
    healthResult,
    memoryFactsResult,
    diaryResult,
    connectionResult,
    groupResult,
    matchResult,
    userResult,
    diaryStreakResult,
  ] = await Promise.all([
    // Latest 2 health scores for trend
    supabase
      .from('vitana_index_scores')
      .select('score_total, score_physical, score_mental, score_nutritional, score_social, score_environmental')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(2),

    // Memory facts (name, goals, interests, language)
    supabase
      .from('memory_facts')
      .select('fact_key, fact_value')
      .eq('user_id', userId)
      .in('fact_key', ['name', 'display_name', 'goals', 'interests', 'hobbies', 'preferred_language']),

    // Recent diary entries (last 3 days for mood/energy)
    supabase
      .from('memory_items')
      .select('content, tags, metadata')
      .eq('user_id', userId)
      .eq('item_type', 'diary')
      .order('created_at', { ascending: false })
      .limit(3),

    // Connection count
    supabase
      .from('relationship_edges')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('target_type', 'person')
      .eq('relationship_type', 'connected'),

    // Group memberships
    supabase
      .from('relationship_edges')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('target_type', 'group'),

    // Pending matches
    supabase
      .from('matches_daily')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .is('feedback', null),

    // Account info
    supabase
      .from('app_users')
      .select('created_at, display_name')
      .eq('user_id', userId)
      .maybeSingle(),

    // Diary streak (consecutive days with diary entries)
    supabase
      .from('memory_items')
      .select('created_at')
      .eq('user_id', userId)
      .eq('item_type', 'diary')
      .order('created_at', { ascending: false })
      .limit(30),
  ]);

  // Parse health scores
  const healthRows = healthResult.data || [];
  const currentScores: HealthScores | null = healthRows[0] || null;
  const previousScores: HealthScores | null = healthRows[1] || null;

  // Detect weaknesses
  const weaknesses = detectWeaknesses(currentScores, previousScores);

  // Parse memory facts
  const facts = memoryFactsResult.data || [];
  const userName = facts.find((f: any) => f.fact_key === 'display_name' || f.fact_key === 'name')?.fact_value || null;
  const goals = facts.filter((f: any) => f.fact_key === 'goals').map((f: any) => f.fact_value);
  const interests = facts.filter((f: any) => f.fact_key === 'interests' || f.fact_key === 'hobbies').map((f: any) => f.fact_value);
  const langFact = facts.find((f: any) => f.fact_key === 'preferred_language')?.fact_value;
  const language = resolveLanguage(langFact);

  // Parse diary mood/energy from most recent entry
  const diaryEntries = diaryResult.data || [];
  let diaryMood: string | null = null;
  let diaryEnergy: string | null = null;
  if (diaryEntries.length > 0) {
    const latest = diaryEntries[0];
    const meta = latest.metadata as any;
    const tags = latest.tags as string[] || [];
    diaryMood = meta?.mood || tags.find((t: string) => ['happy', 'sad', 'anxious', 'calm', 'stressed', 'energetic', 'tired', 'neutral'].includes(t)) || null;
    diaryEnergy = meta?.energy || tags.find((t: string) => ['high_energy', 'low_energy', 'medium_energy'].includes(t)) || null;
  }

  // Calculate diary streak
  let diaryStreak = 0;
  const streakEntries = diaryStreakResult.data || [];
  if (streakEntries.length > 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let checkDate = new Date(today);

    for (const entry of streakEntries) {
      const entryDate = new Date(entry.created_at);
      entryDate.setHours(0, 0, 0, 0);

      if (entryDate.getTime() === checkDate.getTime()) {
        diaryStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else if (entryDate.getTime() < checkDate.getTime()) {
        // Gap found — check if yesterday
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

  // Parse user info
  const createdAt = userResult.data?.created_at ? new Date(userResult.data.created_at) : new Date();
  const displayName = userResult.data?.display_name || userName;

  return {
    userId,
    tenantId,
    userName: displayName,
    language,
    createdAt,
    onboardingStage: detectOnboardingStage(createdAt),
    healthScores: currentScores,
    previousHealthScores: previousScores,
    weaknesses,
    diaryMood,
    diaryEnergy,
    diaryStreak,
    connectionCount: connectionResult.count || 0,
    groupCount: groupResult.count || 0,
    pendingMatchCount: matchResult.count || 0,
    memoryGoals: goals,
    memoryInterests: interests,
  };
}

// =============================================================================
// Recommendation Templates (key-based, resolved via t())
// =============================================================================

interface RecommendationTemplate {
  key: string;
  domain: string;
  priority: 'low' | 'medium' | 'high';
  impact_score: number;
  effort_score: number;
  time_estimate_seconds: number;
  signal_type: string;
  condition?: (ctx: UserContext) => boolean;
}

const STAGE_TEMPLATES: Record<OnboardingStage, RecommendationTemplate[]> = {
  day0: [
    { key: 'onboarding_profile', domain: 'community', priority: 'high', impact_score: 9, effort_score: 2, time_estimate_seconds: 120, signal_type: 'onboarding_profile' },
    { key: 'onboarding_explore', domain: 'community', priority: 'high', impact_score: 8, effort_score: 1, time_estimate_seconds: 60, signal_type: 'onboarding_explore' },
    { key: 'onboarding_maxina', domain: 'community', priority: 'medium', impact_score: 7, effort_score: 1, time_estimate_seconds: 60, signal_type: 'onboarding_maxina' },
  ],
  day1: [
    { key: 'onboarding_diary', domain: 'health', priority: 'high', impact_score: 8, effort_score: 2, time_estimate_seconds: 120, signal_type: 'onboarding_diary', condition: (ctx) => ctx.diaryStreak === 0 },
    { key: 'onboarding_matches', domain: 'community', priority: 'high', impact_score: 8, effort_score: 1, time_estimate_seconds: 60, signal_type: 'onboarding_matches', condition: (ctx) => ctx.pendingMatchCount > 0 },
    { key: 'onboarding_group', domain: 'community', priority: 'medium', impact_score: 7, effort_score: 2, time_estimate_seconds: 60, signal_type: 'onboarding_group', condition: (ctx) => ctx.groupCount === 0 },
  ],
  day3: [
    { key: 'engage_matches', domain: 'community', priority: 'high', impact_score: 8, effort_score: 1, time_estimate_seconds: 60, signal_type: 'engage_matches', condition: (ctx) => ctx.pendingMatchCount > 0 },
    { key: 'engage_meetup', domain: 'community', priority: 'medium', impact_score: 7, effort_score: 3, time_estimate_seconds: 300, signal_type: 'engage_meetup' },
    { key: 'engage_health', domain: 'health', priority: 'medium', impact_score: 7, effort_score: 1, time_estimate_seconds: 60, signal_type: 'engage_health', condition: (ctx) => ctx.healthScores === null },
  ],
  day7: [
    { key: 'deepen_connection', domain: 'community', priority: 'high', impact_score: 8, effort_score: 2, time_estimate_seconds: 120, signal_type: 'deepen_connection', condition: (ctx) => ctx.connectionCount > 0 },
    { key: 'set_goal', domain: 'health', priority: 'medium', impact_score: 8, effort_score: 2, time_estimate_seconds: 120, signal_type: 'set_goal', condition: (ctx) => ctx.memoryGoals.length === 0 },
    { key: 'invite_friend', domain: 'community', priority: 'low', impact_score: 6, effort_score: 1, time_estimate_seconds: 30, signal_type: 'invite_friend' },
  ],
  day14: [
    { key: 'share_expertise', domain: 'community', priority: 'medium', impact_score: 7, effort_score: 3, time_estimate_seconds: 300, signal_type: 'share_expertise', condition: (ctx) => ctx.groupCount > 0 },
    { key: 'start_streak', domain: 'health', priority: 'high', impact_score: 8, effort_score: 3, time_estimate_seconds: 120, signal_type: 'start_streak', condition: (ctx) => ctx.diaryStreak < 3 },
  ],
  day30plus: [
    { key: 'mentor_new', domain: 'community', priority: 'medium', impact_score: 7, effort_score: 3, time_estimate_seconds: 300, signal_type: 'mentor_new' },
    { key: 'organize_meetup', domain: 'community', priority: 'medium', impact_score: 8, effort_score: 5, time_estimate_seconds: 300, signal_type: 'organize_meetup' },
  ],
};

// =============================================================================
// Weakness-driven Templates
// =============================================================================

const WEAKNESS_TEMPLATES: Record<string, RecommendationTemplate> = {
  movement_low: { key: 'weakness_movement', domain: 'health', priority: 'high', impact_score: 8, effort_score: 2, time_estimate_seconds: 120, signal_type: 'weakness_movement' },
  stress_high: { key: 'weakness_stress', domain: 'health', priority: 'high', impact_score: 8, effort_score: 1, time_estimate_seconds: 120, signal_type: 'weakness_stress' },
  social_low: { key: 'weakness_social', domain: 'community', priority: 'high', impact_score: 7, effort_score: 1, time_estimate_seconds: 60, signal_type: 'weakness_social' },
  nutrition_low: { key: 'weakness_nutrition', domain: 'health', priority: 'medium', impact_score: 6, effort_score: 2, time_estimate_seconds: 120, signal_type: 'weakness_nutrition' },
  sleep_declining: { key: 'weakness_sleep', domain: 'health', priority: 'high', impact_score: 8, effort_score: 2, time_estimate_seconds: 120, signal_type: 'weakness_sleep' },
};

// =============================================================================
// Mood-driven Templates
// =============================================================================

function getMoodTemplates(ctx: UserContext): RecommendationTemplate[] {
  const templates: RecommendationTemplate[] = [];

  if (ctx.diaryMood === 'sad' || ctx.diaryMood === 'anxious' || ctx.diaryMood === 'stressed') {
    templates.push({ key: 'mood_support', domain: 'health', priority: 'high', impact_score: 8, effort_score: 1, time_estimate_seconds: 120, signal_type: 'mood_support' });
  }

  if (ctx.diaryEnergy === 'high_energy' || ctx.diaryMood === 'energetic') {
    templates.push({ key: 'mood_energy', domain: 'community', priority: 'medium', impact_score: 6, effort_score: 2, time_estimate_seconds: 120, signal_type: 'mood_energy' });
  }

  return templates;
}

// =============================================================================
// Streak Celebration Templates
// =============================================================================

function getStreakTemplates(ctx: UserContext): RecommendationTemplate[] {
  const templates: RecommendationTemplate[] = [];

  if (ctx.diaryStreak >= 7) {
    templates.push({ key: 'streak_celebration', domain: 'health', priority: 'low', impact_score: 5, effort_score: 1, time_estimate_seconds: 30, signal_type: 'streak_celebration' });
  } else if (ctx.diaryStreak >= 3) {
    templates.push({ key: 'streak_continue', domain: 'health', priority: 'low', impact_score: 5, effort_score: 1, time_estimate_seconds: 30, signal_type: 'streak_continue' });
  }

  return templates;
}

// =============================================================================
// Fingerprint Generation — language-agnostic
// =============================================================================

export function generateCommunityUserFingerprint(userId: string, signalType: string): string {
  return createHash('sha256')
    .update(`community:${userId}:${signalType}`)
    .digest('hex')
    .slice(0, 16);
}

// =============================================================================
// Main Analyzer
// =============================================================================

export async function analyzeCommunityUser(
  userId: string,
  tenantId: string,
  supabase: SupabaseClient
): Promise<CommunityUserAnalysisResult> {
  try {
    console.log(`${LOG_PREFIX} Analyzing user ${userId.slice(0, 8)}...`);

    const ctx = await gatherUserContext(userId, tenantId, supabase);
    const signals: CommunityUserSignal[] = [];

    // 1. Stage-based templates
    const stageTemplates = STAGE_TEMPLATES[ctx.onboardingStage] || [];
    for (const template of stageTemplates) {
      if (template.condition && !template.condition(ctx)) continue;
      const { title, summary } = t(template.key, ctx.language);
      signals.push({
        title,
        summary,
        domain: template.domain,
        priority: template.priority,
        impact_score: template.impact_score,
        effort_score: template.effort_score,
        time_estimate_seconds: template.time_estimate_seconds,
        signal_type: template.signal_type,
        source_detail: `stage:${ctx.onboardingStage}`,
      });
    }

    // 2. Weakness-driven templates
    for (const weakness of ctx.weaknesses) {
      const template = WEAKNESS_TEMPLATES[weakness];
      if (!template) continue;
      const { title, summary } = t(template.key, ctx.language);
      signals.push({
        title,
        summary,
        domain: template.domain,
        priority: template.priority,
        impact_score: template.impact_score,
        effort_score: template.effort_score,
        time_estimate_seconds: template.time_estimate_seconds,
        signal_type: template.signal_type,
        source_detail: `weakness:${weakness}`,
      });
    }

    // 3. Mood-driven templates
    for (const template of getMoodTemplates(ctx)) {
      const { title, summary } = t(template.key, ctx.language);
      signals.push({
        title,
        summary,
        domain: template.domain,
        priority: template.priority,
        impact_score: template.impact_score,
        effort_score: template.effort_score,
        time_estimate_seconds: template.time_estimate_seconds,
        signal_type: template.signal_type,
        source_detail: `mood:${ctx.diaryMood || 'unknown'}`,
      });
    }

    // 4. Streak templates (with {count} variable)
    for (const template of getStreakTemplates(ctx)) {
      const { title, summary } = t(template.key, ctx.language, { count: ctx.diaryStreak });
      signals.push({
        title,
        summary,
        domain: template.domain,
        priority: template.priority,
        impact_score: template.impact_score,
        effort_score: template.effort_score,
        time_estimate_seconds: template.time_estimate_seconds,
        signal_type: template.signal_type,
        source_detail: `streak:${ctx.diaryStreak}`,
      });
    }

    // Sort by impact descending, take top 8
    signals.sort((a, b) => b.impact_score - a.impact_score);
    const topSignals = signals.slice(0, 8);

    console.log(
      `${LOG_PREFIX} User ${userId.slice(0, 8)}: stage=${ctx.onboardingStage}, ` +
      `lang=${ctx.language}, weaknesses=${ctx.weaknesses.length}, signals=${topSignals.length}`
    );

    return {
      ok: true,
      signals: topSignals,
      user_context: {
        stage: ctx.onboardingStage,
        weaknesses: ctx.weaknesses,
        diary_mood: ctx.diaryMood,
        connection_count: ctx.connectionCount,
        diary_streak: ctx.diaryStreak,
        language: ctx.language,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} Error analyzing user ${userId.slice(0, 8)}:`, msg);
    return { ok: false, signals: [], user_context: { stage: 'day0', weaknesses: [], diary_mood: null, connection_count: 0, diary_streak: 0, language: 'en' }, error: msg };
  }
}
