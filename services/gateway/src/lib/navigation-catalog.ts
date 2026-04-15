/**
 * Vitana Navigator — Navigation Catalog
 *
 * Hand-curated map of navigable destinations Vitana can guide users to.
 * Multilingual: each entry stores localized title/description/when_to_visit
 * keyed by ISO-639-1 code. English (`en`) is the only required language;
 * other languages are optional and fall back to English via `getContent`.
 *
 * Adding a new language is a pure content task — drop translations into the
 * `i18n` map of an entry, no engineering changes needed.
 */

export type LangCode = string;

export interface NavCatalogContent {
  title: string;
  description: string;
  when_to_visit: string;
}

export type NavCategory =
  | 'public'
  | 'auth'
  | 'community'
  | 'business'
  | 'wallet'
  | 'health'
  | 'discover'
  | 'home'
  | 'memory'
  | 'ai'
  | 'inbox'
  | 'settings'
  | 'sharing';

export interface NavCatalogEntry {
  screen_id: string;
  route: string;
  category: NavCategory;
  access: 'public' | 'authenticated';
  anonymous_safe: boolean;
  i18n: Record<LangCode, NavCatalogContent>;
  related_kb_topics?: string[];
  priority?: number;
  /** VTID-NAV-SEMANTIC: Pre-computed embedding vector for semantic search.
   *  Generated at gateway startup from combined EN+DE title+description+when_to_visit. */
  embedding?: number[];
}

// =============================================================================
// Semantic search state
// =============================================================================

let _embeddingsReady = false;

/** True once all catalog entries have pre-computed embeddings. */
export function areCatalogEmbeddingsReady(): boolean {
  return _embeddingsReady;
}

/**
 * VTID-NAV-SEMANTIC: Pre-compute embedding vectors for every catalog entry.
 * Called once at gateway startup. Each entry's embedding is generated from
 * its combined multilingual content (title + description + when_to_visit
 * across all available languages). Uses the batch embedding API for speed.
 *
 * Non-blocking, non-fatal: if it fails, the keyword scorer is the fallback.
 */
export async function warmCatalogEmbeddings(): Promise<void> {
  try {
    const { generateBatchEmbeddings } = await import('../services/embedding-service');

    // Build a text block per entry combining all languages
    const texts: string[] = [];
    for (const entry of NAVIGATION_CATALOG) {
      const parts: string[] = [];
      for (const [, content] of Object.entries(entry.i18n)) {
        parts.push(content.title, content.description, content.when_to_visit);
      }
      texts.push(parts.join(' '));
    }

    const result = await generateBatchEmbeddings(texts);
    if (!result.ok || !result.embeddings || result.embeddings.length !== NAVIGATION_CATALOG.length) {
      console.warn(`[VTID-NAV-SEMANTIC] warmCatalogEmbeddings failed: ${result.error || 'length mismatch'}`);
      return;
    }

    // Assign embeddings to each entry (mutating the readonly array entries is
    // safe here because we only write the embedding field, not structural data)
    for (let i = 0; i < NAVIGATION_CATALOG.length; i++) {
      (NAVIGATION_CATALOG[i] as any).embedding = result.embeddings[i];
    }

    _embeddingsReady = true;
    console.log(`[VTID-NAV-SEMANTIC] ${NAVIGATION_CATALOG.length} catalog embeddings warmed in ${result.latency_ms}ms`);
  } catch (err: any) {
    console.warn(`[VTID-NAV-SEMANTIC] warmCatalogEmbeddings exception: ${err.message}`);
  }
}

/**
 * VTID-NAV-SEMANTIC: Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * VTID-NAV-SEMANTIC: Semantic search against pre-computed catalog embeddings.
 * Returns entries ranked by cosine similarity with hierarchy-aware boosts.
 *
 * Returns empty array if embeddings aren't ready (falls back to keyword scorer).
 */
