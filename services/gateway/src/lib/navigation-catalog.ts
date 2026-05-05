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
  | 'autopilot'
  | 'inbox'
  | 'settings'
  | 'sharing'
  | 'developer';

/**
 * VTID-02770: Overlay metadata. Used when `entry_kind === 'overlay'`.
 *
 * Overlays are NOT React Router routes — they are popups/drawers/sheets
 * dispatched via CustomEvent on the active page. The Navigator emits
 * `${host_route}?open=${query_marker}` and the frontend ORB widget
 * intercepts the `?open=` param and dispatches `event_name` instead of
 * navigating. See useOrbVoiceWidget.ts:127-143.
 */
export interface NavOverlayMeta {
  /** Page where the overlay opens. If empty, opens on the user's current route. */
  host_route?: string;
  /** CustomEvent name the frontend dispatches when the overlay should open. */
  event_name: string;
  /** ?open=<marker> URL signal the gateway emits and the frontend reads. */
  query_marker: string;
  /** Optional named param the overlay needs (e.g. 'user_id', 'meetup_id'). */
  needs_param?: string;
}

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
  /** VITANA-BRAIN: Roles that can see this entry. If omitted/empty, surface is inferred from route/category — see resolveEffectiveRoles. */
  allowed_roles?: string[];
  /**
   * VTID-02770: Alternative slug-style identifiers Gemini, LiveKit, or legacy
   * email/marketing links may emit. Looked up via `lookupByAlias()`. Lets the
   * canonical screen_id evolve while older clients keep working.
   *
   * Examples for `COMM.EVENTS`: `['events', 'events_meetups', 'events-meetups',
   * 'community/events', '/community/events']` — both the legacy slug forms
   * baked into `orb-tool.ts:553` and the user-canonical paths from the
   * 89-screen inventory.
   */
  aliases?: string[];
  /**
   * VTID-02770: Entry kind. `'route'` = real React Router route (default).
   * `'overlay'` = popup/drawer dispatched via CustomEvent on the host_route.
   * The handler in `handleNavigateToScreen()` branches on this to emit either
   * a plain navigation URL or a `${host_route}?open=${query_marker}` overlay
   * trigger.
   */
  entry_kind?: 'route' | 'overlay';
  overlay?: NavOverlayMeta;
}

/**
 * Surface-scoped role resolver. Every catalog entry belongs to exactly one
 * surface — community (vitanaland + mobile), admin (/admin/* inside the
 * community app), or Command Hub (developer). The ORB Navigator must never
 * cross surfaces: a community user never gets teleported into /admin or
 * /command-hub, and a developer in Command Hub never gets sent to a
 * community route that Command Hub can't render. If the entry has an
 * explicit `allowed_roles`, we trust it. Otherwise we infer:
 *   - route starts with `/admin/` → admin surface
 *   - category `developer`        → Command Hub (developer)
 *   - everything else             → community
 */
