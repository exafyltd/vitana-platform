/**
 * Curated content pool for the automatic once-a-day "Did You Know" News Feed
 * card (BOOTSTRAP-DAILY-FEATURE-TIP). Consumed by
 * POST /api/v1/scheduled-notifications/daily-feature-tip, which advances
 * through this list in order (tracked per-tenant in did_you_know_state) and
 * wraps around once exhausted — never repeats the same tip two days running.
 *
 * deepLink is a real, existing route (verified against src/App.tsx in
 * vitana-v1) and is PATH-based, not query-string — required so the tip's
 * push notification survives an Appilix Android WebView notification tap
 * (see 20260625000000_post_notification_deeplink.sql in vitana-v1).
 *
 * DE is du-form per platform CLAUDE.md's i18n catalog-quality rule; ES is
 * tú-form and SR is ti-form per the same rule.
 *
 * BOOTSTRAP-SERBIAN-NAV-I18N-ALIGN: this used to carry only { en, de } —
 * every other locale vitana-v1 ships (es/sr/fr/pt/ru/pl/zh/ar) fell all the
 * way through `row.feature_title[language] ?? row.feature_title.en`
 * (useAllNewsFeed.ts) straight to English, so a Serbian user saw an English
 * "Did You Know" card with no error anywhere — the exact "AI/curated content
 * must respect user locale" gap the vitana-v1 CLAUDE.md i18n rule calls out.
 * Now carries every GATEWAY_LOCALES entry. Also fixed 'assistant-voice':
 * the in-app assistant is named Vitana, never Maxina — MAXINA is the app/
 * brand name (see vitana-v1's src/i18n/<locale>/portals.json: "Maxina is
 * part of the VITANA ecosystem"), a distinct thing from the assistant persona,
 * which every other in-app string (e.g. orbHint.json, screens.json
 * "Vitana is speaking...") already calls Vitana.
 */

import type { GatewayLocale } from '../i18n/catalog';

type OtherLocale = Exclude<GatewayLocale, 'en' | 'de'>;

export interface FeatureTip {
  key: string;
  title: { en: string; de: string } & Partial<Record<OtherLocale, string>>;
  description: { en: string; de: string } & Partial<Record<OtherLocale, string>>;
  deepLink: string;
}