export async function semanticSearchCatalog(
  query: string,
  opts: {
    anonymous_only?: boolean;
    exclude_routes?: string[];
  } = {}
): Promise<Array<{ entry: NavCatalogEntry; similarity: number }>> {
  if (!_embeddingsReady) return [];

  try {
    const { generateEmbedding } = await import('../services/embedding-service');
    const embResult = await generateEmbedding(query);
    if (!embResult.ok || !embResult.embedding) return [];

    const queryEmb = embResult.embedding;
    const excluded = new Set(opts.exclude_routes || []);
    const results: Array<{ entry: NavCatalogEntry; similarity: number }> = [];

    for (const entry of NAVIGATION_CATALOG) {
      if (!entry.embedding) continue;
      if (opts.anonymous_only && !entry.anonymous_safe) continue;
      if (excluded.has(entry.route)) continue;

      let sim = cosineSimilarity(queryEmb, entry.embedding);

      // Hierarchy rule 1: Parent boost. Overview/root entries get a bonus
      // so generic queries ("Chat", "Gesundheit") land on the parent, not
      // a random child page.
      const isParent = entry.screen_id.endsWith('.OVERVIEW')
        || entry.screen_id === 'PUBLIC.LANDING'
        || entry.screen_id === 'PROFILE.ME'
        || entry.route.split('/').filter(Boolean).length <= 1;
      if (isParent) {
        sim += 0.05;
      }

      results.push({ entry, similarity: sim });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results;
  } catch (err: any) {
    console.warn(`[VTID-NAV-SEMANTIC] semanticSearchCatalog failed: ${err.message}`);
    return [];
  }
}

const FALLBACK_LANG: LangCode = 'en';

/**
 * Multilingual stopword set for query tokenization. Common pronouns, articles,
 * modal verbs, and filler words that would otherwise pollute scoring by
 * matching across many catalog entries (e.g. German "möchte" appearing in
 * almost every when_to_visit hint).
 *
 * Conservative list — only words that have NO discriminating value.
 */
const STOPWORDS = new Set<string>([
  // English
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'these', 'those',
  'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'having',
  'will', 'would', 'should', 'could', 'shall', 'may', 'might', 'must',
  'can', 'cant', 'dont', 'doesnt', 'didnt', 'wont',
  'who', 'what', 'when', 'where', 'why', 'how', 'which',
  'you', 'your', 'yours', 'mine', 'our', 'ours', 'their', 'theirs',
  'him', 'her', 'his', 'hers', 'its',
  'all', 'any', 'some', 'one', 'two', 'too', 'also', 'just', 'only',
  'now', 'then', 'than', 'there', 'here', 'about', 'over', 'under',
  'want', 'wants', 'wanted', 'need', 'needs', 'needed', 'like', 'likes', 'liked',
  'get', 'got', 'getting', 'take', 'taken', 'taking',
  'show', 'shows', 'showed', 'open', 'opens', 'opened', 'close', 'closed', 'go', 'goes', 'going', 'went',
  // German navigation verbs
  'öffne', 'öffnen', 'öffnet', 'schließen', 'schließe',
  // German
  'ich', 'mich', 'mir', 'mein', 'meine', 'meinen', 'meinem', 'meiner', 'meines',
  'du', 'dich', 'dir', 'dein', 'deine', 'deinen',
  'er', 'sie', 'es', 'ihn', 'ihm', 'ihr', 'ihre', 'ihren',
  'wir', 'uns', 'unser', 'unsere',
  'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'und', 'oder', 'aber', 'doch', 'denn', 'weil', 'wenn', 'als', 'ob',
  'ist', 'sind', 'war', 'waren', 'wird', 'werden', 'wurde', 'wurden',
  'habe', 'hat', 'hatte', 'hatten', 'haben',
  'kann', 'können', 'könnte', 'soll', 'sollte', 'müsste', 'müssen', 'darf',
  'will', 'wollen', 'wollte', 'mag', 'möchte', 'möchten',
  'wie', 'was', 'wer', 'wo', 'wann', 'warum', 'welche', 'welcher', 'welches',
  'auch', 'noch', 'schon', 'mal', 'doch', 'eben', 'halt',
  'für', 'mit', 'von', 'bei', 'aus', 'nach', 'zu', 'zur', 'zum', 'auf', 'in',
  'gehe', 'gehen', 'geht', 'mache', 'machen', 'macht', 'tue', 'tun', 'tut',
  'sehe', 'sehen', 'sieht', 'zeige', 'zeigen', 'zeigt',
]);

export const NAVIGATION_CATALOG: ReadonlyArray<NavCatalogEntry> = [
  // ── PUBLIC / AUTH (anonymous-safe) ──────────────────────────────────────
  {
    screen_id: 'PUBLIC.LANDING',
    route: '/',
    category: 'public',
    access: 'public',
    anonymous_safe: true,
    i18n: {
      en: {
        title: 'Vitanaland Landing',
        description: 'The main public entry point to Vitanaland and the Maxina community.',
        when_to_visit: 'When the user wants to go back to the start, the landing page, the home page of the website, or hear the introduction again.',
      },
      de: {
        title: 'Vitanaland Startseite',
        description: 'Der öffentliche Haupteinstieg zu Vitanaland und der Maxina Community.',
        when_to_visit: 'Wenn der Nutzer zurück zum Anfang, zur Startseite, zur Hauptseite der Website möchte oder die Einführung noch einmal hören will.',
      },
    },
  },
  {
    screen_id: 'AUTH.MAXINA_PORTAL',
    route: '/maxina',
    category: 'auth',
    access: 'public',
    anonymous_safe: true,
    priority: 1,
    i18n: {
      en: {
        title: 'Join the Maxina Community',
        description: 'Registration and sign-in for the Maxina community on Vitanaland.',
        when_to_visit: 'When the user wants to register, sign up, join the community, create an account, or sign in to Maxina.',
      },
      de: {
        title: 'Der Maxina Community beitreten',
        description: 'Registrierung und Anmeldung für die Maxina Community auf Vitanaland.',
        when_to_visit: 'Wenn der Nutzer sich registrieren, anmelden, der Community beitreten, ein Konto erstellen oder sich bei Maxina einloggen möchte.',
      },
    },
  },
  {
    screen_id: 'AUTH.ALKALMA_PORTAL',
    route: '/alkalma',
    category: 'auth',
    access: 'public',
    anonymous_safe: true,
    i18n: {
      en: {
        title: 'Alkalma Portal',
        description: 'Registration and sign-in for the Alkalma tenant.',
        when_to_visit: 'When the user mentions Alkalma specifically and wants to register or sign in.',
      },
      de: {
        title: 'Alkalma Portal',
        description: 'Registrierung und Anmeldung für den Alkalma Tenant.',
        when_to_visit: 'Wenn der Nutzer Alkalma erwähnt und sich registrieren oder anmelden möchte.',
      },
    },
  },
  {
    screen_id: 'AUTH.EARTHLINKS_PORTAL',
    route: '/earthlinks',
    category: 'auth',
    access: 'public',
    anonymous_safe: true,
    i18n: {
      en: {
        title: 'Earthlinks Portal',
        description: 'Registration and sign-in for the Earthlinks tenant.',
        when_to_visit: 'When the user mentions Earthlinks specifically and wants to register or sign in.',
      },
      de: {
        title: 'Earthlinks Portal',
        description: 'Registrierung und Anmeldung für den Earthlinks Tenant.',
        when_to_visit: 'Wenn der Nutzer Earthlinks erwähnt und sich registrieren oder anmelden möchte.',
      },
    },
  },
  {
    screen_id: 'AUTH.GENERIC',
    route: '/auth',
    category: 'auth',
    access: 'public',
    anonymous_safe: true,
    i18n: {
      en: {
        title: 'Sign In',
        description: 'Generic sign-in and sign-up screen.',
        when_to_visit: 'When the user wants a generic sign-in screen without a specific tenant context.',
      },
      de: {
        title: 'Anmelden',
        description: 'Allgemeiner Anmelde- und Registrierungsbildschirm.',
        when_to_visit: 'Wenn der Nutzer einen allgemeinen Anmeldebildschirm ohne spezifischen Tenant-Kontext möchte.',
      },
    },
  },
  {
    screen_id: 'PUBLIC.PRIVACY',
    route: '/privacy',
    category: 'public',
    access: 'public',
    anonymous_safe: true,
    i18n: {
      en: {
        title: 'Privacy Policy',
        description: 'Public privacy policy page.',
        when_to_visit: 'When the user asks about privacy, data protection, or what data Vitana collects.',
      },
      de: {
        title: 'Datenschutzerklärung',
        description: 'Öffentliche Datenschutzerklärung.',
        when_to_visit: 'Wenn der Nutzer nach Datenschutz, Datenverarbeitung oder welche Daten Vitana sammelt fragt.',
      },
    },
  },

  // ── HOME (authenticated) ────────────────────────────────────────────────
  {
    screen_id: 'HOME.OVERVIEW',
    route: '/home',
    category: 'home',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Home',
        description: 'Your personal home dashboard with everything tailored for you.',
        when_to_visit: 'When the user wants to go to their home page, the main dashboard, the start of the app after signing in.',
      },
      de: {
        title: 'Startseite',
        description: 'Dein persönliches Dashboard mit allem, was auf dich zugeschnitten ist.',
        when_to_visit: 'Wenn der Nutzer zur eigenen Startseite, zum Hauptdashboard oder zum App-Start nach der Anmeldung möchte.',
      },
    },
  },
  {
    screen_id: 'HOME.MATCHES',
    route: '/home/matches',
    category: 'home',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Matches',
        description: 'People in the community who match your interests, goals, and values.',
        when_to_visit: 'When the user asks who they should meet, who matches them, who to connect with, find friends, find people, find a partner, or discover compatible community members based on shared interests.',
      },
      de: {
        title: 'Matches',
        description: 'Menschen in der Community, die zu deinen Interessen, Zielen und Werten passen.',
        when_to_visit: 'Wenn der Nutzer wissen will wen er treffen sollte, wer zu ihm passt, mit wem er sich verbinden kann, Freunde finden, Menschen finden, einen Partner finden, oder kompatible Community-Mitglieder anhand gemeinsamer Interessen entdecken.',
      },
    },
  },
  {
    screen_id: 'HOME.AI_FEED',
    route: '/home/aifeed',
    category: 'home',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'AI Feed',
        description: 'A personalized stream of AI-curated content, recommendations, and insights.',
        when_to_visit: 'When the user asks what is new, what is happening, or wants to see their personalized AI-curated feed.',
      },
      de: {
        title: 'KI-Feed',
        description: 'Ein personalisierter Stream KI-kuratierter Inhalte, Empfehlungen und Einblicke.',
        when_to_visit: 'Wenn der Nutzer fragt, was neu ist, was passiert, oder seinen personalisierten KI-Feed sehen möchte.',
      },
    },
  },

  // ── COMMUNITY (P0 — most-used feature) ──────────────────────────────────
  {
    screen_id: 'COMM.OVERVIEW',
    route: '/comm',
    category: 'community',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Community',
        description: 'The Maxina community hub — events, live rooms, media, and groups.',
        when_to_visit: 'When the user asks about the community in general, wants to explore community features, or is not sure where to look for social content.',
      },
      de: {
        title: 'Community',
        description: 'Der Maxina Community Hub — Events, Live-Räume, Medien und Gruppen.',
        when_to_visit: 'Wenn der Nutzer allgemein nach der Community fragt, Community-Funktionen erkunden möchte oder nicht weiß, wo soziale Inhalte zu finden sind.',
      },
    },
  },
  {
    screen_id: 'COMM.EVENTS',
    route: '/comm/events-meetups',
    category: 'community',
    access: 'authenticated',
    anonymous_safe: false,
    priority: 2,
    i18n: {
      en: {
        title: 'Events & Meetups',
        description: 'Upcoming Maxina community events, in-person meetups, and gatherings.',
        when_to_visit: 'When the user asks about upcoming events, meetups, things to attend, scheduled gatherings, dance events, wellness workshops, or community activities they can attend in person.',
      },
      de: {
        title: 'Events & Meetups',
        description: 'Kommende Maxina Community Events, persönliche Treffen und Zusammenkünfte.',
        when_to_visit: 'Wenn der Nutzer nach kommenden Events, Meetups, Veranstaltungen, geplanten Treffen, Tanzveranstaltungen, Wellness-Workshops oder Community-Aktivitäten fragt, an denen teilgenommen werden kann.',
      },
    },
  },
  {
    screen_id: 'COMM.LIVE_ROOMS',
    route: '/comm/live-rooms',
    category: 'community',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Live Rooms',
        description: 'Live audio and video rooms where community members gather in real time.',
        when_to_visit: 'When the user asks about live rooms, live audio, live video, real-time conversations, online community calls, or virtual gatherings happening right now.',
      },
      de: {
        title: 'Live-Räume',
        description: 'Live Audio- und Video-Räume, in denen sich Community-Mitglieder in Echtzeit treffen.',
        when_to_visit: 'Wenn der Nutzer nach Live-Räumen, Live-Audio, Live-Video, Echtzeit-Gesprächen, Online-Community-Calls oder virtuellen Treffen fragt, die gerade stattfinden.',
      },
    },
  },
  {
    screen_id: 'COMM.MEDIA_HUB',
    route: '/comm/media-hub',
    category: 'community',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Media Hub',
        description: 'Videos, podcasts, and music shared by the community.',
        when_to_visit: 'When the user asks about videos, podcasts, music, recordings, or wants to browse media content from the community.',
      },
      de: {
        title: 'Media Hub',
        description: 'Videos, Podcasts und Musik der Community.',
        when_to_visit: 'Wenn der Nutzer nach Videos, Podcasts, Musik, Aufnahmen fragt oder Medieninhalte der Community durchstöbern möchte.',
      },
    },
  },

  // ── BUSINESS (P1 — major upcoming growth use case) ──────────────────────
  {
    screen_id: 'BUSINESS.OVERVIEW',
    route: '/business',
    category: 'business',
    access: 'authenticated',
    anonymous_safe: false,
    priority: 1,
    i18n: {
      en: {
        title: 'Business Hub',
        description: 'Your hub for building a business and earning income inside the Maxina community.',
        when_to_visit: 'When the user asks about building a business, becoming a creator, becoming a service provider, or generally exploring how to monetize their skills in the Maxina community.',
      },
      de: {
        title: 'Business Hub',
        description: 'Dein Hub, um ein Business aufzubauen und in der Maxina Community Einkommen zu generieren.',
        when_to_visit: 'Wenn der Nutzer fragt, wie man ein Business aufbaut, Creator wird, Dienstleister wird oder seine Fähigkeiten in der Maxina Community monetarisieren möchte.',
      },
    },
  },
  {
    screen_id: 'BUSINESS.SERVICES',
    route: '/business/services',
    category: 'business',
    access: 'authenticated',
    anonymous_safe: false,
    priority: 1,
    i18n: {
      en: {
        title: 'My Services',
        description: 'Manage the services you offer to the Maxina community — coaching, classes, sessions, products.',
        when_to_visit: 'When the user wants to manage their services, create a new service, list a coaching offering, or set up classes and sessions they offer.',
      },
      de: {
        title: 'Meine Services',
        description: 'Verwalte die Services, die du der Maxina Community anbietest — Coaching, Kurse, Sessions, Produkte.',
        when_to_visit: 'Wenn der Nutzer seine Services verwalten, einen neuen Service erstellen, ein Coaching-Angebot einstellen oder Kurse und Sessions einrichten möchte.',
      },
    },
  },
  {
    screen_id: 'BUSINESS.SELL_EARN',
    route: '/business/sell-earn',
    category: 'business',
    access: 'authenticated',
    anonymous_safe: false,
    priority: 2,
    i18n: {
      en: {
        title: 'Sell & Earn',
        description: 'Build a new income stream by selling your services and earning rewards in the Maxina community.',
        when_to_visit: 'When the user asks how to make money, earn income, build a side income, monetize their skills, monetize coaching, monetize fitness, monetize their expertise, sell services, become a paid creator, set up a new income stream, become a paid coach, or start earning from the Maxina community.',
      },
      de: {
        title: 'Verkaufen & Verdienen',
        description: 'Baue eine neue Einkommensquelle auf, indem du deine Services verkaufst und in der Maxina Community Belohnungen verdienst.',
        when_to_visit: 'Wenn der Nutzer fragt wie man Geld verdient, Einkommen generiert, ein Nebeneinkommen aufbaut, seine Fähigkeiten monetarisiert, Coaching monetarisiert, Fitness monetarisiert, seine Expertise monetarisiert, Services verkauft, bezahlter Creator wird, eine neue Einkommensquelle aufbaut oder mit der Maxina Community Geld verdienen will.',
      },
    },
  },
  {
    screen_id: 'BUSINESS.CLIENTS',
    route: '/business/clients',
    category: 'business',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'My Clients',
        description: 'Manage the clients and customers of your Maxina business.',
        when_to_visit: 'When the user asks about their clients, customers, who they serve, or how to manage client relationships in their business.',
      },
      de: {
        title: 'Meine Kunden',
        description: 'Verwalte die Kunden deines Maxina Business.',
        when_to_visit: 'Wenn der Nutzer nach seinen Kunden, Klienten, wen er bedient oder wie man Kundenbeziehungen im Business verwaltet, fragt.',
      },
    },
  },
  {
    screen_id: 'BUSINESS.ANALYTICS',
    route: '/business/analytics',
    category: 'business',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Business Analytics',
        description: 'Performance metrics for your Maxina business — bookings, revenue, growth.',
        when_to_visit: 'When the user asks about their business performance, revenue, bookings, growth metrics, or analytics for their services.',
      },
      de: {
        title: 'Business Analytics',
        description: 'Leistungskennzahlen für dein Maxina Business — Buchungen, Umsatz, Wachstum.',
        when_to_visit: 'Wenn der Nutzer nach seiner Business-Performance, Umsatz, Buchungen, Wachstumskennzahlen oder Analytics für seine Services fragt.',
      },
    },
  },

  // ── WALLET (P1 — paired with business) ──────────────────────────────────
  {
    screen_id: 'WALLET.OVERVIEW',
    route: '/wallet',
    category: 'wallet',
    access: 'authenticated',
    anonymous_safe: false,
    priority: 1,
    i18n: {
      en: {
        title: 'Wallet',
        description: 'Your Maxina wallet — balance, subscriptions, and rewards.',
        when_to_visit: 'When the user asks to open their wallet, see their balance, check what they have, or generally explore the wallet area.',
      },
      de: {
        title: 'Wallet',
        description: 'Dein Maxina Wallet — Guthaben, Abonnements und Belohnungen.',
        when_to_visit: 'Wenn der Nutzer sein Wallet öffnen, seinen Kontostand sehen, prüfen will, was er hat, oder den Wallet-Bereich erkunden möchte.',
      },
    },
  },
  {
    screen_id: 'WALLET.BALANCE',
    route: '/wallet/balance',
    category: 'wallet',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Balance & Benefits',
        description: 'Your current Maxina balance and the benefits unlocked at your tier.',
        when_to_visit: 'When the user asks about their balance, how much they have, their benefits, their tier, or what they have unlocked.',
      },
      de: {
        title: 'Guthaben & Vorteile',
        description: 'Dein aktuelles Maxina Guthaben und die in deinem Tier freigeschalteten Vorteile.',
        when_to_visit: 'Wenn der Nutzer nach seinem Guthaben, Kontostand, seinen Vorteilen, seinem Tier oder dem fragt, was er freigeschaltet hat.',
      },
    },
  },
  {
    screen_id: 'WALLET.SUBSCRIPTIONS',
    route: '/wallet/subscriptions',
    category: 'wallet',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Subscriptions',
        description: 'Your active subscriptions and the services you are paying for.',
        when_to_visit: 'When the user asks about their subscriptions, recurring payments, what they pay for, or wants to cancel or manage a subscription.',
      },
      de: {
        title: 'Abonnements',
        description: 'Deine aktiven Abonnements und die Services, für die du bezahlst.',
        when_to_visit: 'Wenn der Nutzer nach seinen Abonnements, wiederkehrenden Zahlungen, wofür er bezahlt fragt oder ein Abonnement kündigen oder verwalten möchte.',
      },
    },
  },
  {
    screen_id: 'WALLET.REWARDS',
    route: '/wallet/rewards',
    category: 'wallet',
    access: 'authenticated',
    anonymous_safe: false,
    priority: 2,
    i18n: {
      en: {
        title: 'Rewards & Commissions',
        description: 'Commissions and rewards you have earned from sharing the platform and serving clients.',
        when_to_visit: 'When the user asks about commissions, referral earnings, rewards, payouts, what they have earned, or how much they have made from sharing or selling in the community.',
      },
      de: {
        title: 'Belohnungen & Provisionen',
        description: 'Provisionen und Belohnungen, die du durch das Teilen der Plattform und das Betreuen von Kunden verdient hast.',
        when_to_visit: 'Wenn der Nutzer nach Provisionen, Empfehlungseinnahmen, Belohnungen, Auszahlungen, wieviel er verdient hat oder wieviel er durch Teilen oder Verkaufen in der Community gemacht hat, fragt.',
      },
    },
  },

  // ── HEALTH ──────────────────────────────────────────────────────────────
  {
    screen_id: 'HEALTH.OVERVIEW',
    route: '/health',
    category: 'health',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Health',
        description: 'Your personal health hub — biology, plans, and education.',
        when_to_visit: 'When the user asks about their health in general, longevity, wellness, or wants to explore health features.',
      },
      de: {
        title: 'Gesundheit',
        description: 'Dein persönlicher Gesundheits-Hub — Biologie, Pläne und Bildung.',
        when_to_visit: 'Wenn der Nutzer allgemein nach seiner Gesundheit, Longevity, Wellness fragt oder Gesundheitsfunktionen erkunden möchte.',
      },
    },
  },
  {
    screen_id: 'HEALTH.MY_BIOLOGY',
    route: '/health/my-biology',
    category: 'health',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'My Biology',
        description: 'Track your biomarkers, lab results, and personal health indicators with trends over time.',
        when_to_visit: 'When the user asks about their biology, biomarkers, lab results, blood work, health indicators, body composition, or wants to track their personal health data and trends.',
      },
      de: {
        title: 'Meine Biologie',
        description: 'Verfolge deine Biomarker, Laborergebnisse und persönlichen Gesundheitsindikatoren mit Trends über die Zeit.',
        when_to_visit: 'Wenn der Nutzer nach seiner Biologie, Biomarkern, Laborergebnissen, Blutwerten, Gesundheitsindikatoren, Körperzusammensetzung fragt oder seine persönlichen Gesundheitsdaten und Trends verfolgen möchte.',
      },
    },
  },
  {
    screen_id: 'HEALTH.PLANS',
    route: '/health/plans',
    category: 'health',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'My Plans',
        description: 'Personalized health plans built around your goals — nutrition, fitness, sleep, stress.',
        when_to_visit: 'When the user asks about their health plans, their nutrition plan, their fitness plan, their personal program, or what they should be doing for their goals.',
      },
      de: {
        title: 'Meine Pläne',
        description: 'Personalisierte Gesundheitspläne rund um deine Ziele — Ernährung, Fitness, Schlaf, Stress.',
        when_to_visit: 'Wenn der Nutzer nach seinen Gesundheitsplänen, seinem Ernährungsplan, seinem Fitnessplan, seinem persönlichen Programm oder dem, was er für seine Ziele tun sollte, fragt.',
      },
    },
  },
  {
    screen_id: 'HEALTH.EDUCATION',
    route: '/health/education',
    category: 'health',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Education & Science',
        description: 'Health education content and longevity science from the Vitana knowledge base.',
        when_to_visit: 'When the user asks to learn about a health topic, wants to read about longevity science, or wants educational content on wellness.',
      },
      de: {
        title: 'Bildung & Wissenschaft',
        description: 'Gesundheitsbildung und Longevity-Wissenschaft aus der Vitana Knowledge Base.',
        when_to_visit: 'Wenn der Nutzer ein Gesundheitsthema lernen möchte, über Longevity-Wissenschaft lesen will oder Bildungsinhalte zu Wellness sucht.',
      },
    },
  },
  {
    screen_id: 'HEALTH.SERVICES_HUB',
    route: '/health/services-hub',
    category: 'health',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Health Services Hub',
        description: 'Find and book health services from providers in the Maxina community.',
        when_to_visit: 'When the user asks where to find health services, how to book a session with a practitioner, or wants to browse health professionals.',
      },
      de: {
        title: 'Health Services Hub',
        description: 'Finde und buche Gesundheitsdienstleistungen von Anbietern in der Maxina Community.',
        when_to_visit: 'Wenn der Nutzer fragt, wo er Gesundheitsdienstleistungen findet, wie er eine Sitzung mit einem Praktiker bucht oder Gesundheitsfachleute durchstöbern möchte.',
      },
    },
  },

  // ── DISCOVER ────────────────────────────────────────────────────────────
  {
    screen_id: 'DISCOVER.OVERVIEW',
    route: '/discover',
    category: 'discover',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Discover',
        description: 'Browse supplements, wellness services, doctors, deals, and more.',
        when_to_visit: 'When the user wants to browse, discover, or shop for products and services in the Maxina marketplace.',
      },
      de: {
        title: 'Entdecken',
        description: 'Durchstöbere Nahrungsergänzungsmittel, Wellness-Services, Ärzte, Angebote und mehr.',
        when_to_visit: 'Wenn der Nutzer Produkte und Services im Maxina Marktplatz durchstöbern, entdecken oder kaufen möchte.',
      },
    },
  },
  {
    screen_id: 'DISCOVER.SUPPLEMENTS',
    route: '/discover/supplements',
    category: 'discover',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Supplements',
        description: 'Curated supplements for longevity and wellness.',
        when_to_visit: 'When the user asks about supplements, vitamins, minerals, nutraceuticals, or what to take for their health.',
      },
      de: {
        title: 'Nahrungsergänzungsmittel',
        description: 'Kuratierte Nahrungsergänzungsmittel für Longevity und Wellness.',
        when_to_visit: 'Wenn der Nutzer nach Nahrungsergänzungsmitteln, Vitaminen, Mineralien, Nutraceuticals oder dem, was er für seine Gesundheit nehmen sollte, fragt.',
      },
    },
  },
  {
    screen_id: 'DISCOVER.WELLNESS_SERVICES',
    route: '/discover/wellness-services',
    category: 'discover',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Wellness Services',
        description: 'Wellness services offered by the Maxina community.',
        when_to_visit: 'When the user asks about wellness services, massage, spa, recovery, or treatments they can book.',
      },
      de: {
        title: 'Wellness-Services',
        description: 'Wellness-Services, die von der Maxina Community angeboten werden.',
        when_to_visit: 'Wenn der Nutzer nach Wellness-Services, Massage, Spa, Recovery oder Behandlungen fragt, die er buchen kann.',
      },
    },
  },
  {
    screen_id: 'DISCOVER.DOCTORS_COACHES',
    route: '/discover/doctors-coaches',
    category: 'discover',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Doctors & Coaches',
        description: 'Find doctors, coaches, and health practitioners.',
        when_to_visit: 'When the user asks about doctors, coaches, practitioners, specialists, or wants to find a health professional.',
      },
      de: {
        title: 'Ärzte & Coaches',
        description: 'Finde Ärzte, Coaches und Gesundheitspraktiker.',
        when_to_visit: 'Wenn der Nutzer nach Ärzten, Coaches, Praktikern, Spezialisten fragt oder einen Gesundheitsfachmann finden möchte.',
      },
    },
  },
  {
    screen_id: 'DISCOVER.DEALS',
    route: '/discover/deals-offers',
    category: 'discover',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Deals & Offers',
        description: 'Member deals, discounts, and special offers.',
        when_to_visit: 'When the user asks about deals, discounts, offers, promotions, or what is on sale.',
      },
      de: {
        title: 'Angebote & Deals',
        description: 'Mitgliederangebote, Rabatte und spezielle Aktionen.',
        when_to_visit: 'Wenn der Nutzer nach Angeboten, Rabatten, Promotionen oder dem, was im Sale ist, fragt.',
      },
    },
  },

  // ── MEMORY ──────────────────────────────────────────────────────────────
  {
    screen_id: 'MEMORY.OVERVIEW',
    route: '/memory',
    category: 'memory',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Memory Garden',
        description: 'Your personal memory — everything Vitana remembers about you.',
        when_to_visit: 'When the user asks about their Memory Garden, what Vitana remembers about them, their personal records, or wants to manage their memory.',
      },
      de: {
        title: 'Memory Garden',
        description: 'Dein persönliches Gedächtnis — alles, was Vitana über dich weiß.',
        when_to_visit: 'Wenn der Nutzer nach seinem Memory Garden, dem was Vitana über ihn weiß, seinen persönlichen Aufzeichnungen fragt oder sein Gedächtnis verwalten möchte.',
      },
    },
  },
  {
    screen_id: 'MEMORY.DIARY',
    route: '/memory/diary',
    category: 'memory',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Daily Diary',
        description: 'Your daily diary entries — log thoughts, moods, and reflections.',
        when_to_visit: 'When the user asks to write a diary entry, log how they feel, journal their day, or open their daily diary.',
      },
      de: {
        title: 'Tagesbuch',
        description: 'Deine täglichen Tagebucheinträge — halte Gedanken, Stimmungen und Reflexionen fest.',
        when_to_visit: 'Wenn der Nutzer einen Tagebucheintrag schreiben, festhalten wie er sich fühlt, seinen Tag journaling oder sein Tagebuch öffnen möchte.',
      },
    },
  },
  {
    screen_id: 'CALENDAR.OVERVIEW',
    route: '/home',
    category: 'home',
    access: 'authenticated',
    anonymous_safe: false,
    priority: 1,
    i18n: {
      en: {
        title: 'Calendar',
        description: 'Your personal calendar — view upcoming events, appointments, and scheduled activities. The calendar opens as an overlay from the Calendar button in the header.',
        when_to_visit: 'When the user asks to open their calendar, see their schedule, check their appointments, view upcoming events, check availability, or manage their personal calendar.',
      },
      de: {
        title: 'Kalender',
        description: 'Dein persönlicher Kalender — sieh anstehende Termine, Verabredungen und geplante Aktivitäten. Der Kalender öffnet sich als Overlay über den Kalender-Button in der Kopfzeile.',
        when_to_visit: 'Wenn der Nutzer seinen Kalender öffnen, seinen Zeitplan sehen, Termine prüfen, anstehende Events ansehen, Verfügbarkeit prüfen oder seinen persönlichen Kalender verwalten möchte.',
      },
    },
    related_kb_topics: ['calendar', 'schedule', 'appointments', 'events'],
  },

  // ── AI ──────────────────────────────────────────────────────────────────
  {
    screen_id: 'AI.COMPANION',
    route: '/ai/companion',
    category: 'ai',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'AI Companion',
        description: 'Talk to Vitana in a focused companion view.',
        when_to_visit: 'When the user wants to open the AI companion, the Vitana companion view, talk to Vitana in text mode, or have an extended conversation outside the orb.',
      },
      de: {
        title: 'KI-Begleiter',
        description: 'Sprich mit Vitana in einer fokussierten Begleiter-Ansicht.',
        when_to_visit: 'Wenn der Nutzer den KI-Begleiter, die Vitana-Begleiter-Ansicht öffnen, im Textmodus mit Vitana sprechen oder eine längere Unterhaltung außerhalb des Orbs führen möchte.',
      },
    },
  },
  {
    screen_id: 'AI.RECOMMENDATIONS',
    route: '/ai/recommendations',
    category: 'ai',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Recommendations',
        description: 'Personalized AI recommendations across health, community, and content.',
        when_to_visit: 'When the user asks for recommendations, suggestions, what they should do, or wants to see Vitana\'s personalized picks for them.',
      },
      de: {
        title: 'Empfehlungen',
        description: 'Personalisierte KI-Empfehlungen für Gesundheit, Community und Inhalte.',
        when_to_visit: 'Wenn der Nutzer nach Empfehlungen, Vorschlägen fragt, was er tun sollte, oder Vitanas personalisierte Auswahl für ihn sehen möchte.',
      },
    },
  },

  // ── INBOX ───────────────────────────────────────────────────────────────
  {
    screen_id: 'INBOX.OVERVIEW',
    route: '/inbox',
    category: 'inbox',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Inbox',
        description: 'Messages, chat history, and conversations with community members.',
        when_to_visit: 'When the user asks about their inbox, messages, chat, chats, chat history, messenger, text messages, conversations, message history, DMs, direct messages, texting, writing to someone, communicating with members, or wants to check what has been sent to them.',
      },
      de: {
        title: 'Posteingang — Chat & Nachrichten',
        description: 'Nachrichten, Chats und Konversationen mit Community-Mitgliedern.',
        when_to_visit: 'Wenn der Nutzer nach Posteingang, Inbox, Nachrichten, Chat, Chats, Chat-Verlauf, Chat-Historie, Messenger, Textnachrichten, Konversationen, Nachrichtenverlauf, Direktnachrichten, mit Mitgliedern schreiben, mit Community kommunizieren, Benachrichtigungen fragt oder seine Nachrichten lesen möchte.',
      },
    },
  },
  {
    screen_id: 'INBOX.REMINDERS',
    route: '/inbox/reminder',
    category: 'inbox',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Reminders',
        description: 'Reminders Vitana has set for you.',
        when_to_visit: 'When the user asks about their reminders, what Vitana has reminded them about, or wants to see scheduled prompts.',
      },
      de: {
        title: 'Erinnerungen',
        description: 'Erinnerungen, die Vitana für dich gesetzt hat.',
        when_to_visit: 'Wenn der Nutzer nach seinen Erinnerungen fragt, woran Vitana ihn erinnert hat oder geplante Hinweise sehen möchte.',
      },
    },
  },

  // ── SETTINGS ────────────────────────────────────────────────────────────
  {
    screen_id: 'SETTINGS.OVERVIEW',
    route: '/settings',
    category: 'settings',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Settings',
        description: 'Your account settings and preferences.',
        when_to_visit: 'When the user asks to open their settings, change preferences, or manage their account.',
      },
      de: {
        title: 'Einstellungen',
        description: 'Deine Kontoeinstellungen und Präferenzen.',
        when_to_visit: 'Wenn der Nutzer seine Einstellungen öffnen, Präferenzen ändern oder sein Konto verwalten möchte.',
      },
    },
  },
  {
    screen_id: 'SETTINGS.PRIVACY',
    route: '/settings/privacy',
    category: 'settings',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Privacy Settings',
        description: 'Manage what data Vitana stores and what is shared with the community.',
        when_to_visit: 'When the user asks about privacy settings, data control, what is shared, consent, or wants to change their privacy preferences.',
      },
      de: {
        title: 'Datenschutzeinstellungen',
        description: 'Verwalte, welche Daten Vitana speichert und was mit der Community geteilt wird.',
        when_to_visit: 'Wenn der Nutzer nach Datenschutzeinstellungen, Datenkontrolle, was geteilt wird, Einwilligung fragt oder seine Datenschutzpräferenzen ändern möchte.',
      },
    },
  },
  {
    screen_id: 'SETTINGS.NOTIFICATIONS',
    route: '/settings/notifications',
    category: 'settings',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Notifications',
        description: 'Manage your notification preferences.',
        when_to_visit: 'When the user asks about notification settings, push notifications, email alerts, or wants to turn notifications on or off.',
      },
      de: {
        title: 'Benachrichtigungen',
        description: 'Verwalte deine Benachrichtigungspräferenzen.',
        when_to_visit: 'Wenn der Nutzer nach Benachrichtigungseinstellungen, Push-Benachrichtigungen, E-Mail-Hinweisen fragt oder Benachrichtigungen ein- oder ausschalten möchte.',
      },
    },
  },

  // ── FULL COVERAGE EXPANSION (Phase 2) ───────────────────────────────────
  // Every remaining community-user tab from vitana-v1/src/config/navigation.ts.

  // ── HOME (missing tabs) ─────────────────────────────────────────────────
  {
    screen_id: 'HOME.CONTEXT', route: '/home/context', category: 'home',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Context', description: 'Your personal context — what Vitana knows about your current situation.', when_to_visit: 'When the user asks about their context, current situation, or what Vitana knows about them right now.' },
      de: { title: 'Kontext', description: 'Dein persönlicher Kontext — was Vitana über deine aktuelle Situation weiß.', when_to_visit: 'Wenn der Nutzer nach seinem Kontext, seiner aktuellen Situation oder dem fragt, was Vitana gerade über ihn weiß.' },
    },
  },
  {
    screen_id: 'HOME.ACTIONS', route: '/home/actions', category: 'home',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Actions', description: 'Recommended actions and tasks for you today.', when_to_visit: 'When the user asks what they should do today, what actions are pending, or what tasks they have.' },
      de: { title: 'Aktionen', description: 'Empfohlene Aktionen und Aufgaben für dich heute.', when_to_visit: 'Wenn der Nutzer fragt, was er heute tun sollte, welche Aktionen anstehen oder welche Aufgaben er hat.' },
    },
  },

  // ── AI (missing tabs) ──────────────────────────────────────────────────
  {
    screen_id: 'AI.OVERVIEW', route: '/ai', category: 'ai',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'AI Assistant', description: 'Overview of your AI assistant features.', when_to_visit: 'When the user asks about the AI assistant, AI features, or wants to explore what the AI can do.' },
      de: { title: 'KI-Assistent', description: 'Übersicht deiner KI-Assistenten-Funktionen.', when_to_visit: 'Wenn der Nutzer nach dem KI-Assistenten, KI-Funktionen fragt oder erkunden möchte, was die KI kann.' },
    },
  },
  {
    screen_id: 'AI.INSIGHTS', route: '/ai/insights', category: 'ai',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'AI Insights', description: 'Personalized insights derived from your health data and activity.', when_to_visit: 'When the user asks for insights, patterns, trends, or what the AI has learned about them.' },
      de: { title: 'KI-Einblicke', description: 'Personalisierte Einblicke aus deinen Gesundheitsdaten und Aktivitäten.', when_to_visit: 'Wenn der Nutzer nach Einblicken, Mustern, Trends fragt oder wissen will, was die KI über ihn gelernt hat.' },
    },
  },
  {
    screen_id: 'AI.DAILY_SUMMARY', route: '/ai/daily-summary', category: 'ai',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Daily Summary', description: 'Your AI-generated daily summary of health, activity, and community highlights.', when_to_visit: 'When the user asks for their daily summary, daily briefing, daily report, or what happened today.' },
      de: { title: 'Tägliche Zusammenfassung', description: 'Deine KI-generierte tägliche Zusammenfassung von Gesundheit, Aktivität und Community-Highlights.', when_to_visit: 'Wenn der Nutzer nach seiner täglichen Zusammenfassung, seinem Tagesbericht oder dem fragt, was heute passiert ist.' },
    },
  },

  // ── DISCOVER (missing tabs) ─────────────────────────────────────────────
  {
    screen_id: 'DISCOVER.ORDERS', route: '/discover/orders', category: 'discover',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'My Orders', description: 'Your order history and active orders.', when_to_visit: 'When the user asks about their orders, order history, order status, deliveries, or what they have bought.' },
      de: { title: 'Meine Bestellungen', description: 'Deine Bestellhistorie und aktive Bestellungen.', when_to_visit: 'Wenn der Nutzer nach seinen Bestellungen, Bestellhistorie, Bestellstatus, Lieferungen oder dem fragt, was er gekauft hat.' },
    },
  },
  {
    screen_id: 'DISCOVER.AI_PICKS', route: '/discover/ai-picks', category: 'discover',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'AI Picks', description: 'AI-curated product and service recommendations.', when_to_visit: 'When the user asks for AI recommendations, personalized picks, curated suggestions, or what the AI recommends for them.' },
      de: { title: 'KI-Auswahl', description: 'KI-kuratierte Produkt- und Service-Empfehlungen.', when_to_visit: 'Wenn der Nutzer nach KI-Empfehlungen, personalisierten Vorschlägen, kuratierten Tipps fragt oder wissen will, was die KI für ihn empfiehlt.' },
    },
  },

  // ── INBOX (missing tabs) ────────────────────────────────────────────────
  {
    screen_id: 'INBOX.INSPIRATION', route: '/inbox/inspiration', category: 'inbox',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Inspiration', description: 'Inspirational messages and wellness tips from Vitana.', when_to_visit: 'When the user asks for inspiration, motivational messages, wellness tips, or daily motivation.' },
      de: { title: 'Inspiration', description: 'Inspirierende Nachrichten und Wellness-Tipps von Vitana.', when_to_visit: 'Wenn der Nutzer nach Inspiration, motivierenden Nachrichten, Wellness-Tipps oder täglicher Motivation fragt.' },
    },
  },
  {
    screen_id: 'INBOX.ARCHIVED', route: '/inbox/archived', category: 'inbox',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Archived Messages', description: 'Messages you have archived.', when_to_visit: 'When the user asks for archived messages, old messages, or messages they saved or dismissed.' },
      de: { title: 'Archivierte Nachrichten', description: 'Nachrichten, die du archiviert hast.', when_to_visit: 'Wenn der Nutzer nach archivierten Nachrichten, alten Nachrichten oder Nachrichten fragt, die er gespeichert oder verworfen hat.' },
    },
  },

  // ── SHARING (entire section missing) ────────────────────────────────────
  {
    screen_id: 'SHARING.OVERVIEW', route: '/sharing', category: 'sharing',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Sharing', description: 'Share the Maxina community with friends and earn rewards.', when_to_visit: 'When the user asks about sharing, referrals, inviting friends, or how to spread the word about the community.' },
      de: { title: 'Teilen', description: 'Teile die Maxina Community mit Freunden und verdiene Belohnungen.', when_to_visit: 'Wenn der Nutzer nach Teilen, Empfehlungen, Freunde einladen oder dem fragt, wie man die Community weiterempfiehlt.' },
    },
  },
  {
    screen_id: 'SHARING.CAMPAIGNS', route: '/sharing/campaigns', category: 'sharing',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Campaigns', description: 'Your active sharing campaigns and their performance.', when_to_visit: 'When the user asks about their sharing campaigns, referral campaigns, campaign performance, or campaign results.' },
      de: { title: 'Kampagnen', description: 'Deine aktiven Sharing-Kampagnen und deren Performance.', when_to_visit: 'Wenn der Nutzer nach seinen Sharing-Kampagnen, Empfehlungskampagnen, Kampagnen-Performance oder Kampagnen-Ergebnissen fragt.' },
    },
  },
  {
    screen_id: 'SHARING.DISTRIBUTION', route: '/sharing/distribution', category: 'sharing',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Distribution', description: 'Track how your shared content is distributed and received.', when_to_visit: 'When the user asks about distribution, how their content spreads, reach, or sharing analytics.' },
      de: { title: 'Verteilung', description: 'Verfolge, wie deine geteilten Inhalte verteilt und empfangen werden.', when_to_visit: 'Wenn der Nutzer nach Verteilung, wie sich seine Inhalte verbreiten, Reichweite oder Sharing-Analysen fragt.' },
    },
  },
  {
    screen_id: 'SHARING.DATA_CONSENT', route: '/sharing/data-consent', category: 'sharing',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Data & Consent', description: 'Manage what data you share and your consent preferences.', when_to_visit: 'When the user asks about data sharing consent, what data is shared, data permissions, or consent settings.' },
      de: { title: 'Daten & Einwilligung', description: 'Verwalte, welche Daten du teilst und deine Einwilligungspräferenzen.', when_to_visit: 'Wenn der Nutzer nach Datenfreigabe-Einwilligung, welche Daten geteilt werden, Datenberechtigungen oder Einwilligungseinstellungen fragt.' },
    },
  },

  // ── MEMORY (missing tabs) ──────────────────────────────────────────────
  {
    screen_id: 'MEMORY.TIMELINE', route: '/memory/timeline', category: 'memory',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Timeline', description: 'A chronological timeline of your memories and interactions.', when_to_visit: 'When the user asks to see their timeline, memory timeline, history of interactions, or chronological memory view.' },
      de: { title: 'Zeitleiste', description: 'Eine chronologische Zeitleiste deiner Erinnerungen und Interaktionen.', when_to_visit: 'Wenn der Nutzer seine Zeitleiste, Erinnerungstimeline, Verlauf der Interaktionen oder chronologische Gedächtnisansicht sehen möchte.' },
    },
  },
  {
    screen_id: 'MEMORY.RECALL', route: '/memory/recall', category: 'memory',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Recall & Search', description: 'Search through your memories and past conversations.', when_to_visit: 'When the user wants to search their memories, recall something they said, find a past conversation, or look up something Vitana remembers.' },
      de: { title: 'Erinnern & Suchen', description: 'Durchsuche deine Erinnerungen und vergangenen Gespräche.', when_to_visit: 'Wenn der Nutzer seine Erinnerungen durchsuchen, etwas nachschlagen will, was er gesagt hat, ein vergangenes Gespräch finden oder etwas nachschlagen möchte, was Vitana sich merkt.' },
    },
  },
  {
    screen_id: 'MEMORY.PERMISSIONS', route: '/memory/permissions', category: 'memory',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Memory Permissions', description: 'Control what Vitana remembers and who can see your memories.', when_to_visit: 'When the user asks about memory permissions, what Vitana is allowed to remember, memory privacy, or who can access their memories.' },
      de: { title: 'Speicher-Berechtigungen', description: 'Steuere, was Vitana sich merkt und wer deine Erinnerungen sehen kann.', when_to_visit: 'Wenn der Nutzer nach Speicher-Berechtigungen fragt, was Vitana sich merken darf, Gedächtnis-Privatsphäre oder wer Zugriff auf seine Erinnerungen hat.' },
    },
  },

  // ── SETTINGS (missing tabs) ─────────────────────────────────────────────
  {
    screen_id: 'SETTINGS.PREFERENCES', route: '/settings/preferences', category: 'settings',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Preferences', description: 'Your personal preferences for the app experience.', when_to_visit: 'When the user asks to change their preferences, customize the app, adjust settings, or personalize their experience.' },
      de: { title: 'Präferenzen', description: 'Deine persönlichen Präferenzen für die App-Erfahrung.', when_to_visit: 'Wenn der Nutzer seine Präferenzen ändern, die App anpassen, Einstellungen justieren oder seine Erfahrung personalisieren möchte.' },
    },
  },
  {
    screen_id: 'SETTINGS.CONNECTED_APPS', route: '/settings/connected-apps', category: 'settings',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Connected Apps', description: 'Manage third-party app integrations connected to your account.', when_to_visit: 'When the user asks about connected apps, integrations, third-party connections, or linked services.' },
      de: { title: 'Verbundene Apps', description: 'Verwalte Drittanbieter-App-Integrationen, die mit deinem Konto verbunden sind.', when_to_visit: 'Wenn der Nutzer nach verbundenen Apps, Integrationen, Drittanbieter-Verbindungen oder verknüpften Diensten fragt.' },
    },
  },
  {
    screen_id: 'SETTINGS.SOCIAL', route: '/settings/social', category: 'settings',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Social Accounts', description: 'Link and manage your social media accounts.', when_to_visit: 'When the user asks about social accounts, social media links, connecting Instagram, Facebook, or other social platforms.' },
      de: { title: 'Soziale Konten', description: 'Verknüpfe und verwalte deine Social-Media-Konten.', when_to_visit: 'Wenn der Nutzer nach sozialen Konten, Social-Media-Verknüpfungen, Instagram, Facebook oder anderen sozialen Plattformen verbinden fragt.' },
    },
  },
  {
    screen_id: 'SETTINGS.BILLING', route: '/settings/billing', category: 'settings',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Billing', description: 'Your billing information, payment methods, and invoices.', when_to_visit: 'When the user asks about billing, payment methods, invoices, payment history, credit card, or how to pay.' },
      de: { title: 'Abrechnung', description: 'Deine Rechnungsinformationen, Zahlungsmethoden und Rechnungen.', when_to_visit: 'Wenn der Nutzer nach Abrechnung, Zahlungsmethoden, Rechnungen, Zahlungshistorie, Kreditkarte oder wie man bezahlt fragt.' },
    },
  },
  {
    screen_id: 'SETTINGS.SUPPORT', route: '/settings/support', category: 'settings',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Support', description: 'Get help, contact support, or report an issue.', when_to_visit: 'When the user asks for help, support, how to contact the team, report a bug, or needs assistance with something.' },
      de: { title: 'Support', description: 'Hilfe erhalten, Support kontaktieren oder ein Problem melden.', when_to_visit: 'Wenn der Nutzer nach Hilfe, Support, wie man das Team kontaktiert, einen Fehler melden oder Unterstützung bei etwas braucht fragt.' },
    },
  },

  // ── HEALTH (secondary tabs) ─────────────────────────────────────────────
  {
    screen_id: 'HEALTH.PILLARS', route: '/health/pillars', category: 'health',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Health Pillars', description: 'The foundational pillars of your longevity — nutrition, fitness, sleep, stress, and more.', when_to_visit: 'When the user asks about health pillars, the pillars of longevity, foundational health areas, nutrition pillar, fitness pillar, sleep pillar, or stress management.' },
      de: { title: 'Gesundheitssäulen', description: 'Die Grundpfeiler deiner Longevity — Ernährung, Fitness, Schlaf, Stress und mehr.', when_to_visit: 'Wenn der Nutzer nach Gesundheitssäulen, den Grundpfeilern der Longevity, grundlegenden Gesundheitsbereichen, Ernährungssäule, Fitnesssäule, Schlafsäule oder Stressmanagement fragt.' },
    },
  },
  {
    screen_id: 'HEALTH.CONDITIONS', route: '/health/conditions', category: 'health',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'Health Conditions', description: 'Track and manage your health conditions.', when_to_visit: 'When the user asks about their health conditions, medical conditions, chronic conditions, diagnoses, or health issues they are managing.' },
      de: { title: 'Gesundheitszustände', description: 'Verfolge und verwalte deine Gesundheitszustände.', when_to_visit: 'Wenn der Nutzer nach seinen Gesundheitszuständen, medizinischen Zuständen, chronischen Erkrankungen, Diagnosen oder Gesundheitsproblemen fragt, die er verwaltet.' },
    },
  },

  // ── PROFILE ──────────────────────────────────────────────────────────────
  {
    screen_id: 'PROFILE.ME', route: '/me/profile', category: 'settings',
    access: 'authenticated', anonymous_safe: false,
    i18n: {
      en: { title: 'My Profile', description: 'Your personal profile — name, photo, bio, and account details.', when_to_visit: 'When the user asks to open their profile, see their profile, edit their profile, view their account, personal information, about me, or user profile.' },
      de: { title: 'Mein Profil', description: 'Dein persönliches Profil — Name, Foto, Bio und Kontodetails.', when_to_visit: 'Wenn der Nutzer sein Profil öffnen, sein Profil sehen, sein Profil bearbeiten, sein Konto ansehen, persönliche Informationen, über mich oder Nutzerprofil fragt.' },
    },
  },

  // ── PUBLIC (secondary) ──────────────────────────────────────────────────
  {
    screen_id: 'PUBLIC.TERMS', route: '/terms', category: 'public',
    access: 'public', anonymous_safe: true,
    i18n: {
      en: { title: 'Terms of Use', description: 'Terms of use and legal information.', when_to_visit: 'When the user asks about terms of use, terms and conditions, legal terms, or the user agreement.' },
      de: { title: 'Nutzungsbedingungen', description: 'Nutzungsbedingungen und rechtliche Informationen.', when_to_visit: 'Wenn der Nutzer nach Nutzungsbedingungen, AGB, rechtlichen Bedingungen oder der Nutzervereinbarung fragt.' },
    },
  },
];