export function resolveEffectiveRoles(entry: NavCatalogEntry): string[] {
  if (entry.allowed_roles && entry.allowed_roles.length > 0) return entry.allowed_roles;
  if (entry.route.startsWith('/admin/') || entry.route === '/admin') return ['admin'];
  if (entry.category === 'developer') return ['developer', 'DEV'];
  return ['community'];
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
    role?: string;
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
      // Surface scoping: authenticated callers may only see entries on their
      // surface. Anonymous callers skip the role gate — anonymous_safe carries
      // the access decision for them.
      if (opts.role && !resolveEffectiveRoles(entry).includes(opts.role)) continue;

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
  // Generic UI nouns — users say "open the X screen" meaning "open X". Without
  // these in stopwords, any entry whose when_to_visit mentions "screen" /
  // "page" / "section" picks up a keyword hit on the generic word and the
  // Navigator can't distinguish specific matches from noise (see "open
  // connectors screen" silently matching HOME because its hint ends with
  // "...or simply the home screen").
  'screen', 'screens', 'page', 'pages', 'section', 'sections',
  'view', 'views', 'panel', 'panels', 'tab', 'tabs', 'window', 'windows',
  // German navigation verbs + UI nouns
  'öffne', 'öffnen', 'öffnet', 'schließen', 'schließe',
  'seite', 'seiten', 'bildschirm', 'bildschirme',
  'ansicht', 'ansichten', 'bereich', 'bereiche', 'fenster',
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
    aliases: ['auth', 'login', 'sign-in', 'signin', 'community-login', 'anmelden'],
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
  // VTID-01900: /home is the standalone News Feed — longevity news, latest
  // articles, research highlights. The i18n copy reflects that so the
  // navigator maps "news", "longevity news", "latest news" here.
  {
    screen_id: 'HOME.OVERVIEW',
    route: '/home',
    category: 'home',
    aliases: ['home', 'news', 'longevity-news', 'startseite', 'home-overview'],
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'Longevity News',
        description: 'Your home News Feed — the latest longevity news, research, and articles curated for you.',
        when_to_visit: 'When the user wants news, longevity news, the latest news, the news feed, what is new in longevity, articles, research updates, or simply the home screen.',
      },
      de: {
        title: 'Longevity News',
        description: 'Dein News-Feed zu Hause — aktuelle Longevity-Nachrichten, Forschung und Artikel, für dich kuratiert.',
        when_to_visit: 'Wenn der Nutzer Nachrichten, Longevity-News, neueste Nachrichten, den News-Feed, Neuigkeiten zu Longevity, Artikel, Forschungs-Updates oder einfach die Startseite möchte.',
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

  // ── AUTOPILOT (authenticated) ───────────────────────────────────────────
  // The Autopilot Dashboard is the user-facing "My Journey" screen: the
  // 90-day journey (waves, milestones, recommendations) prepared by
  // Autopilot and aligned to the Calendar. Keywords steer "open my journey"
  // here instead of /me/profile.
  {
    screen_id: 'AUTOPILOT.MY_JOURNEY',
    route: '/autopilot',
    category: 'autopilot',
    access: 'authenticated',
    anonymous_safe: false,
    i18n: {
      en: {
        title: 'My Journey',
        description: 'Your Autopilot Dashboard — the 90-day journey prepared for you: waves, milestones, and recommended actions aligned to your calendar.',
        when_to_visit: 'When the user asks to open my journey, see my journey, show my journey, the autopilot journey, my 90-day journey, the 90-day plan, the autopilot dashboard, my plan, or what is on their journey today. This is NOT the user profile — "my journey" means the Autopilot Dashboard.',
      },
      de: {
        title: 'Meine Reise',
        description: 'Dein Autopilot-Dashboard — die 90-Tage-Reise, die für dich vorbereitet wurde: Wellen, Meilensteine und empfohlene Aktionen, abgestimmt auf deinen Kalender.',
        when_to_visit: 'Wenn der Nutzer meine Reise öffnen, meine Reise sehen, die Autopilot-Reise, meine 90-Tage-Reise, den 90-Tage-Plan, das Autopilot-Dashboard, meinen Plan, oder was heute auf seiner Reise ansteht, anfragt. Das ist NICHT das Nutzerprofil — "meine Reise" bedeutet das Autopilot-Dashboard.',
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
    aliases: ['community', '/community', 'comm', 'community-overview'],
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
    aliases: [
      'events', 'meetups', 'events-meetups', 'events_meetups',
      'community/events', '/community/events', 'community-events',
    ],
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
    aliases: ['live-rooms', 'live_rooms', 'community/live-rooms', '/community/live-rooms'],
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
    aliases: ['media-hub', 'media_hub', 'community/media-hub', '/community/media-hub'],
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
    aliases: ['my-business', 'community/my-business', '/community/my-business', 'business-hub'],
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
    aliases: ['my-biology', 'biology', 'biomarkers', '/health/biomarkers', 'health/biomarkers', 'biologie'],
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
    aliases: ['discover', 'shop', 'marketplace-overview', 'entdecken'],
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
    aliases: ['diary', 'daily-diary', '/diary', '/daily-diary', 'tagebuch'],
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
    // Overlay: opens on the user's current screen. Frontend intercepts
    // `?open=calendar` and dispatches `calendar:open` instead of routing.
    route: '/calendar',
    entry_kind: 'overlay',
    overlay: {
      event_name: 'calendar:open',
      query_marker: 'calendar',
    },
    category: 'home',
    access: 'authenticated',
    anonymous_safe: false,
    priority: 3,
    aliases: ['calendar', 'my-calendar', 'kalender', 'open-calendar'],
    i18n: {
      en: {
        title: 'My Calendar',
        description: 'Your personal calendar — view upcoming events, appointments, scheduled activities, and your schedule. The calendar opens as an overlay.',
        when_to_visit: 'When the user asks to open their calendar, see their calendar, my calendar, show calendar, check their appointments, view upcoming schedule, check availability, Kalender öffnen, or manage their personal calendar.',
      },
      de: {
        title: 'Mein Kalender',
        description: 'Dein persönlicher Kalender — sieh anstehende Termine, Verabredungen und geplante Aktivitäten. Der Kalender öffnet sich als Overlay.',
        when_to_visit: 'Wenn der Nutzer seinen Kalender öffnen, Kalender anzeigen, mein Kalender, seinen Zeitplan sehen, Termine prüfen, anstehende Events ansehen, Verfügbarkeit prüfen oder seinen persönlichen Kalender verwalten möchte.',
      },
    },
    related_kb_topics: ['calendar', 'schedule', 'appointments', 'events'],
  },
  {
    // Life Compass opens as an overlay on whatever screen the user is on.
    // The ?open=life_compass query is intercepted in the ORB widget
    // navigation handler (useOrbVoiceWidget) which dispatches the global
    // open-life-compass event instead of routing — so the user never loses
    // context when they say "open my goals" mid-conversation.
    screen_id: 'LIFE_COMPASS.OVERLAY',
    route: '/',
    entry_kind: 'overlay',
    overlay: {
      event_name: 'vitana:open-life-compass',
      query_marker: 'life_compass',
    },
    category: 'memory',
    access: 'authenticated',
    anonymous_safe: false,
    priority: 2,
    aliases: ['life-compass', 'life_compass', 'goals', 'my-goals', 'compass', 'lebenskompass'],
    i18n: {
      en: {
        title: 'Life Compass',
        description: 'Your Life Compass — the primary goal that guides every Vitana recommendation. Pick from suggested goals (Financial Freedom, Life Partner, Health, Career, Skills, Spiritual Life) or define your own. Opens as an overlay.',
        when_to_visit: 'When the user asks to open their Life Compass, show their goals, see their goals, change their goals, pick a different goal, update their focus, set a new goal, or talk about what they want to prioritize. Also when the user says "my goals", "my compass", "my focus", or "my primary goal".',
      },
      de: {
        title: 'Lebenskompass',
        description: 'Dein Lebenskompass — das Hauptziel, das jede Vitana-Empfehlung prägt. Wähle aus vorgeschlagenen Zielen (Finanzielle Freiheit, Lebenspartner, Gesundheit, Karriere, Fähigkeiten, Spirituelles Leben) oder definiere dein eigenes. Öffnet sich als Overlay.',
        when_to_visit: 'Wenn der Nutzer seinen Lebenskompass öffnen, seine Ziele anzeigen, seine Ziele ändern, einen neuen Fokus setzen oder darüber sprechen möchte, was er priorisieren will. Auch bei "meine Ziele", "mein Kompass", "mein Fokus" oder "mein Hauptziel".',
      },
    },
    related_kb_topics: ['goals', 'life compass', 'focus', 'primary goal', 'priorities', 'spiritual life'],
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
    aliases: ['inbox', 'messages', 'chat', 'chats', 'posteingang', 'nachrichten'],
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
    aliases: ['reminders', 'reminder', 'inbox-reminder', 'erinnerungen'],
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
    aliases: ['privacy', 'privacy-settings', 'datenschutz'],
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
    aliases: ['connected-apps', 'connected_apps', 'connectors', 'integrations', 'verbundene-apps', 'connect-spotify', 'connect-youtube', 'connect-google'],
    i18n: {
      en: { title: 'Connectors & Connected Apps', description: 'Connectors to third-party apps and integrations linked to your account.', when_to_visit: 'When the user asks about connectors, a connector, connected apps, app integrations, third-party connections, linked services, or how to connect an external app.' },
      de: { title: 'Konnektoren & Verbundene Apps', description: 'Konnektoren zu Drittanbieter-Apps und Integrationen, die mit deinem Konto verknüpft sind.', when_to_visit: 'Wenn der Nutzer nach Konnektoren, einem Konnektor, verbundenen Apps, App-Integrationen, Drittanbieter-Verbindungen, verknüpften Diensten oder dem Verbinden einer externen App fragt.' },
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
    aliases: ['profile', 'my-profile', 'edit-profile', 'profile/edit', '/profile/edit', '/profile', 'me', 'me/profile'],
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

  // ===========================================================================
  // VTID-02770 — Navigator Rework (PR-1): missing community screens + overlays.
  // Sourced from vitana-v1/src/App.tsx route registrations as of 2026-05-05.
  // ===========================================================================

  // ── INTENTS (Find a Partner / Match engine) ─────────────────────────────
  {
    screen_id: 'INTENTS.BOARD', route: '/intents/board', category: 'community',
    access: 'authenticated', anonymous_safe: false, priority: 2,
    aliases: ['intent-board', 'intent_board', 'community/intent-board', 'intents-board', 'all-intents'],
    i18n: {
      en: { title: 'Intent Board', description: 'Browse all open community intents and asks across categories.', when_to_visit: 'When the user asks for the intent board, all community posts, what people are asking for, the dance board, or the open community board.' },
      de: { title: 'Intent-Board', description: 'Durchstöbere alle offenen Community-Anliegen und Anfragen über alle Kategorien hinweg.', when_to_visit: 'Wenn der Nutzer nach dem Intent-Board, allen Community-Posts, was die Leute suchen, dem Tanz-Board oder dem offenen Community-Board fragt.' },
    },
  },
  {
    screen_id: 'INTENTS.MINE', route: '/intents/mine', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['my-intents', 'my_intents', 'community/my-intents', 'my-posts'],
    i18n: {
      en: { title: 'My Intents', description: 'Your own posts and asks in the community.', when_to_visit: 'When the user asks for "my intents", "my posts", "my asks", "what I posted", or wants to see and manage their own community posts.' },
      de: { title: 'Meine Intents', description: 'Deine eigenen Posts und Anfragen in der Community.', when_to_visit: 'Wenn der Nutzer nach "meinen Intents", "meinen Posts", "meinen Anfragen", "was ich gepostet habe" fragt oder seine eigenen Community-Posts ansehen oder verwalten möchte.' },
    },
  },
  {
    screen_id: 'INTENTS.MATCH_DETAIL', route: '/intents/match/:match_id', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['intent-match-detail', 'intent_match_detail', 'match-detail'],
    i18n: {
      en: { title: 'Match Detail', description: 'A specific match between two community members based on overlapping intents.', when_to_visit: 'When the user asks to see a specific match, the details of one of their matches, or wants to open a match by id.' },
      de: { title: 'Match-Detail', description: 'Ein bestimmtes Match zwischen zwei Community-Mitgliedern basierend auf überlappenden Anliegen.', when_to_visit: 'Wenn der Nutzer ein bestimmtes Match sehen möchte, die Details eines seiner Matches anfragt oder ein Match per ID öffnen will.' },
    },
  },

  // ── COMMUNITY (newly-shipped destinations) ──────────────────────────────
  {
    screen_id: 'COMM.FIND_PARTNER', route: '/comm/find-partner', category: 'community',
    access: 'authenticated', anonymous_safe: false, priority: 2,
    aliases: ['find-partner', 'find_partner', 'partner', 'find-a-partner', 'community/find-partner', 'find-match', 'find-a-match', 'partnersuche', 'tanzpartner-finden'],
    i18n: {
      en: { title: 'Find a Partner', description: 'Unified dance + fitness partner discovery — ranked matches.', when_to_visit: 'When the user wants a dance partner, fitness buddy, partner match, or asks to open Find a Partner. Use for all dance- and fitness-partner discovery.' },
      de: { title: 'Partner finden', description: 'Einheitliche Tanz- und Fitness-Partnersuche — geordnete Matches.', when_to_visit: 'Wenn der Nutzer einen Tanzpartner, Fitness-Buddy oder Partner-Match möchte oder die Partnersuche öffnen will.' },
    },
  },
  {
    screen_id: 'COMM.FIND_PARTNER_MATCHES', route: '/comm/find-partner?view=matches', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['my-matches', 'matches', 'find-partner-matches', 'community/find-partner/my-matches'],
    i18n: {
      en: { title: 'My Matches', description: 'Your current dance and fitness partner matches.', when_to_visit: 'When the user asks for "my matches", "show my matches", "who matches with me", or "who Vitana found for me".' },
      de: { title: 'Meine Matches', description: 'Deine aktuellen Tanz- und Fitness-Partner-Matches.', when_to_visit: 'Wenn der Nutzer nach "meinen Matches", "zeig meine Matches", "wer matcht mit mir" oder "wen hat Vitana für mich gefunden" fragt.' },
    },
  },
  {
    screen_id: 'COMM.FIND_PARTNER_BOARD', route: '/comm/find-partner?view=board', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['find-partner-board', 'partner-board'],
    i18n: {
      en: { title: 'Partner Board', description: 'The community board view of dance and fitness partner posts.', when_to_visit: 'When the user asks for the partner board, dance board, the community board for partner posts, or wants to see who is looking.' },
      de: { title: 'Partner-Board', description: 'Die Community-Board-Ansicht der Tanz- und Fitness-Partner-Posts.', when_to_visit: 'Wenn der Nutzer nach dem Partner-Board, Tanz-Board, dem Community-Board für Partner-Posts fragt oder sehen möchte, wer sucht.' },
    },
  },
  {
    screen_id: 'COMM.FIND_PARTNER_POSTS', route: '/comm/find-partner?view=posts', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['find-partner-posts', 'my-partner-posts'],
    i18n: {
      en: { title: 'My Partner Posts', description: 'Your own dance and fitness partner posts.', when_to_visit: 'When the user asks for "my partner posts", "my dance posts", "my fitness posts", or "what I posted to find a partner".' },
      de: { title: 'Meine Partner-Posts', description: 'Deine eigenen Tanz- und Fitness-Partner-Posts.', when_to_visit: 'Wenn der Nutzer nach "meinen Partner-Posts", "meinen Tanz-Posts", "meinen Fitness-Posts" oder "was ich gepostet habe um einen Partner zu finden" fragt.' },
    },
  },
  {
    screen_id: 'COMM.OPEN_ASKS', route: '/comm/open-asks', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['open-asks', 'open_asks', 'community/open-asks', 'asks', 'unmatched-posts'],
    i18n: {
      en: { title: 'Open Asks', description: 'Community-wide unmatched posts looking for a partner or helper.', when_to_visit: 'When the user asks for "open asks", "what is the community looking for", "unmatched posts", or "who needs help".' },
      de: { title: 'Offene Anfragen', description: 'Community-weite Posts ohne Match, die einen Partner oder Helfer suchen.', when_to_visit: 'Wenn der Nutzer nach "offenen Anfragen", "was sucht die Community", "Posts ohne Match" oder "wer braucht Hilfe" fragt.' },
    },
  },
  {
    screen_id: 'COMM.MEMBERS', route: '/comm/members', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['members', 'community-members', 'community/members', 'mitglieder'],
    i18n: {
      en: { title: 'Community Members', description: 'Browse the directory of Maxina community members.', when_to_visit: 'When the user asks for the members directory, community members, who is in the community, or wants to browse member profiles.' },
      de: { title: 'Community-Mitglieder', description: 'Durchstöbere das Verzeichnis der Maxina Community-Mitglieder.', when_to_visit: 'Wenn der Nutzer nach dem Mitgliederverzeichnis, Community-Mitgliedern, wer in der Community ist fragt oder Mitgliederprofile durchstöbern möchte.' },
    },
  },
  {
    screen_id: 'COMM.TALK_TO_VITANA', route: '/comm/talk-to-vitana', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['talk-to-vitana', 'talk_to_vitana', 'feedback', 'report-issue', 'support-vitana'],
    i18n: {
      en: { title: 'Talk to Vitana', description: 'Capture feedback, report issues, or send a message to the Vitana team.', when_to_visit: 'When the user wants to give feedback, report a bug, send a message to Vitana, or talk to the team.' },
      de: { title: 'Mit Vitana sprechen', description: 'Feedback geben, Probleme melden oder eine Nachricht an das Vitana-Team senden.', when_to_visit: 'Wenn der Nutzer Feedback geben, einen Bug melden, eine Nachricht an Vitana senden oder mit dem Team sprechen möchte.' },
    },
  },
  {
    screen_id: 'COMM.GROUPS', route: '/comm/groups', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['groups', 'community-groups', 'community/groups', '/community/groups', 'gruppen'],
    i18n: {
      en: { title: 'Groups', description: 'Browse and join Maxina community groups.', when_to_visit: 'When the user asks about community groups, joining a group, what groups are available, or wants to see their groups.' },
      de: { title: 'Gruppen', description: 'Durchstöbere und tritt Maxina Community-Gruppen bei.', when_to_visit: 'Wenn der Nutzer nach Community-Gruppen, einer Gruppe beitreten, welche Gruppen verfügbar sind fragt oder seine Gruppen sehen möchte.' },
    },
  },
  {
    screen_id: 'COMM.GROUP_DETAIL', route: '/comm/groups/:groupId', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['group-detail', 'group_detail', 'community/groups/detail'],
    i18n: {
      en: { title: 'Group Detail', description: 'A specific community group — its members, posts, and events.', when_to_visit: 'When the user asks to open a specific group by id or name, see a group, or view group details.' },
      de: { title: 'Gruppen-Detail', description: 'Eine bestimmte Community-Gruppe — ihre Mitglieder, Posts und Events.', when_to_visit: 'Wenn der Nutzer eine bestimmte Gruppe per ID oder Name öffnen, eine Gruppe sehen oder Gruppendetails ansehen möchte.' },
    },
  },
  {
    screen_id: 'COMM.LIVE_ROOM_VIEWER', route: '/comm/live-rooms/:roomId/view', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['live-room-viewer', 'live_room_viewer'],
    i18n: {
      // Narrow keywords. The generic "live rooms" request belongs on COMM.LIVE_ROOMS.
      en: { title: 'Specific Live Room Viewer', description: 'Viewer page for a specific live audio or video room by roomId.', when_to_visit: 'When the caller has a specific roomId and needs to open that one viewer page.' },
      de: { title: 'Spezifischer Live-Raum Viewer', description: 'Viewer-Seite für einen bestimmten Live-Audio- oder Live-Video-Raum per roomId.', when_to_visit: 'Wenn der Aufrufer eine spezifische roomId hat und diese eine Viewer-Seite öffnen muss.' },
    },
  },
  {
    screen_id: 'COMM.FEED', route: '/comm/events-meetups?tab=following', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['feed', 'community-feed', 'community/feed', '/community/feed'],
    i18n: {
      en: { title: 'Community Feed', description: 'Your community feed — posts and updates from members and groups you follow.', when_to_visit: 'When the user asks to open the community feed, see community posts, scroll the feed, or check what is new in the community.' },
      de: { title: 'Community-Feed', description: 'Dein Community-Feed — Posts und Updates von Mitgliedern und Gruppen, denen du folgst.', when_to_visit: 'Wenn der Nutzer den Community-Feed öffnen, Community-Posts sehen, durch den Feed scrollen oder prüfen möchte, was es Neues in der Community gibt.' },
    },
  },

  // ── DISCOVER (newly-shipped) ────────────────────────────────────────────
  {
    screen_id: 'DISCOVER.MARKETPLACE', route: '/discover/marketplace', category: 'discover',
    access: 'authenticated', anonymous_safe: false, priority: 2,
    aliases: ['marketplace', 'discover-marketplace', 'commercial-intents', 'marktplatz'],
    i18n: {
      en: { title: 'Marketplace', description: 'The Maxina marketplace — buy and sell commercial intents from the community.', when_to_visit: 'When the user asks to open the marketplace, browse commercial intents, buy or sell something, or see what the community is selling.' },
      de: { title: 'Marktplatz', description: 'Der Maxina Marktplatz — kaufe und verkaufe kommerzielle Intents aus der Community.', when_to_visit: 'Wenn der Nutzer den Marktplatz öffnen, kommerzielle Intents durchstöbern, etwas kaufen oder verkaufen oder sehen möchte, was die Community verkauft.' },
    },
  },
  {
    screen_id: 'DISCOVER.PRODUCT_DETAIL', route: '/discover/product/:id', category: 'discover',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['product-detail', 'product_detail', 'product'],
    i18n: {
      en: { title: 'Product Detail', description: 'Detail page for a specific product.', when_to_visit: 'When the user wants to open a specific product by id, see product details, or read about a particular item.' },
      de: { title: 'Produkt-Detail', description: 'Detailseite für ein bestimmtes Produkt.', when_to_visit: 'Wenn der Nutzer ein bestimmtes Produkt per ID öffnen, Produktdetails sehen oder über einen bestimmten Artikel lesen möchte.' },
    },
  },
  {
    screen_id: 'DISCOVER.PROVIDER_PROFILE', route: '/discover/provider/:id', category: 'discover',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['provider-profile', 'provider_profile', 'provider'],
    i18n: {
      en: { title: 'Provider Profile', description: 'Profile page for a specific service provider.', when_to_visit: 'When the user wants to open a specific provider profile, see a coach or doctor profile, or look up a service provider by id.' },
      de: { title: 'Anbieterprofil', description: 'Profilseite für einen bestimmten Dienstleister.', when_to_visit: 'Wenn der Nutzer ein bestimmtes Anbieterprofil öffnen, ein Coach- oder Arztprofil sehen oder einen Dienstleister per ID nachschlagen möchte.' },
    },
  },
  {
    screen_id: 'DISCOVER.CART', route: '/cart', category: 'discover',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['cart', '/discover/cart', 'discover/cart', 'shopping-cart', 'warenkorb'],
    i18n: {
      en: { title: 'Shopping Cart', description: 'Items in your shopping cart, ready to check out.', when_to_visit: 'When the user asks to open the cart, see what is in their cart, check out, or review their basket.' },
      de: { title: 'Warenkorb', description: 'Artikel in deinem Warenkorb, bereit zur Kasse.', when_to_visit: 'Wenn der Nutzer den Warenkorb öffnen, sehen was im Warenkorb ist, zur Kasse gehen oder seinen Korb prüfen möchte.' },
    },
  },

  // ── HEALTH (newly-shipped) ──────────────────────────────────────────────
  {
    screen_id: 'HEALTH.VITANA_INDEX', route: '/health/vitana-index', category: 'health',
    access: 'authenticated', anonymous_safe: false, priority: 2,
    aliases: ['vitana-index', 'vitana_index', 'health-score', 'index', 'longevity-index'],
    i18n: {
      en: { title: 'Vitana Index', description: 'Your Vitana Index score — the 5-pillar longevity metric (Nutrition, Hydration, Exercise, Sleep, Mental).', when_to_visit: 'When the user asks about their Vitana Index, their longevity score, their health score, the 5 pillars, or how their health is trending.' },
      de: { title: 'Vitana Index', description: 'Dein Vitana-Index-Score — die 5-Säulen-Longevity-Kennzahl (Ernährung, Hydration, Bewegung, Schlaf, Mentale).', when_to_visit: 'Wenn der Nutzer nach seinem Vitana Index, seinem Longevity-Score, seinem Gesundheitsscore, den 5 Säulen oder dem Gesundheitstrend fragt.' },
    },
  },
  {
    screen_id: 'HEALTH.BIOMARKER_RESULTS', route: '/health/biomarker-results', category: 'health',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['biomarker-results', 'lab-results', 'blood-results'],
    i18n: {
      // Specific to the latest-results detail view; the generic "show my
      // biomarkers" request belongs on HEALTH.MY_BIOLOGY (which has the
      // trends + chart). Keep keywords narrow — title avoids the
      // standalone word "Biomarker".
      en: { title: 'Latest Test Result Detail', description: 'Detail panel for the most recent single test result.', when_to_visit: 'When the user wants the detail panel for ONE SPECIFIC most-recent test (not the trends view).' },
      de: { title: 'Detail des letzten Testergebnisses', description: 'Detailpanel für das aktuellste einzelne Testergebnis.', when_to_visit: 'Wenn der Nutzer das Detailpanel für EIN SPEZIFISCHES aktuellstes Testergebnis möchte (nicht die Trendsansicht).' },
    },
  },
  {
    screen_id: 'HEALTH.TRACKER', route: '/health-tracker', category: 'health',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['health-tracker', 'tracker', 'my-health-tracker', '/health/my-health-tracker'],
    i18n: {
      en: { title: 'Health Tracker', description: 'Track your daily health behaviors and Vitana Index movements.', when_to_visit: 'When the user asks to open the health tracker, log a health behavior, track water/sleep/exercise, or see today\'s tracker.' },
      de: { title: 'Gesundheits-Tracker', description: 'Verfolge dein tägliches Gesundheitsverhalten und Vitana-Index-Bewegungen.', when_to_visit: 'Wenn der Nutzer den Gesundheits-Tracker öffnen, ein Gesundheitsverhalten loggen, Wasser/Schlaf/Bewegung verfolgen oder den heutigen Tracker sehen möchte.' },
    },
  },

  // ── BUSINESS (newly-shipped tabs) ───────────────────────────────────────
  {
    screen_id: 'BUSINESS.LISTINGS', route: '/business/listings', category: 'business',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['business-listings', 'listings', 'my-listings', 'business-inserate'],
    i18n: {
      en: { title: 'My Business Listings', description: 'Your active business listings on Maxina.', when_to_visit: 'When the user asks about their business listings, posted services, what they have published commercially, or wants to manage their public business posts.' },
      // German title intentionally avoids "Anzeigen" (which is also the verb
      // "to display") so generic queries like "X anzeigen" don't hijack here.
      de: { title: 'Meine Inserate', description: 'Deine aktiven Geschäftsinserate auf Maxina.', when_to_visit: 'Wenn der Nutzer nach seinen Inseraten, Geschäftsinseraten, geposteten Services, was er kommerziell veröffentlicht hat fragt oder seine öffentlichen Business-Posts verwalten möchte.' },
    },
  },
  {
    screen_id: 'BUSINESS.OPPORTUNITIES', route: '/business/opportunities', category: 'business',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['business-opportunities', 'opportunities', 'business-leads'],
    i18n: {
      en: { title: 'Business Opportunities', description: 'New business opportunities and leads matched to your services.', when_to_visit: 'When the user asks about business opportunities, leads, new clients, or what business has come in.' },
      de: { title: 'Business-Chancen', description: 'Neue Business-Chancen und Leads, die zu deinen Services passen.', when_to_visit: 'Wenn der Nutzer nach Business-Chancen, Leads, neuen Kunden oder welches Business reingekommen ist fragt.' },
    },
  },

  // ── PROFILE (newly-shipped + cross-user) ────────────────────────────────
  {
    screen_id: 'PROFILE.PRIVACY', route: '/profile/me/privacy', category: 'settings',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['profile-privacy', 'profile/me/privacy', 'visibility-settings', 'profile-visibility'],
    i18n: {
      // Title intentionally avoids the word "Datenschutz" to keep the
      // generic "datenschutz einstellungen" query landing on SETTINGS.PRIVACY.
      en: { title: 'Profile Visibility', description: 'Per-section visibility toggles for your profile — control who sees what.', when_to_visit: 'When the user asks about profile visibility, who can see their profile, what is shown publicly, or wants to hide a profile section.' },
      de: { title: 'Profil-Sichtbarkeit', description: 'Sichtbarkeits-Schalter pro Bereich für dein Profil — steuere, wer was sieht.', when_to_visit: 'Wenn der Nutzer nach Profil-Sichtbarkeit, wer sein Profil sehen kann, was öffentlich gezeigt wird fragt oder einen Profil-Bereich verbergen möchte.' },
    },
  },
  {
    screen_id: 'PROFILE.PUBLIC', route: '/u/:identifier', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['public-profile', 'user-profile', '/u', 'u', '/profile/:id'],
    i18n: {
      en: { title: 'Public Profile', description: 'A community member\'s public profile.', when_to_visit: 'When the user wants to open another member\'s profile, see a community member\'s public page, look someone up by their @vitana_id, or view a username.' },
      de: { title: 'Öffentliches Profil', description: 'Das öffentliche Profil eines Community-Mitglieds.', when_to_visit: 'Wenn der Nutzer das Profil eines anderen Mitglieds öffnen, die öffentliche Seite eines Community-Mitglieds sehen, jemanden per @vitana_id nachschlagen oder einen Benutzernamen ansehen möchte.' },
    },
  },
  {
    screen_id: 'PROFILE.WITH_MATCH', route: '/u/:identifier?match_intent=:intent_id', category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['profile-with-match', 'profile_with_match', 'matched-profile'],
    i18n: {
      en: { title: 'Profile with Match Anchor', description: 'A community member\'s public profile, anchored to a specific matched intent.', when_to_visit: 'When the user wants to open the profile of someone they matched with, see a profile with the matched post highlighted, or jump from a match notification to the counterparty profile.' },
      de: { title: 'Profil mit Match-Anker', description: 'Das öffentliche Profil eines Community-Mitglieds, verankert an einem spezifischen gematchten Intent.', when_to_visit: 'Wenn der Nutzer das Profil von jemandem öffnen möchte, mit dem er gematcht hat, ein Profil mit hervorgehobenem Match-Post sehen oder von einer Match-Benachrichtigung zum Profil der Gegenseite springen möchte.' },
    },
  },

  // ── REMINDERS / MESSAGES / DAILY DIARY ──────────────────────────────────
  {
    screen_id: 'REMINDERS.OVERVIEW', route: '/reminders', category: 'inbox',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['reminders', 'reminder-list', 'all-reminders', 'meine-erinnerungen'],
    i18n: {
      en: { title: 'Reminders', description: 'Your scheduled reminders — the full list, with controls to add, edit, and dismiss.', when_to_visit: 'When the user asks for the reminders list, all reminders, "show me my reminders", or wants to manage scheduled reminders.' },
      de: { title: 'Erinnerungen', description: 'Deine geplanten Erinnerungen — die vollständige Liste, mit Steuerung zum Hinzufügen, Bearbeiten und Verwerfen.', when_to_visit: 'Wenn der Nutzer nach der Erinnerungsliste, allen Erinnerungen, "zeig mir meine Erinnerungen" fragt oder geplante Erinnerungen verwalten möchte.' },
    },
  },
  {
    screen_id: 'MESSAGES.OVERVIEW', route: '/messages', category: 'inbox',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['messages', 'direct-messages', 'dms', 'chats', 'conversations'],
    i18n: {
      en: { title: 'Messages', description: 'Your direct messages and conversations with community members.', when_to_visit: 'When the user asks to open messages, direct messages, conversations, or wants to write to another member directly.' },
      de: { title: 'Nachrichten', description: 'Deine Direktnachrichten und Konversationen mit Community-Mitgliedern.', when_to_visit: 'Wenn der Nutzer Nachrichten, Direktnachrichten, Konversationen öffnen oder einem anderen Mitglied direkt schreiben möchte.' },
    },
  },
  {
    screen_id: 'MEMORY.DAILY_DIARY', route: '/daily-diary', category: 'memory',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['today-diary', 'today-journal', 'todays-diary'],
    i18n: {
      // Narrow keywords on purpose. The generic "open my diary" / "open daily
      // diary" should land on MEMORY.DIARY (the diary list); this entry is the
      // dedicated TODAY-only capture flow.
      en: { title: 'Single-Day Capture Flow', description: 'A focused single-day capture flow for one specific day.', when_to_visit: 'When the user explicitly wants the dedicated single-day capture step (not the general diary view).' },
      de: { title: 'Eintags-Erfassungsfluss', description: 'Ein fokussierter Erfassungsfluss für einen bestimmten einzelnen Tag.', when_to_visit: 'Wenn der Nutzer ausdrücklich den dedizierten Eintags-Erfassungsschritt möchte (nicht die allgemeine Tagebuchansicht).' },
    },
  },

  // ── SETTINGS (newly-shipped tabs) ───────────────────────────────────────
  {
    screen_id: 'SETTINGS.VOICE_AI', route: '/settings/voice-ai', category: 'settings',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['voice-ai', 'voice-settings', 'orb-settings'],
    i18n: {
      en: { title: 'Voice & AI Preferences', description: 'Voice and AI preferences for the Vitana ORB.', when_to_visit: 'When the user asks about ORB voice preferences or how to customize Vitana\'s voice (NOT generic privacy/notification settings).' },
      de: { title: 'Sprach- & KI-Präferenzen', description: 'Sprach- und KI-Präferenzen für den Vitana ORB.', when_to_visit: 'Wenn der Nutzer nach ORB-Sprachpräferenzen fragt oder Vitanas Stimme anpassen möchte (NICHT allgemeine Datenschutz-/Benachrichtigungseinstellungen).' },
    },
  },
  {
    screen_id: 'SETTINGS.AUTOPILOT', route: '/settings/autopilot', category: 'settings',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['autopilot-settings', 'autopilot-preferences'],
    i18n: {
      en: { title: 'Autopilot Settings', description: 'Configure Autopilot — recommendation cadence, what categories to surface, and quiet hours.', when_to_visit: 'When the user asks about autopilot settings, autopilot preferences, how to configure recommendations, or wants to change autopilot behavior.' },
      de: { title: 'Autopilot-Einstellungen', description: 'Konfiguriere Autopilot — Empfehlungs-Frequenz, welche Kategorien angezeigt werden und Ruhezeiten.', when_to_visit: 'Wenn der Nutzer nach Autopilot-Einstellungen, Autopilot-Präferenzen fragt, wie man Empfehlungen konfiguriert oder das Autopilot-Verhalten ändern möchte.' },
    },
  },
  {
    screen_id: 'SETTINGS.LIMITATIONS', route: '/settings/limitations', category: 'settings',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['limitations', 'health-limitations', 'restrictions'],
    i18n: {
      en: { title: 'Health Limitations', description: 'Record health limitations or constraints (allergies, injuries, conditions) so recommendations stay safe.', when_to_visit: 'When the user wants to record health limitations, register allergies, mark an injury, or note conditions that affect recommendations.' },
      de: { title: 'Gesundheitliche Einschränkungen', description: 'Erfasse gesundheitliche Einschränkungen (Allergien, Verletzungen, Erkrankungen), damit Empfehlungen sicher bleiben.', when_to_visit: 'Wenn der Nutzer gesundheitliche Einschränkungen festhalten, Allergien hinterlegen, eine Verletzung markieren oder Bedingungen erfassen möchte, die Empfehlungen beeinflussen.' },
    },
  },
  {
    screen_id: 'SETTINGS.TENANT', route: '/settings/tenant', category: 'settings',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['tenant', 'tenant-settings', 'organization', 'workspace'],
    i18n: {
      en: { title: 'Tenant', description: 'The tenant or workspace your account belongs to.', when_to_visit: 'When the user asks about their tenant, organization, workspace, or which Maxina portal they belong to.' },
      de: { title: 'Tenant', description: 'Der Tenant oder Workspace, zu dem dein Konto gehört.', when_to_visit: 'Wenn der Nutzer nach seinem Tenant, seiner Organisation, seinem Workspace oder zu welchem Maxina-Portal er gehört fragt.' },
    },
  },
  {
    screen_id: 'SETTINGS.TENANT_ROLE', route: '/settings/tenant-role', category: 'settings',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['tenant-role', 'role-settings', 'switch-role'],
    i18n: {
      en: { title: 'Tenant & Role', description: 'Switch your active role within the current tenant — community, professional, staff, admin.', when_to_visit: 'When the user wants to switch role, change role, become admin/professional/staff, or asks about their tenant role.' },
      de: { title: 'Tenant & Rolle', description: 'Wechsle deine aktive Rolle im aktuellen Tenant — Community, Professional, Staff, Admin.', when_to_visit: 'Wenn der Nutzer die Rolle wechseln, Admin/Professional/Staff werden möchte oder nach seiner Tenant-Rolle fragt.' },
    },
  },

  // ── NEWS / ASSISTANT / SEARCH ───────────────────────────────────────────
  {
    screen_id: 'NEWS.DETAIL', route: '/news/:id', category: 'home',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['news-detail', 'news-article', 'article'],
    i18n: {
      en: { title: 'News Article', description: 'Detail view of a longevity news article.', when_to_visit: 'When the user wants to read a specific news article by id, open a news story, or see the full article they were reading.' },
      de: { title: 'News-Artikel', description: 'Detailansicht eines Longevity-News-Artikels.', when_to_visit: 'Wenn der Nutzer einen bestimmten News-Artikel per ID lesen, eine News-Story öffnen oder den vollständigen Artikel sehen möchte, den er gelesen hat.' },
    },
  },
  {
    screen_id: 'ASSISTANT.OVERVIEW', route: '/assistant', category: 'ai',
    access: 'authenticated', anonymous_safe: false,
    // Title is intentionally distinct from AI.OVERVIEW ("AI Assistant") so
    // generic "open the AI assistant" still lands on AI.OVERVIEW. This
    // entry is the dedicated chat-window route, not the assistant landing.
    aliases: ['assistant-chat', 'vitana-chat', 'chat-with-vitana', 'text-chat'],
    i18n: {
      en: { title: 'Vitana Chat', description: 'The dedicated chat surface — a focused conversation window with Vitana, outside the orb.', when_to_visit: 'When the user explicitly wants to chat with Vitana in a text window, open the chat view, or have an extended typed conversation. Prefer AI.OVERVIEW for the generic "AI Assistant" request.' },
      de: { title: 'Vitana Chat', description: 'Die dedizierte Chat-Oberfläche — ein fokussiertes Konversationsfenster mit Vitana, außerhalb des Orbs.', when_to_visit: 'Wenn der Nutzer ausdrücklich mit Vitana in einem Textfenster chatten, die Chat-Ansicht öffnen oder eine längere getippte Konversation führen möchte. Bevorzuge AI.OVERVIEW für die allgemeine "KI-Assistent"-Anfrage.' },
    },
  },
  {
    screen_id: 'SEARCH.OVERVIEW', route: '/search', category: 'home',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['search', 'global-search', 'suchen'],
    i18n: {
      en: { title: 'Search', description: 'Global search across the entire Maxina app — members, content, services, products.', when_to_visit: 'When the user wants to search the app, find something specific, look up a member, find content, or open a global search.' },
      de: { title: 'Suchen', description: 'Globale Suche durch die gesamte Maxina-App — Mitglieder, Inhalte, Services, Produkte.', when_to_visit: 'Wenn der Nutzer die App durchsuchen, etwas Bestimmtes finden, ein Mitglied nachschlagen, Inhalt finden oder eine globale Suche öffnen möchte.' },
    },
  },

  // ──────────────────────────────────────────────────────────────────────
  // VTID-02770 — OVERLAY entries (entry_kind='overlay').
  // These do NOT navigate to a route; they emit `?open=<query_marker>` and
  // the frontend ORB widget intercepts that and dispatches `event_name` as
  // a CustomEvent. See useOrbVoiceWidget.ts:127-143 for the dispatcher.
  // ──────────────────────────────────────────────────────────────────────
  {
    screen_id: 'OVERLAY.VITANA_INDEX', route: '/health',
    entry_kind: 'overlay',
    overlay: { event_name: 'vitana:open-index', query_marker: 'index' },
    category: 'health',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['index-overlay', 'vitana-index-sheet', 'health-score-overlay'],
    i18n: {
      en: { title: 'Vitana Index Sheet', description: 'A quick overlay showing your current Vitana Index score with the 5 pillar breakdown.', when_to_visit: 'When the user asks for a quick view of their Vitana Index without leaving the current screen, or says "open the index" / "show my score" mid-conversation.' },
      de: { title: 'Vitana-Index-Sheet', description: 'Ein schnelles Overlay, das deinen aktuellen Vitana-Index-Score mit der 5-Säulen-Aufschlüsselung zeigt.', when_to_visit: 'Wenn der Nutzer eine schnelle Ansicht seines Vitana Index möchte, ohne den aktuellen Bildschirm zu verlassen, oder mitten im Gespräch "öffne den Index" / "zeig mir meinen Score" sagt.' },
    },
  },
  {
    screen_id: 'OVERLAY.PROFILE_PREVIEW', route: '/comm/members',
    entry_kind: 'overlay',
    overlay: { event_name: 'profile:open', query_marker: 'profile_preview', needs_param: 'user_id' },
    category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['profile-preview', 'preview-profile'],
    i18n: {
      en: { title: 'Profile Preview', description: 'A quick preview of a community member\'s profile as a dialog.', when_to_visit: 'When the user wants to peek at a member\'s profile without fully navigating, or says "preview their profile".' },
      de: { title: 'Profil-Vorschau', description: 'Eine schnelle Vorschau des Profils eines Community-Mitglieds als Dialog.', when_to_visit: 'Wenn der Nutzer einen Blick auf das Profil eines Mitglieds werfen möchte, ohne komplett zu navigieren, oder "Profil-Vorschau" sagt.' },
    },
  },
  {
    screen_id: 'OVERLAY.MEETUP_DRAWER', route: '/comm/events-meetups',
    entry_kind: 'overlay',
    overlay: { event_name: 'meetup:open', query_marker: 'meetup', needs_param: 'meetup_id' },
    category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['meetup-drawer', 'meetup-details'],
    i18n: {
      // Narrow keywords: this is the entity-specific overlay, not the
      // generic "show me events" request (which → COMM.EVENTS).
      en: { title: 'Single Meetup Drawer', description: 'Drawer view for a specific meetup by id.', when_to_visit: 'When the caller has a specific meetup_id and wants to drill into that one record as a drawer overlay.' },
      de: { title: 'Einzelnes Meetup-Drawer', description: 'Drawer-Ansicht für ein bestimmtes Meetup per ID.', when_to_visit: 'Wenn der Aufrufer eine spezifische meetup_id hat und in diesen einzelnen Datensatz als Drawer-Overlay reinzoomen möchte.' },
    },
  },
  {
    screen_id: 'OVERLAY.EVENT_DRAWER', route: '/comm/events-meetups',
    entry_kind: 'overlay',
    overlay: { event_name: 'event:open', query_marker: 'event', needs_param: 'event_id' },
    category: 'community',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['event-drawer', 'event-details'],
    i18n: {
      en: { title: 'Single Event Drawer', description: 'Drawer view for a specific event by id.', when_to_visit: 'When the caller has a specific event_id and wants to drill into that one record as a drawer overlay.' },
      de: { title: 'Einzelnes Event-Drawer', description: 'Drawer-Ansicht für ein bestimmtes Event per ID.', when_to_visit: 'Wenn der Aufrufer eine spezifische event_id hat und in diesen einzelnen Datensatz als Drawer-Overlay reinzoomen möchte.' },
    },
  },
  {
    screen_id: 'OVERLAY.MASTER_ACTION', route: '/home',
    entry_kind: 'overlay',
    overlay: { event_name: 'master_action:open', query_marker: 'master_action' },
    category: 'home',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['master-action', 'action-popup', 'quick-actions'],
    i18n: {
      en: { title: 'Quick Actions', description: 'A page-aware quick-action popup with the most relevant actions for the current screen.', when_to_visit: 'When the user asks for "quick actions", "page actions", or wants to see the most relevant actions for what they are currently viewing.' },
      de: { title: 'Schnellaktionen', description: 'Ein seitenbezogenes Schnellaktions-Popup mit den relevantesten Aktionen für den aktuellen Bildschirm.', when_to_visit: 'Wenn der Nutzer nach "Schnellaktionen", "Seitenaktionen" fragt oder die relevantesten Aktionen für das, was er gerade ansieht, sehen möchte.' },
    },
  },
  {
    screen_id: 'OVERLAY.WALLET_POPUP', route: '/wallet',
    entry_kind: 'overlay',
    overlay: { event_name: 'wallet:open', query_marker: 'wallet' },
    category: 'wallet',
    access: 'authenticated', anonymous_safe: false,
    aliases: ['wallet-popup', 'wallet-overlay', 'wallet-sheet', 'quick-wallet'],
    i18n: {
      // Narrow keywords. The generic "open my wallet" request belongs to
      // WALLET.OVERVIEW. This overlay is only the quick-peek popup.
      en: { title: 'Quick Wallet Popup', description: 'Bottom-sheet peek of balance + recent rewards.', when_to_visit: 'When the user explicitly says "quick peek" or "sheet" — wants a momentary popup without navigation.' },
      de: { title: 'Schnelles Wallet-Popup', description: 'Unten eingeblendeter Sheet-Peek mit Guthaben + letzten Belohnungen.', when_to_visit: 'Wenn der Nutzer ausdrücklich "schneller Peek" oder "Sheet" sagt — ein kurzes Popup ohne Navigation.' },
    },
  },

  // ===========================================================================
  // VITANA-BRAIN: Command Hub Developer Screens (role-gated: developer, admin)
  // 17 modules, 87 screens from navigation-config.js
  // ===========================================================================

  // ── Overview ──
  { screen_id: 'DEVHUB.OVERVIEW.SYSTEM_OVERVIEW', route: '/command-hub/overview/system-overview/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'System Overview', description: 'High-level system dashboard with health and status.', when_to_visit: 'When asking for system overview, dashboard, system status, or platform health.' } } },
  { screen_id: 'DEVHUB.OVERVIEW.LIVE_METRICS', route: '/command-hub/overview/live-metrics/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Live Metrics', description: 'Real-time performance metrics and statistics.', when_to_visit: 'When asking for metrics, performance, stats, live data, or real-time monitoring.' } } },
  { screen_id: 'DEVHUB.OVERVIEW.RECENT_EVENTS', route: '/command-hub/overview/recent-events/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Recent Events', description: 'Latest system events and activity feed.', when_to_visit: 'When asking for recent events, activity feed, or what happened recently.' } } },
  { screen_id: 'DEVHUB.OVERVIEW.ERRORS_VIOLATIONS', route: '/command-hub/overview/errors-violations/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Errors & Violations', description: 'Error dashboard and governance violations.', when_to_visit: 'When asking about errors, violations, failures, or issues.' } } },
  { screen_id: 'DEVHUB.OVERVIEW.RELEASE_FEED', route: '/command-hub/overview/release-feed/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Release Feed', description: 'Recent releases and version history.', when_to_visit: 'When asking about releases, versions, changelog, or release feed.' } } },

  // ── Admin ──
  { screen_id: 'DEVHUB.ADMIN.USERS', route: '/command-hub/admin/users/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Users', description: 'User management and administration.', when_to_visit: 'When asking about users, user management, user list, or user admin.' } } },
  { screen_id: 'DEVHUB.ADMIN.PERMISSIONS', route: '/command-hub/admin/permissions/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Permissions', description: 'Permission and access control management.', when_to_visit: 'When asking about permissions, access control, or authorization.' } } },
  { screen_id: 'DEVHUB.ADMIN.TENANTS', route: '/command-hub/admin/tenants/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Tenants', description: 'Multi-tenant configuration and management.', when_to_visit: 'When asking about tenants, organizations, or multi-tenancy.' } } },
  { screen_id: 'DEVHUB.ADMIN.CONTENT_MODERATION', route: '/command-hub/admin/content-moderation/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Content Moderation', description: 'Content moderation queue and policies.', when_to_visit: 'When asking about content moderation, moderation queue, or flagged content.' } } },
  { screen_id: 'DEVHUB.ADMIN.IDENTITY_ACCESS', route: '/command-hub/admin/identity-access/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Identity & Access', description: 'Identity management and access policies.', when_to_visit: 'When asking about identity, IAM, access management, or authentication.' } } },
  { screen_id: 'DEVHUB.ADMIN.ANALYTICS', route: '/command-hub/admin/analytics/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Admin Analytics', description: 'Administrative analytics and usage data.', when_to_visit: 'When asking about admin analytics, usage stats, or platform analytics.' } } },

  // ── Operator ──
  { screen_id: 'DEVHUB.OPERATOR.DASHBOARD', route: '/command-hub/operator/dashboard/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Operator Dashboard', description: 'Operator console with conversation intelligence.', when_to_visit: 'When asking for operator dashboard, operator console, or operator view.' } } },
  { screen_id: 'DEVHUB.OPERATOR.TASK_QUEUE', route: '/command-hub/operator/task-queue/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Task Queue', description: 'Operator task queue for pending work.', when_to_visit: 'When asking about task queue, pending tasks, or operator queue.' } } },
  { screen_id: 'DEVHUB.OPERATOR.EVENT_STREAM', route: '/command-hub/operator/event-stream/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Event Stream', description: 'Real-time event stream from the operator.', when_to_visit: 'When asking about event stream, live events, or real-time stream.' } } },
  { screen_id: 'DEVHUB.OPERATOR.DEPLOYMENTS', route: '/command-hub/operator/deployments/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Operator Deployments', description: 'Deployment management from operator view.', when_to_visit: 'When asking about operator deployments or deployment control.' } } },
  { screen_id: 'DEVHUB.OPERATOR.RUNBOOK', route: '/command-hub/operator/runbook/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Runbook', description: 'Operational runbook and procedures.', when_to_visit: 'When asking about runbook, procedures, playbook, or operational guide.' } } },

  // ── Command Hub ──
  { screen_id: 'DEVHUB.COMMAND_HUB.TASKS', route: '/command-hub/tasks/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Tasks', description: 'Developer task board with VTIDs and work items.', when_to_visit: 'When asking for tasks, task board, my tasks, work items, backlog, todo list, or things to do.' } } },
  { screen_id: 'DEVHUB.COMMAND_HUB.LIVE_CONSOLE', route: '/command-hub/live-console/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Live Console', description: 'Live terminal console for real-time logs and commands.', when_to_visit: 'When asking for live console, terminal, logs, command line, or real-time output.' } } },
  { screen_id: 'DEVHUB.COMMAND_HUB.EVENTS', route: '/command-hub/events/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Command Hub Events', description: 'Command Hub event log and activity.', when_to_visit: 'When asking for command hub events, hub activity, or hub event log.' } } },
  { screen_id: 'DEVHUB.COMMAND_HUB.VTIDS', route: '/command-hub/vtids/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'VTIDs', description: 'VTID registry and task identifier management.', when_to_visit: 'When asking about VTIDs, VTID list, task identifiers, or VTID registry.' } } },
  { screen_id: 'DEVHUB.COMMAND_HUB.APPROVALS', route: '/command-hub/approvals/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Approvals', description: 'Pending approvals for PRs, merges, and deployments.', when_to_visit: 'When asking about approvals, pending reviews, PR reviews, merge requests, or things to approve.' } } },

  // ── Governance ──
  { screen_id: 'DEVHUB.GOVERNANCE.RULES', route: '/command-hub/governance/rules/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Governance Rules', description: 'System governance rules and enforcement policies.', when_to_visit: 'When asking about governance, rules, policies, enforcement, or compliance.' } } },
  { screen_id: 'DEVHUB.GOVERNANCE.VIOLATIONS', route: '/command-hub/governance/violations/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Governance Violations', description: 'Logged governance violations and breaches.', when_to_visit: 'When asking about violations, breaches, compliance issues, or rule violations.' } } },
  { screen_id: 'DEVHUB.GOVERNANCE.CONTROLS', route: '/command-hub/governance/controls/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Governance Controls', description: 'Feature flags and system controls.', when_to_visit: 'When asking about controls, feature flags, system toggles, or kill switches.' } } },
  { screen_id: 'DEVHUB.GOVERNANCE.EVALUATIONS', route: '/command-hub/governance/evaluations/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Governance Evaluations', description: 'Safety evaluations and model behavior checks.', when_to_visit: 'When asking about evaluations, safety checks, or model evaluations.' } } },

  // ── Agents ──
  { screen_id: 'DEVHUB.AGENTS.REGISTERED', route: '/command-hub/agents/registered-agents/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Registered Agents', description: 'Registry of all AI agents in the system.', when_to_visit: 'When asking about agents, registered agents, agent list, bots, or AI agents.' } } },
  { screen_id: 'DEVHUB.AGENTS.PIPELINES', route: '/command-hub/agents/pipelines/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Agent Pipelines', description: 'Agent execution pipelines and run history.', when_to_visit: 'When asking about agent pipelines, agent runs, or pipeline status.' } } },
  { screen_id: 'DEVHUB.AGENTS.TELEMETRY', route: '/command-hub/agents/telemetry/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Agent Telemetry', description: 'Agent performance and telemetry data.', when_to_visit: 'When asking about agent telemetry, agent performance, or agent monitoring.' } } },

  // ── OASIS ──
  { screen_id: 'DEVHUB.OASIS.EVENTS', route: '/command-hub/oasis/events/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'OASIS Events', description: 'OASIS event stream — the immutable audit log.', when_to_visit: 'When asking about OASIS, OASIS events, event log, audit log, event stream, or system events.' } } },
  { screen_id: 'DEVHUB.OASIS.VTID_LEDGER', route: '/command-hub/oasis/vtid-ledger/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'VTID Ledger', description: 'VTID lifecycle ledger with full event timeline.', when_to_visit: 'When asking about VTID ledger, task lifecycle, VTID timeline, or task history.' } } },

  // ── Databases ──
  { screen_id: 'DEVHUB.DATABASES.SUPABASE', route: '/command-hub/databases/supabase/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Supabase', description: 'Supabase database management and queries.', when_to_visit: 'When asking about database, supabase, postgres, db, tables, or queries.' } } },
  { screen_id: 'DEVHUB.DATABASES.VECTORS', route: '/command-hub/databases/vectors/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Vectors', description: 'Vector database and embedding storage.', when_to_visit: 'When asking about vectors, embeddings, vector database, or pgvector.' } } },

  // ── Infrastructure ──
  { screen_id: 'DEVHUB.INFRA.SERVICES', route: '/command-hub/infrastructure/services/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Services', description: 'Cloud Run services and infrastructure status.', when_to_visit: 'When asking about services, infrastructure, service health, Cloud Run, or microservices.' } } },
  { screen_id: 'DEVHUB.INFRA.HEALTH', route: '/command-hub/infrastructure/health/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Infrastructure Health', description: 'Infrastructure health monitoring.', when_to_visit: 'When asking about infra health, system health, or health checks.' } } },
  { screen_id: 'DEVHUB.INFRA.SELF_HEALING', route: '/command-hub/infrastructure/self-healing/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Self-Healing', description: 'Self-healing pipeline status and repair history.', when_to_visit: 'When asking about self-healing, auto-repair, healing pipeline, or self-heal status.' } } },
  { screen_id: 'DEVHUB.INFRA.DEPLOYMENTS', route: '/command-hub/infrastructure/deployments/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Deployments', description: 'Deployment history and release management.', when_to_visit: 'When asking about deployments, deploy history, releases, deploy status, or what was deployed.' } } },
  { screen_id: 'DEVHUB.INFRA.LOGS', route: '/command-hub/infrastructure/logs/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Logs', description: 'Application logs and log viewer.', when_to_visit: 'When asking about logs, log viewer, application logs, or error logs.' } } },
  { screen_id: 'DEVHUB.INFRA.CONFIG', route: '/command-hub/infrastructure/config/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Config', description: 'Infrastructure configuration and environment variables.', when_to_visit: 'When asking about config, configuration, env vars, or environment.' } } },

  // ── Security ──
  { screen_id: 'DEVHUB.SECURITY.KEYS_SECRETS', route: '/command-hub/security-dev/keys-secrets/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Keys & Secrets', description: 'API keys, secrets, and credential management.', when_to_visit: 'When asking about secrets, API keys, credentials, keys, or key management.' } } },
  { screen_id: 'DEVHUB.SECURITY.AUDIT_LOG', route: '/command-hub/security-dev/audit-log/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Audit Log', description: 'Security audit trail and access logs.', when_to_visit: 'When asking about audit log, security audit, access log, or who did what.' } } },
  { screen_id: 'DEVHUB.SECURITY.RLS', route: '/command-hub/security-dev/rls-access/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'RLS & Access', description: 'Row-level security and data access policies.', when_to_visit: 'When asking about RLS, row-level security, data access, or access policies.' } } },

  // ── Integrations & Tools ──
  { screen_id: 'DEVHUB.INTEGRATIONS.MCP', route: '/command-hub/integrations-tools/mcp-connectors/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'MCP & CLI', description: 'MCP connectors and CLI tools.', when_to_visit: 'When asking about MCP, CLI, connectors, integrations, or MCP tools.' } } },
  { screen_id: 'DEVHUB.INTEGRATIONS.LLM_PROVIDERS', route: '/command-hub/integrations-tools/llm-providers/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'LLM Providers', description: 'LLM provider configuration and API keys.', when_to_visit: 'When asking about LLM providers, Gemini, Claude, OpenAI, or model providers.' } } },
  { screen_id: 'DEVHUB.INTEGRATIONS.APIS', route: '/command-hub/integrations-tools/apis/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'APIs', description: 'API inventory and endpoint documentation.', when_to_visit: 'When asking about APIs, endpoints, API list, or API documentation.' } } },

  // ── Diagnostics ──
  { screen_id: 'DEVHUB.DIAGNOSTICS.HEALTH_CHECKS', route: '/command-hub/diagnostics/health-checks/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Health Checks', description: 'Endpoint health checks and uptime monitoring.', when_to_visit: 'When asking about health checks, uptime, endpoint health, or service availability.' } } },
  { screen_id: 'DEVHUB.DIAGNOSTICS.LATENCY', route: '/command-hub/diagnostics/latency/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Latency', description: 'Latency monitoring and response time analysis.', when_to_visit: 'When asking about latency, response time, slow endpoints, or performance issues.' } } },
  { screen_id: 'DEVHUB.DIAGNOSTICS.VOICE_LAB', route: '/command-hub/diagnostics/voice-lab/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Voice LAB', description: 'ORB voice session diagnostics and testing.', when_to_visit: 'When asking about voice lab, voice testing, voice debug, ORB diagnostics, voice sessions, or orb lab.' } } },
  { screen_id: 'DEVHUB.DIAGNOSTICS.DEBUG_PANEL', route: '/command-hub/diagnostics/debug-panel/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Debug Panel', description: 'Debug panel for troubleshooting.', when_to_visit: 'When asking about debug, debug panel, troubleshoot, or debugging.' } } },

  // ── Models & Evaluations ──
  { screen_id: 'DEVHUB.MODELS.PLAYGROUND', route: '/command-hub/models-evaluations/playground/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Playground', description: 'Model playground for testing LLM prompts.', when_to_visit: 'When asking about playground, test model, LLM test, prompt testing, or model playground.' } } },
  { screen_id: 'DEVHUB.MODELS.EVALUATIONS', route: '/command-hub/models-evaluations/evaluations/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Model Evaluations', description: 'LLM evaluation results and benchmarks.', when_to_visit: 'When asking about model evaluations, benchmarks, model quality, or eval results.' } } },

  // ── Testing & QA ──
  { screen_id: 'DEVHUB.TESTING.CI_REPORTS', route: '/command-hub/testing-qa/ci-reports/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'CI Reports', description: 'CI/CD pipeline reports and build status.', when_to_visit: 'When asking about CI, build status, pipeline, CI reports, test results, or build failures.' } } },
  { screen_id: 'DEVHUB.TESTING.E2E', route: '/command-hub/testing-qa/e2e/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'E2E Tests', description: 'End-to-end test results and playwright tests.', when_to_visit: 'When asking about E2E tests, end-to-end tests, playwright, or integration testing.' } } },

  // ── Intelligence & Memory ──
  { screen_id: 'DEVHUB.INTELLIGENCE.MEMORY_VAULT', route: '/command-hub/intelligence-memory-dev/memory-vault/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Memory Vault', description: 'Memory items and fact storage inspector.', when_to_visit: 'When asking about memory vault, memory dev, stored memories, or memory inspector.' } } },
  { screen_id: 'DEVHUB.INTELLIGENCE.KNOWLEDGE_GRAPH', route: '/command-hub/intelligence-memory-dev/knowledge-graph/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Knowledge Graph', description: 'Knowledge graph visualization and cognee data.', when_to_visit: 'When asking about knowledge graph, cognee, graph visualization, or entity relationships.' } } },
  { screen_id: 'DEVHUB.INTELLIGENCE.EMBEDDINGS', route: '/command-hub/intelligence-memory-dev/embeddings/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Embeddings', description: 'Embedding vectors and similarity search tools.', when_to_visit: 'When asking about embeddings, vectors, similarity search, or embedding inspector.' } } },

  // ── Docs ──
  { screen_id: 'DEVHUB.DOCS.ARCHITECTURE', route: '/command-hub/docs/architecture/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Architecture', description: 'System architecture documentation.', when_to_visit: 'When asking about architecture, docs, documentation, system design, or architecture docs.' } } },
  { screen_id: 'DEVHUB.DOCS.API_INVENTORY', route: '/command-hub/docs/api-inventory/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'API Inventory', description: 'Complete API endpoint inventory.', when_to_visit: 'When asking about API inventory, all APIs, endpoint list, or API catalog.' } } },
  { screen_id: 'DEVHUB.DOCS.DATABASE_SCHEMAS', route: '/command-hub/docs/database-schemas/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Database Schemas', description: 'Database table schemas and documentation.', when_to_visit: 'When asking about database schemas, table structure, or schema docs.' } } },

  // ── Autopilot ──
  { screen_id: 'DEVHUB.AUTOPILOT.REGISTRY', route: '/command-hub/autopilot/registry/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Autopilot Registry', description: 'Registered autopilot recommendations and their metadata.', when_to_visit: 'When asking about autopilot registry, registered recommendations, or recommendation metadata.' } } },
  { screen_id: 'DEVHUB.AUTOPILOT.SCANNERS', route: '/command-hub/autopilot/scanners/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Autopilot Scanners', description: 'Scanners that produce autopilot recommendations.', when_to_visit: 'When asking about autopilot scanners, recommendation producers, or scanner configuration.' } } },
  { screen_id: 'DEVHUB.AUTOPILOT.RUNS', route: '/command-hub/autopilot/runs/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Autopilot Runs', description: 'History of autopilot execution runs.', when_to_visit: 'When asking about autopilot runs, execution history, or past recommendations.' } } },
  { screen_id: 'DEVHUB.AUTOPILOT.LIVE', route: '/command-hub/autopilot/live/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Autopilot Live', description: 'Live autopilot stream and currently executing actions.', when_to_visit: 'When asking about live autopilot activity or currently running actions.' } } },
  { screen_id: 'DEVHUB.AUTOPILOT.ENGINE', route: '/command-hub/autopilot/engine/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Autopilot Engine', description: 'Autopilot engine configuration and execution policies.', when_to_visit: 'When asking about autopilot engine, execution policies, or engine configuration.' } } },
  { screen_id: 'DEVHUB.AUTOPILOT.GROWTH', route: '/command-hub/autopilot/growth/', category: 'developer', access: 'authenticated', anonymous_safe: false, allowed_roles: ['developer', 'DEV'],
    i18n: { en: { title: 'Autopilot Growth', description: 'Autopilot growth metrics and adoption analytics.', when_to_visit: 'When asking about autopilot growth, adoption metrics, or recommendation analytics.' } } },
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