export const FEATURE_TIPS: FeatureTip[] = [
  {
    key: 'vitana-index',
    title: {
      en: 'Your Vitana Index',
      de: 'Dein Vitana-Index',
      es: 'Tu Índice Vitana',
      sr: 'Tvoj Vitana indeks',
      fr: 'Ton Indice Vitana',
      pt: 'Seu Índice Vitana',
      ru: 'Твой индекс Vitana',
      pl: 'Twój Indeks Vitana',
      zh: '你的 Vitana 指数',
      ar: 'مؤشر Vitana الخاص بك',
      tr: 'Vitana Endeksin',
    },
    description: {
      en: 'Your Vitana Index turns your health data into one clear number, updated daily — check it anytime to see where you stand.',
      de: 'Dein Vitana-Index fasst deine Gesundheitsdaten in einer klaren Zahl zusammen, täglich aktualisiert — schau jederzeit rein, um zu sehen, wo du stehst.',
      es: 'Tu Índice Vitana convierte tus datos de salud en un número claro, actualizado a diario — revísalo cuando quieras para ver cómo estás.',
      sr: 'Tvoj Vitana indeks pretvara tvoje zdravstvene podatke u jedan jasan broj, koji se ažurira svakog dana — proveri ga kad god želiš da vidiš gde si.',
      fr: 'Ton Indice Vitana transforme tes données de santé en un chiffre clair, mis à jour chaque jour — consulte-le à tout moment pour savoir où tu en es.',
      pt: 'Seu Índice Vitana transforma seus dados de saúde em um número claro, atualizado todos os dias — confira quando quiser para ver como você está.',
      ru: 'Твой индекс Vitana превращает данные о здоровье в одно понятное число, которое обновляется каждый день — загляни в любой момент, чтобы узнать, как у тебя дела.',
      pl: 'Twój Indeks Vitana zamienia Twoje dane zdrowotne w jedną jasną liczbę, aktualizowaną codziennie — sprawdzaj go, kiedy chcesz, żeby zobaczyć, na czym stoisz.',
      zh: 'Vitana 指数把你的健康数据转化成一个清晰的数字，每天更新——随时查看，了解自己的状态。',
      ar: 'يحوّل مؤشر Vitana بياناتك الصحية إلى رقم واحد واضح، يتم تحديثه يوميًا — تفقّده في أي وقت لتعرف أين أنت.',
      tr: 'Vitana Endeksin, sağlık verilerini her gün güncellenen tek ve net bir sayıya dönüştürür — durumunu görmek için istediğin zaman kontrol et.',
    },
    deepLink: '/health/vitana-index',
  },
  {
    key: 'autopilot',
    title: {
      en: 'Autopilot',
      de: 'Autopilot',
      es: 'Autopilot',
      sr: 'Autopilot',
      fr: 'Autopilot',
      pt: 'Autopilot',
      ru: 'Автопилот',
      pl: 'Autopilot',
      zh: 'Autopilot',
      ar: 'Autopilot',
      tr: 'Autopilot',
    },
    description: {
      en: 'Autopilot surfaces small, personalized actions based on your goals and habits — so you always know what to do next.',
      de: 'Autopilot zeigt dir kleine, persönliche Schritte passend zu deinen Zielen und Gewohnheiten — so weißt du immer, was als Nächstes dran ist.',
      es: 'Autopilot te muestra pequeñas acciones personalizadas según tus metas y hábitos — para que siempre sepas qué hacer a continuación.',
      sr: 'Autopilot ti predlaže male, personalizovane korake na osnovu tvojih ciljeva i navika — tako uvek znaš šta je sledeće na redu.',
      fr: 'Autopilot te propose de petites actions personnalisées selon tes objectifs et tes habitudes — pour que tu saches toujours quoi faire ensuite.',
      pt: 'O Autopilot mostra pequenas ações personalizadas com base nas suas metas e hábitos — assim você sempre sabe qual é o próximo passo.',
      ru: 'Автопилот подсказывает небольшие персональные шаги на основе твоих целей и привычек — так ты всегда знаешь, что делать дальше.',
      pl: 'Autopilot podsuwa Ci małe, spersonalizowane działania dopasowane do Twoich celów i nawyków — dzięki temu zawsze wiesz, co dalej.',
      zh: 'Autopilot 会根据你的目标和习惯，主动为你推送个性化的小行动建议——让你随时知道下一步该做什么。',
      ar: 'يقترح لك Autopilot خطوات صغيرة ومخصصة بناءً على أهدافك وعاداتك — لتعرف دائمًا ما هي خطوتك التالية.',
      tr: 'Autopilot, hedeflerine ve alışkanlıklarına göre küçük, kişiselleştirilmiş adımlar önerir — böylece sırada ne olduğunu her zaman bilirsin.',
    },
    deepLink: '/autopilot',
  },
  {
    key: 'live-rooms',
    title: {
      en: 'Live Rooms',
      de: 'Live-Räume',
      es: 'Salas en Vivo',
      sr: 'Uživo sobe',
      fr: 'Salons en direct',
      pt: 'Salas ao Vivo',
      ru: 'Прямые эфиры',
      pl: 'Pokoje na żywo',
      zh: '直播间',
      ar: 'غرف مباشرة',
      tr: 'Canlı Odalar',
    },
    description: {
      en: 'Live Rooms let you join real-time voice conversations with other members — drop in whenever one is happening.',
      de: 'In Live-Räumen kannst du in Echtzeit mit anderen Mitgliedern sprechen — steig einfach ein, wenn gerade einer läuft.',
      es: 'Las Salas en Vivo te permiten unirte a conversaciones de voz en tiempo real con otros miembros — entra cuando quieras, en cualquier momento.',
      sr: 'Uživo sobe ti omogućavaju da se pridružiš razgovorima uživo sa drugim članovima — uđi kad god je neka soba aktivna.',
      fr: 'Les Salons en direct te permettent de rejoindre des conversations vocales en temps réel avec d’autres membres — entre dès qu’un salon est ouvert.',
      pt: 'As Salas ao Vivo permitem participar de conversas por voz em tempo real com outros membros — entre sempre que houver uma acontecendo.',
      ru: 'Прямые эфиры позволяют присоединиться к голосовым беседам с другими участниками в реальном времени — заходи, когда идёт эфир.',
      pl: 'Pokoje na żywo pozwalają dołączyć do rozmów głosowych z innymi członkami w czasie rzeczywistym — wejdź, kiedy tylko któryś trwa.',
      zh: '直播间让你可以和其他成员进行实时语音交流——只要有人在线，随时都能加入。',
      ar: 'تتيح لك الغرف المباشرة الانضمام إلى محادثات صوتية مباشرة مع أعضاء آخرين — ادخل في أي وقت تكون فيه إحدى الغرف نشطة.',
      tr: 'Canlı Odalar sayesinde diğer üyelerle gerçek zamanlı sesli sohbetlere katılabilirsin — bir oda aktifken istediğin an gir.',
    },
    deepLink: '/comm/live-rooms',
  },
  {
    key: 'meetups',
    title: {
      en: 'Events & Meetups',
      de: 'Events & Treffen',
      es: 'Eventos y Encuentros',
      sr: 'Događaji i sastanci',
      fr: 'Événements & Rencontres',
      pt: 'Eventos & Encontros',
      ru: 'События и встречи',
      pl: 'Wydarzenia i Spotkania',
      zh: '活动和聚会',
      ar: 'فعاليات ولقاءات',
      tr: 'Etkinlikler ve Buluşmalar',
    },
    description: {
      en: 'Browse upcoming community events and meetups, and RSVP right from the app to save your spot.',
      de: 'Entdecke kommende Community-Events und Treffen und sag direkt in der App zu, um dir deinen Platz zu sichern.',
      es: 'Explora los próximos eventos y encuentros de la comunidad, y confirma tu asistencia directamente desde la app para reservar tu lugar.',
      sr: 'Pregledaj predstojeće događaje i sastanke zajednice i prijavi se direktno iz aplikacije da bi sebi obezbedio/la mesto.',
      fr: 'Parcours les prochains événements et rencontres de la communauté, et inscris-toi directement depuis l’appli pour réserver ta place.',
      pt: 'Veja os próximos eventos e encontros da comunidade e confirme presença direto pelo app para garantir sua vaga.',
      ru: 'Смотри ближайшие события и встречи сообщества и записывайся прямо в приложении, чтобы забронировать своё место.',
      pl: 'Przeglądaj nadchodzące wydarzenia i spotkania społeczności i zapisuj się prosto z aplikacji, żeby zarezerwować sobie miejsce.',
      zh: '浏览社区即将举行的活动和聚会，直接在应用内报名，锁定你的名额。',
      ar: 'تصفّح فعاليات ولقاءات المجتمع القادمة، واحجز مكانك مباشرة من التطبيق.',
      tr: 'Yaklaşan topluluk etkinliklerine ve buluşmalara göz at, yerini ayırtmak için doğrudan uygulama üzerinden katıl.',
    },
    deepLink: '/comm/events-meetups',
  },
  {
    key: 'daily-diary',
    title: {
      en: 'Daily Diary',
      de: 'Tägliches Tagebuch',
      es: 'Diario',
      sr: 'Dnevnik',
      fr: 'Journal quotidien',
      pt: 'Diário do Dia',
      ru: 'Ежедневный дневник',
      pl: 'Codzienny dziennik',
      zh: '每日日记',
      ar: 'يوميات',
      tr: 'Günlük',
    },
    description: {
      en: 'A quick daily diary entry helps track your mood and progress over time — it only takes a minute.',
      de: 'Ein kurzer Tagebucheintrag pro Tag hilft dir, deine Stimmung und Fortschritte im Blick zu behalten — dauert nur eine Minute.',
      es: 'Un breve registro diario te ayuda a seguir tu estado de ánimo y tu progreso con el tiempo — solo toma un minuto.',
      sr: 'Kratak dnevni unos pomaže ti da pratiš svoje raspoloženje i napredak tokom vremena — traje samo minut.',
      fr: 'Une courte entrée de journal chaque jour t’aide à suivre ton humeur et tes progrès dans le temps — ça ne prend qu’une minute.',
      pt: 'Um registro diário rápido ajuda a acompanhar seu humor e progresso ao longo do tempo — leva só um minuto.',
      ru: 'Короткая ежедневная запись помогает отслеживать настроение и прогресс со временем — это займёт всего минуту.',
      pl: 'Krótki codzienny wpis pomaga śledzić Twój nastrój i postępy w czasie — zajmuje tylko minutę.',
      zh: '每天简单记一笔日记，帮你追踪心情和进展变化——只需要一分钟。',
      ar: 'يساعدك تدوين ملاحظة يومية سريعة على متابعة مزاجك وتقدّمك بمرور الوقت — لا يستغرق سوى دقيقة.',
      tr: 'Kısa bir günlük kaydı, ruh halini ve ilerlemeni zaman içinde takip etmene yardımcı olur — sadece bir dakikanı alır.',
    },
    deepLink: '/daily-diary',
  },
  {
    key: 'matches',
    title: {
      en: 'Your Matches',
      de: 'Deine Matches',
      es: 'Tus Matches',
      sr: 'Tvoja poklapanja',
      fr: 'Tes Matchs',
      pt: 'Seus Matches',
      ru: 'Твои совпадения',
      pl: 'Twoje Dopasowania',
      zh: '你的匹配',
      ar: 'توافقاتك',
      tr: 'Eşleşmelerin',
    },
    description: {
      en: 'MAXINA suggests other members who share your goals and interests — check your matches to find your people.',
      de: 'MAXINA schlägt dir andere Mitglieder mit ähnlichen Zielen und Interessen vor — schau bei deinen Matches vorbei.',
      es: 'MAXINA te sugiere otros miembros que comparten tus metas e intereses — revisa tus matches para encontrar a tu gente.',
      sr: 'MAXINA ti predlaže druge članove sa sličnim ciljevima i interesovanjima — pogledaj svoja poklapanja i pronađi svoje ljude.',
      fr: 'MAXINA te suggère d’autres membres qui partagent tes objectifs et centres d’intérêt — découvre tes matchs pour trouver les tiens.',
      pt: 'A MAXINA sugere outros membros que compartilham suas metas e interesses — confira seus matches para encontrar sua turma.',
      ru: 'MAXINA подбирает участников с похожими целями и интересами — загляни в раздел совпадений, чтобы найти своих людей.',
      pl: 'MAXINA podpowiada innych członków, którzy mają podobne cele i zainteresowania — sprawdź swoje dopasowania, żeby znaleźć swoich ludzi.',
      zh: 'MAXINA 会为你推荐目标和兴趣相近的其他成员——去看看你的匹配对象，找到属于你的圈子。',
      ar: 'يقترح عليك MAXINA أعضاء آخرين يشاركونك أهدافك واهتماماتك — تفقّد توافقاتك لتجد أشخاصًا مثلك.',
      tr: 'MAXINA, hedeflerini ve ilgi alanlarını paylaşan diğer üyeleri sana önerir — kendi insanlarını bulmak için eşleşmelerine göz at.',
    },
    deepLink: '/me/matches',
  },
  {
    key: 'find-partner',
    title: {
      en: 'Find a Partner',
      de: 'Partner finden',
      es: 'Encuentra un Compañero',
      sr: 'Pronađi partnera',
      fr: 'Trouve un Partenaire',
      pt: 'Encontre um Parceiro',
      ru: 'Найти напарника',
      pl: 'Znajdź Partnera',
      zh: '寻找伙伴',
      ar: 'ابحث عن شريك',
      tr: 'Partner Bul',
    },
    description: {
      en: 'Looking for someone to team up with on a specific goal? Find a Partner connects you with members looking for the same thing.',
      de: 'Suchst du jemanden für ein bestimmtes Ziel? Mit Partner finden triffst du Mitglieder mit demselben Vorhaben.',
      es: '¿Buscas a alguien con quien avanzar hacia una meta concreta? Encuentra un Compañero te conecta con miembros que buscan lo mismo.',
      sr: 'Tražiš nekoga sa kim ćeš raditi na određenom cilju? Pronađi partnera te povezuje sa članovima koji traže isto.',
      fr: 'Tu cherches quelqu’un pour t’accompagner vers un objectif précis ? Trouve un Partenaire te met en relation avec des membres qui cherchent la même chose.',
      pt: 'Procurando alguém para se unir em um objetivo específico? Encontre um Parceiro te conecta com membros que buscam a mesma coisa.',
      ru: 'Ищешь того, с кем можно объединиться ради конкретной цели? «Найти напарника» связывает тебя с участниками, которые ищут то же самое.',
      pl: 'Szukasz kogoś, z kim wspólnie zrealizujesz konkretny cel? Znajdź Partnera łączy Cię z osobami, które szukają tego samego.',
      zh: '想找人一起完成某个目标？寻找伙伴功能能帮你匹配到目标相同的成员。',
      ar: 'تبحث عن شخص لينضم إليك في تحقيق هدف معيّن؟ ميزة ابحث عن شريك تربطك بأعضاء يبحثون عن الشيء نفسه.',
      tr: 'Belirli bir hedef için birlikte çalışacağın birini mi arıyorsun? Partner Bul, aynı şeyi arayan üyelerle seni buluşturur.',
    },
    deepLink: '/comm/find-partner',
  },
  {
    key: 'my-business',
    title: {
      en: 'My Business',
      de: 'Mein Business',
      es: 'Mi Negocio',
      sr: 'Moj biznis',
      fr: 'Mon Business',
      pt: 'Meu Negócio',
      ru: 'Мой бизнес',
      pl: 'Mój Biznes',
      zh: '我的生意',
      ar: 'عملي',
      tr: 'İşim',
    },
    description: {
      en: 'Recommend products and services you love through My Business, and earn when others buy through your link.',
      de: 'Empfiehl Produkte und Dienstleistungen, die du liebst, über Mein Business — und verdiene mit, wenn andere über deinen Link kaufen.',
      es: 'Recomienda productos y servicios que te encantan a través de Mi Negocio, y gana cuando otros compren usando tu enlace.',
      sr: 'Preporuči proizvode i usluge koje voliš kroz Moj biznis i zaradi kad drugi kupe preko tvog linka.',
      fr: 'Recommande les produits et services que tu adores via Mon Business, et gagne de l’argent quand d’autres achètent grâce à ton lien.',
      pt: 'Recomende produtos e serviços que você ama através do Meu Negócio, e ganhe quando outras pessoas comprarem pelo seu link.',
      ru: 'Рекомендуй продукты и услуги, которые тебе нравятся, через «Мой бизнес» — и зарабатывай, когда кто-то покупает по твоей ссылке.',
      pl: 'Polecaj produkty i usługi, które kochasz, przez Mój Biznes i zarabiaj, gdy inni kupują przez Twój link.',
      zh: '通过「我的生意」推荐你喜欢的产品和服务，别人通过你的链接购买时你就能赚取收益。',
      ar: 'أوصِ بالمنتجات والخدمات التي تحبها عبر عملي، واربح عندما يشتري الآخرون من خلال رابطك.',
      tr: 'Sevdiğin ürün ve hizmetleri İşim üzerinden öner, başkaları senin linkin üzerinden satın aldığında kazan.',
    },
    deepLink: '/business',
  },
  {
    key: 'memory-timeline',
    title: {
      en: 'Your Memory Timeline',
      de: 'Deine Erinnerungs-Zeitleiste',
      es: 'Tu Línea de Recuerdos',
      sr: 'Tvoja vremenska linija sećanja',
      fr: 'Ta Chronologie de Souvenirs',
      pt: 'Sua Linha do Tempo de Memórias',
      ru: 'Твоя лента воспоминаний',
      pl: 'Twoja Oś Wspomnień',
      zh: '你的回忆时间线',
      ar: 'خط ذكرياتك الزمني',
      tr: 'Anı Zaman Çizelgen',
    },
    description: {
      en: 'MAXINA remembers what you share over time — your Memory Timeline lets you look back on your own journey.',
      de: 'MAXINA merkt sich, was du im Laufe der Zeit teilst — in deiner Erinnerungs-Zeitleiste kannst du auf deine eigene Reise zurückblicken.',
      es: 'MAXINA recuerda lo que compartes con el tiempo — tu Línea de Recuerdos te permite mirar atrás en tu propio camino.',
      sr: 'MAXINA pamti sve što deliš tokom vremena — tvoja vremenska linija sećanja ti omogućava da se osvrneš na sopstveni put.',
      fr: 'MAXINA se souvient de ce que tu partages au fil du temps — ta Chronologie de Souvenirs te permet de revenir sur ton propre parcours.',
      pt: 'A MAXINA lembra o que você compartilha ao longo do tempo — sua Linha do Tempo de Memórias permite olhar para trás na sua própria jornada.',
      ru: 'MAXINA запоминает то, чем ты делишься со временем — лента воспоминаний позволяет оглянуться на собственный путь.',
      pl: 'MAXINA zapamiętuje to, czym się dzielisz z czasem — Twoja Oś Wspomnień pozwala spojrzeć wstecz na własną podróż.',
      zh: 'MAXINA 会记住你分享过的点滴——你的回忆时间线让你随时回顾自己的成长历程。',
      ar: 'يتذكّر MAXINA ما تشاركه بمرور الوقت — يتيح لك خط ذكرياتك الزمني النظر إلى رحلتك الخاصة.',
      tr: 'MAXINA zaman içinde paylaştıklarını hatırlar — Anı Zaman Çizelgen, kendi yolculuğuna geri bakmanı sağlar.',
    },
    deepLink: '/memory/timeline',
  },
  {
    key: 'assistant-voice',
    // BOOTSTRAP-SERBIAN-NAV-I18N-ALIGN: was "Talk to Maxina" — wrong. The
    // in-app assistant persona is named Vitana everywhere else in the app
    // (orbHint.json "Tap here to talk to Vitana", screens.json "Vitana is
    // speaking..."); MAXINA is only the app/brand name, a separate thing.
    title: {
      en: 'Talk to Vitana',
      de: 'Sprich mit Vitana',
      es: 'Habla con Vitana',
      sr: 'Pričaj sa Vitanom',
      fr: 'Parle à Vitana',
      pt: 'Fale com a Vitana',
      ru: 'Поговори с Vitana',
      pl: 'Porozmawiaj z Vitaną',
      zh: '和 Vitana 说话',
      ar: 'تحدث مع Vitana',
      tr: 'Vitana ile Konuş',
    },
    description: {
      en: 'You can talk to Vitana with your voice, not just text — open the assistant and just start speaking.',
      de: 'Du kannst mit Vitana auch per Sprache reden, nicht nur per Text — öffne den Assistenten und sprich einfach los.',
      es: 'Puedes hablar con Vitana con tu voz, no solo por texto — abre el asistente y empieza a hablar.',
      sr: 'Sa Vitanom možeš da pričaš i glasom, ne samo tekstom — otvori asistenta i samo počni da pričaš.',
      fr: 'Tu peux parler à Vitana avec ta voix, pas seulement par texte — ouvre l’assistant et commence à parler.',
      pt: 'Você pode falar com a Vitana pela voz, não só por texto — abra o assistente e comece a falar.',
      ru: 'С Vitana можно говорить голосом, а не только печатать — открой ассистента и просто начни говорить.',
      pl: 'Możesz rozmawiać z Vitaną głosem, nie tylko tekstem — otwórz asystenta i po prostu zacznij mówić.',
      zh: '你可以用语音和 Vitana 交流，不只是打字——打开助手，直接开口说话就行。',
      ar: 'يمكنك التحدث مع Vitana بصوتك، وليس فقط عبر الكتابة — افتح المساعد وابدأ الحديث مباشرة.',
      tr: 'Vitana ile sadece yazarak değil, sesinle de konuşabilirsin — asistanı aç ve konuşmaya başla, yeter.',
    },
    deepLink: '/assistant',
  },
  {
    key: 'discover',
    title: {
      en: 'Discover',
      de: 'Entdecken',
      es: 'Descubre',
      sr: 'Otkrij',
      fr: 'Découvrir',
      pt: 'Descobrir',
      ru: 'Открой',
      pl: 'Odkryj',
      zh: '发现',
      ar: 'اكتشف',
      tr: 'Keşfet',
    },
    description: {
      en: 'Discover curates supplements, services, and offers picked for longevity — a good place to browse when you need something new.',
      de: 'Entdecken zeigt dir ausgewählte Nahrungsergänzungsmittel, Dienstleistungen und Angebote rund um Longevity — ideal, wenn du mal etwas Neues suchst.',
      es: 'Descubre selecciona suplementos, servicios y ofertas pensados para la longevidad — un buen lugar para explorar cuando busques algo nuevo.',
      sr: 'Otkrij ti nudi pažljivo izabrane suplemente, usluge i ponude za dugovečnost — pravo mesto za pretragu kad tražiš nešto novo.',
      fr: 'Découvrir sélectionne des compléments, services et offres pensés pour la longévité — un bon endroit à explorer quand tu cherches quelque chose de nouveau.',
      pt: 'O Descobrir seleciona suplementos, serviços e ofertas voltados para longevidade — um ótimo lugar para explorar quando você quiser algo novo.',
      ru: 'Раздел «Открой» собирает добавки, услуги и предложения для долголетия — загляни сюда, когда захочешь чего-то нового.',
      pl: 'Odkryj to starannie wybrane suplementy, usługi i oferty związane z długowiecznością — dobre miejsce, gdy szukasz czegoś nowego.',
      zh: '发现精选了为长寿打造的营养补充剂、服务和优惠——想找点新东西时来这里逛逛。',
      ar: 'يقدّم لك اكتشف مكملات وخدمات وعروضًا مختارة لدعم طول العمر — مكان رائع للتصفح كلما احتجت لشيء جديد.',
      tr: 'Keşfet, uzun ömür için seçilmiş takviyeleri, hizmetleri ve fırsatları bir araya getirir — yeni bir şeye ihtiyacın olduğunda göz atmak için iyi bir yer.',
    },
    deepLink: '/discover',
  },
  {
    key: 'wallet',
    title: {
      en: 'Your Wallet',
      de: 'Deine Wallet',
      es: 'Tu Billetera',
      sr: 'Tvoj novčanik',
      fr: 'Ton Portefeuille',
      pt: 'Sua Carteira',
      ru: 'Твой кошелёк',
      pl: 'Twój Portfel',
      zh: '你的钱包',
      ar: 'محفظتك',
      tr: 'Cüzdanın',
    },
    description: {
      en: 'Your Wallet tracks credits, rewards, and payouts in one place — check it to see what you have earned.',
      de: 'Deine Wallet zeigt Guthaben, Prämien und Auszahlungen an einem Ort — schau nach, was du schon verdient hast.',
      es: 'Tu Billetera reúne créditos, recompensas y pagos en un solo lugar — revísala para ver lo que has ganado.',
      sr: 'Tvoj novčanik prati kredite, nagrade i isplate na jednom mestu — proveri ga da vidiš šta si već zaradio/la.',
      fr: 'Ton Portefeuille regroupe crédits, récompenses et paiements au même endroit — consulte-le pour voir ce que tu as gagné.',
      pt: 'Sua Carteira reúne créditos, recompensas e pagamentos em um só lugar — confira para ver o que você já ganhou.',
      ru: 'Твой кошелёк собирает баллы, награды и выплаты в одном месте — загляни, чтобы увидеть, что ты уже заработал.',
      pl: 'Twój Portfel gromadzi kredyty, nagrody i wypłaty w jednym miejscu — sprawdź, co już zarobiłeś/aś.',
      zh: '你的钱包集中显示积分、奖励和收益——随时查看你已经赚到了多少。',
      ar: 'تجمع محفظتك الأرصدة والمكافآت والمدفوعات في مكان واحد — تفقّدها لترى ما حققته حتى الآن.',
      tr: 'Cüzdanın; kredilerini, ödüllerini ve ödemelerini tek bir yerde takip eder — ne kazandığını görmek için kontrol et.',
    },
    deepLink: '/wallet',
  },
];