// =============================================================================
// Lookup helpers
// =============================================================================

const BY_ID: Map<string, NavCatalogEntry> = new Map(
  NAVIGATION_CATALOG.map(e => [e.screen_id, e])
);

/**
 * Route lookup map. Normalized to strip trailing slashes and lowercase so
 * lookups tolerate "/events/", "/Events", etc.
 *
 * NOTE: A single canonical route may only map to one entry; duplicates in
 * the catalog (e.g. two variants pointing at `/`) collapse to the first.
 */
const BY_ROUTE: Map<string, NavCatalogEntry> = (() => {
  const map = new Map<string, NavCatalogEntry>();
  for (const entry of NAVIGATION_CATALOG) {
    const key = normalizeRoute(entry.route);
    if (key && !map.has(key)) {
      map.set(key, entry);
    }
  }
  return map;
})();

function normalizeRoute(route: string | undefined | null): string {
  if (!route) return '';
  // Strip query/hash, trailing slash, lowercase.
  const cleaned = route.split('?')[0].split('#')[0];
  const trimmed = cleaned.length > 1 && cleaned.endsWith('/')
    ? cleaned.slice(0, -1)
    : cleaned;
  return trimmed.toLowerCase();
}

/**
 * Resolve a localized content block for an entry, falling back to English
 * when the requested language is not curated for this entry.
 */