/**
 * VTID-02770: Alias lookup map. Populated from each entry's `aliases` field
 * plus a small set of derived keys (lowercased screen_id with dots → hyphens,
 * normalized route). First write wins on collision so the canonical entry
 * stays canonical.
 */
const BY_ALIAS: Map<string, NavCatalogEntry> = (() => {
  const map = new Map<string, NavCatalogEntry>();
  for (const entry of NAVIGATION_CATALOG) {
    // Explicit aliases declared on the entry.
    if (entry.aliases) {
      for (const a of entry.aliases) {
        const k = normalizeAlias(a);
        if (k && !map.has(k)) map.set(k, entry);
      }
    }
    // Derived: lowercased screen_id with dots/underscores → hyphens.
    const idKey = normalizeAlias(entry.screen_id.replace(/\./g, '-'));
    if (idKey && !map.has(idKey)) map.set(idKey, entry);
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
 * VTID-02770: Normalize an alias slug for lookup. Lowercases, replaces
 * underscores/spaces with hyphens, strips a leading slash, and trims a
 * trailing slash. Lets `find_partner`, `find-partner`, `Find Partner`,
 * `/find-partner`, and `find-partner/` all resolve to the same key.
 */
function normalizeAlias(slug: string | undefined | null): string {
  if (!slug) return '';
  let s = String(slug).trim().toLowerCase();
  if (s.startsWith('/')) s = s.slice(1);
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  // Treat `_` and spaces as `-` for matching, but keep `.` (catalog screen_ids
  // use dots: `comm.events`).
  s = s.replace(/[\s_]+/g, '-');
  return s;
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
 * VTID-02770: Look up a catalog entry by alias slug.
 *
 * Aliases let Gemini, LiveKit, and legacy email/marketing links emit a
 * shorthand identifier ("find-partner", "events_meetups", "community/events")
 * that resolves to the canonical screen_id without a direct enum match.
 *
 * Three lookup attempts, in order:
 *   1. Exact normalized match against the alias map.
 *   2. Match against the entry's normalized screen_id (so `comm.events` wins).
 *   3. Match against the entry's normalized route (so `/comm/events-meetups`
 *      and `comm/events-meetups` both resolve).
 */
export function lookupByAlias(slug: string | undefined | null): NavCatalogEntry | null {
  if (!slug) return null;
  const key = normalizeAlias(slug);
  if (!key) return null;

  const direct = BY_ALIAS.get(key);
  if (direct) return direct;

  // Fallback: treat the slug as a screen_id form (lowercase, dots).
  const byIdKey = key.replace(/-/g, '.');
  const byId = BY_ID.get(byIdKey.toUpperCase());
  if (byId) return byId;

  // Fallback: treat the slug as a route fragment.
  const candidate = key.startsWith('/') ? key : '/' + key;
  return lookupByRoute(candidate);
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
    role?: string;
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
    // Surface scoping: authenticated callers may only see entries on their
    // surface. Anonymous callers skip the role gate — anonymous_safe carries
    // the access decision for them.
    if (opts.role && !resolveEffectiveRoles(entry).includes(opts.role)) continue;

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

    // VTID-02770: Overlay entries are entity-specific popups (e.g.
    // "open this single meetup as a drawer"). They should NEVER beat the
    // generic destination route (e.g. COMM.EVENTS) for a generic query
    // like "show me events / meetups". Apply a flat down-rank so overlays
    // only surface when the user's phrasing is uniquely overlay-shaped
    // (which the alias map handles), or when no real-route match exists.
    if (entry.entry_kind === 'overlay' && score > 0) {
      score = Math.max(1, score - 12);
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