export function getContent(entry: NavCatalogEntry, lang: LangCode): NavCatalogContent {
  return entry.i18n[lang] || entry.i18n[FALLBACK_LANG] || Object.values(entry.i18n)[0];
}

/**
 * Look up a catalog entry by canonical screen_id.
 */
export function lookupScreen(id: string): NavCatalogEntry | null {
  if (!id) return null;
  return BY_ID.get(id) || null;
}

/**
 * VTID-NAV-TIMEJOURNEY: Look up a catalog entry by route path.
 *
 * Returns the entry whose `route` matches (case/trailing-slash insensitive).
 * Also handles nested routes by stripping segments: `/events/123` falls back
 * to `/events` if an exact match isn't present.
 *
 * Used by the time+journey greeting context builder to resolve friendly
 * titles ("Events & Meetups") for the raw paths the React Router pushes
 * into the session via VTOrb.updateContext().
 */
export function lookupByRoute(route: string | undefined | null): NavCatalogEntry | null {
  if (!route) return null;
  const normalized = normalizeRoute(route);
  if (!normalized) return null;

  const direct = BY_ROUTE.get(normalized);
  if (direct) return direct;

  // Progressive fallback: strip trailing segments until a match is found.
  // /events/abc123 → /events
  // /community/groups/42/members → /community/groups/42 → /community/groups → /community
  const parts = normalized.split('/').filter(Boolean);
  while (parts.length > 1) {
    parts.pop();
    const candidate = '/' + parts.join('/');
    const hit = BY_ROUTE.get(candidate);
    if (hit) return hit;
  }

  return null;
}

/**
 * Suggest catalog entries with similar ids (for tool-call hallucination recovery).
 * Uses substring + token-overlap scoring; cheap and good enough for ~40 entries.
 */
export function suggestSimilar(attemptedId: string, limit = 5): NavCatalogEntry[] {
  if (!attemptedId) return [];
  const target = attemptedId.toLowerCase();
  const targetTokens = new Set(target.split(/[\.\-_\s]+/).filter(Boolean));

  const scored: Array<{ entry: NavCatalogEntry; score: number }> = [];
  for (const entry of NAVIGATION_CATALOG) {
    const candidate = entry.screen_id.toLowerCase();
    let score = 0;
    if (candidate === target) score += 100;
    if (candidate.includes(target) || target.includes(candidate)) score += 30;

    const candidateTokens = candidate.split(/[\.\-_\s]+/).filter(Boolean);
    for (const tok of candidateTokens) {
      if (targetTokens.has(tok)) score += 10;
    }

    // Title overlap (English) as a tiebreaker
    const enTitle = entry.i18n[FALLBACK_LANG]?.title?.toLowerCase() || '';
    for (const tok of targetTokens) {
      if (tok.length > 2 && enTitle.includes(tok)) score += 3;
    }

    if (score > 0) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.entry);
}

/**
 * Search the catalog by free-text query.
 *
 * Scores each entry against the query in the requested language (with English
 * fallback) and returns ranked candidates. Used by the navigator-consult
 * service to score catalog matches before combining with KB and memory hints.
 *
 * Options:
 *   - category: restrict to a specific category
 *   - anonymous_only: only return entries that are anonymous_safe
 *   - exclude_routes: drop entries whose route matches (e.g. user is already there)
 */
export function searchCatalog(
  query: string,
  lang: LangCode,
  opts: {
    category?: NavCategory;
    anonymous_only?: boolean;
    exclude_routes?: string[];
  } = {}
): Array<{ entry: NavCatalogEntry; score: number }> {
  if (!query || !query.trim()) return [];

  const lowerQuery = query.toLowerCase().trim();
  const rawTokens = tokenizeWords(lowerQuery).filter(t => t.length > 2);

  // Drop stopwords so common pronouns/modals don't pollute scoring.
  // If filtering would remove ALL tokens, keep the raw list — better to have
  // weak signal than no signal at all.
  const queryTokens = rawTokens.filter(t => !STOPWORDS.has(t));
  const effectiveTokens = queryTokens.length > 0 ? queryTokens : rawTokens;

  const excluded = new Set(opts.exclude_routes || []);
  const results: Array<{ entry: NavCatalogEntry; score: number }> = [];

  for (const entry of NAVIGATION_CATALOG) {
    if (opts.category && entry.category !== opts.category) continue;
    if (opts.anonymous_only && !entry.anonymous_safe) continue;
    if (excluded.has(entry.route)) continue;

    const content = getContent(entry, lang);
    const titleLower = content.title.toLowerCase();
    const descLower = content.description.toLowerCase();
    const hintLower = content.when_to_visit.toLowerCase();

    // Word-set matching with cheap stemming: tokenize each field into a Set
    // so we match whole words rather than substrings. The stemmer adds
    // singular forms ("rooms" → "room", "doctors" → "doctor") so plurals
    // do not require an exact match. Without this, "meet" matches "meetups"
    // and "finde" matches "stattfinden" — both false positives.
    const titleWords = buildWordSet(titleLower);
    const hintWords = buildWordSet(hintLower);
    const descWords = buildWordSet(descLower);

    let score = 0;

    // Direct phrase match (highest signal — query appears verbatim somewhere)
    if (titleLower.includes(lowerQuery)) score += 40;
    else if (hintLower.includes(lowerQuery)) score += 30;
    else if (descLower.includes(lowerQuery)) score += 20;

    // Token matches — title is the strongest signal because titles are
    // intentional and distinctive. when_to_visit is intentionally generous
    // and shared by many entries, so individual hits are worth less.
    const matchedTokens = new Set<string>();
    for (const tok of effectiveTokens) {
      let matched = false;
      if (titleWords.has(tok)) {
        score += 15;
        matched = true;
      }
      if (hintWords.has(tok)) {
        score += 6;
        matched = true;
      }
      if (descWords.has(tok)) {
        score += 3;
        matched = true;
      }

      // Long-token substring fallback for German compounds and similar.
      // Only kicks in when whole-word matching missed AND the token is long
      // enough that accidental substring collisions are unlikely. Score is
      // intentionally low so it never beats a real word match.
      if (!matched && tok.length >= 6) {
        if (titleLower.includes(tok)) {
          score += 5;
          matched = true;
        } else if (hintLower.includes(tok)) {
          score += 2;
          matched = true;
        }
      }

      if (matched) matchedTokens.add(tok);
    }

    // "All meaningful tokens land in the same entry" coverage bonus —
    // counts DISTINCT tokens covered (not hit count) so an entry that has
    // the same word in both title and hint doesn't get false coverage for
    // a multi-token query.
    if (effectiveTokens.length > 1 && matchedTokens.size >= effectiveTokens.length) {
      score += effectiveTokens.length * 6;
    }

    // Priority boost for promoted destinations (Maxina growth focus).
    // Only applied when there is already a meaningful keyword signal so it
    // never single-handedly overrides clear keyword matches.
    if (entry.priority && entry.priority > 0 && score > 0) {
      score += entry.priority * 3;
    }

    if (score > 0) results.push({ entry, score });
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable tiebreaker: priority entries first, then catalog declaration order
    const pa = a.entry.priority || 0;
    const pb = b.entry.priority || 0;
    return pb - pa;
  });
  return results;
}

/**
 * Split text into whole-word tokens. Splits on whitespace, punctuation, and
 * common separators while preserving Unicode letters (umlauts, accents, etc.)
 * inside words. Used for both query and haystack tokenization so the matching
 * is symmetric.
 */
function tokenizeWords(text: string): string[] {
  return text
    .split(/[\s\.\,\?\!\:\;\(\)\[\]\{\}\-\u2013\u2014\'\"\/\&\+\*]+/)
    .filter(t => t.length > 0);
}

/**
 * Build a token set with cheap singular-form stemming for English-style
 * plurals. "rooms" → adds "room", "matches" → adds "match", "doctors" →
 * adds "doctor". German plurals are not handled here because German
 * pluralization is irregular; the long-token substring fallback in
 * searchCatalog covers German compounds instead.
 */
function buildWordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of tokenizeWords(text)) {
    out.add(w);
    if (w.length > 4 && w.endsWith('es')) {
      out.add(w.slice(0, -2));
    } else if (w.length > 3 && w.endsWith('s')) {
      out.add(w.slice(0, -1));
    }
  }
  return out;
}

/**
 * Convenience: get every entry in a given category. Useful for tests and
 * for the consult service when narrowing by inferred category.
 */
export function entriesByCategory(category: NavCategory): NavCatalogEntry[] {
  return NAVIGATION_CATALOG.filter(e => e.category === category);
}
