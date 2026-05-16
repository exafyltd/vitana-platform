/**
 * A5 (orb-live-refactor): Live API tool catalog.
 *
 * Lifted verbatim from services/gateway/src/routes/orb-live.ts. Same
 * function, same callers, same admin-tool injection. Zero behavior change.
 *
 * The A0.1 tool-catalog characterization test (4 mode/role matrix cells +
 * full snapshot per cell) locks the output of this function on `main` —
 * it caught the snapshot drift when origin/main advanced mid-PR, and
 * will catch any future regression to the catalog shape.
 *
 * Subsequent slices:
 *   - A6 splits `executeLiveApiToolInner()` into per-domain handlers
 *     under `orb/live/tools/handlers/`. The catalog stays here, the
 *     dispatcher moves there.
 *
 * Hard guardrail (from the plan): tool definitions stay declarative.
 * No imperative state, no DB reads, no env reads — those belong with
 * the handlers (A6).
 */

import { ADMIN_TOOL_SCHEMAS } from '../../../services/admin-voice-tools';


/**
 * L2.2b.6 (VTID-03010): Render the same tool catalog as a prose block for
 * embedding in the system instruction. Vertex's Gemini Live receives the
 * structured `tools[0].function_declarations` array via the BidiGenerate
 * setup message, but the LiveKit / livekit-plugins-google path does NOT
 * fully serialize @function_tool decorators into Gemini's
 * function_declarations (smoke-tested: many tool calls never fire even
 * when the agent has the decorator). Embedding the tool catalog as text
 * inside the prompt gives the LLM a backup directory it can read directly
 * — names + descriptions, no parameter schemas (those are still on the
 * @function_tool side; the prompt block exists to make the LLM AWARE the
 * tool exists and what it does).
 *
 * Output shape (one tool per block, blank line between):
 *
 *   ### <name>
 *   <multi-line description>
 *
 * Returns empty string when no tools are declared (anonymous-on-landing).
 * The caller appends a `## AVAILABLE TOOLS` header before this output so
 * the section is discoverable in the prompt.
 */
export function renderAvailableToolsSection(
  mode: 'anonymous' | 'authenticated' = 'authenticated',
  currentRoute?: string,
  activeRole?: string,
): string {
  const tools = buildLiveApiTools(mode, currentRoute, activeRole);
  const decls: Array<{ name?: unknown; description?: unknown }> = [];
  for (const entry of tools as Array<Record<string, unknown>>) {
    const fnDecls = (entry as { function_declarations?: unknown }).function_declarations;
    if (Array.isArray(fnDecls)) {
      for (const d of fnDecls) {
        if (d && typeof d === 'object') decls.push(d as { name?: unknown; description?: unknown });
      }
    }
  }
  if (decls.length === 0) return '';
  const lines: string[] = [];
  for (const d of decls) {
    const name = typeof d.name === 'string' ? d.name : '';
    const description = typeof d.description === 'string' ? d.description : '';
    if (!name) continue;
    lines.push(`### ${name}`);
    if (description) lines.push(description);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}


/**
 * VTID-01224: Build Live API tool declarations for function calling
 * These tools enable dynamic context retrieval during the conversation
 *
 * VTID-NAV: Mode parameter — anonymous sessions get a narrow allowlist
 * (navigator_consult + navigate_to_screen) so onboarding visitors can be
 * guided to public destinations like the Maxina portal. Authenticated
 * sessions get the full set including memory/knowledge/event search.
 */
// Exported for characterization testing (A0.1, orb-live-refactor).
// No behavior change — this is the same function, just made externally
// addressable so the refactor can lock its current output as a contract
// before A5 extracts the tool catalog into orb/live/tools/.
export function buildLiveApiTools(
  mode: 'anonymous' | 'authenticated' = 'authenticated',
  currentRoute?: string,
  activeRole?: string,
): object[] {
  const navigatorTools: any[] = [
    {
      name: 'get_current_screen',
      description: [
        'Return the screen the user is CURRENTLY looking at, as a fresh live',
        'lookup. Always call this tool when the user asks any variation of:',
        '  "where am I?", "which screen is this?", "what page am I on?",',
        '  "what am I looking at?", "wo bin ich?", "welcher Bildschirm ist das?".',
        '',
        'You should also call it after you have just navigated via',
        'navigate_to_screen if the user asks a follow-up about "this page" —',
        'the in-memory location is updated immediately after navigation so',
        'this tool always reflects the freshest screen.',
        '',
        'The result contains:',
        '  - title: the friendly screen title (e.g. "Events & Meetups")',
        '  - route: the raw URL path (do NOT speak this out loud)',
        '  - description: a short description of what the screen is for',
        '  - category: the section of the app (community, health, wallet, ...)',
        '',
        'When answering, speak ONLY the title and the short description in',
        'natural language. Never read the route aloud. If the tool returns',
        '"unknown", tell the user you can see they\'re in the Vitana app but',
        'not which specific screen, and ask them what they\'d like to do.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'navigate',
      description: [
        'Guide the user to the right screen in the Vitana platform. Call this',
        'tool whenever the user wants to go somewhere, find a feature, learn',
        'how to do something, or mentions any screen, page, section, or area',
        'of the app — even indirectly.',
        '',
        'You do NOT need to know which screen to send them to. Just pass the',
        'user\'s words and the backend will find the right destination, search',
        'the knowledge base for how-to guidance, and handle the redirect.',
        '',
        'WHEN TO CALL:',
        '- "open my profile" / "open my wallet" / "open my inbox"',
        '- "where are the podcasts" / "show me my health data"',
        '- "I want to set up a business" / "how do I track my biology?"',
        '- "open the screen with music" / "where is my diary"',
        '- Any request where the user wants to SEE or DO something on a screen',
        '',
        'WHEN NOT TO CALL:',
        '- Pure small talk with no screen destination ("how are you", "thank you")',
        '- Quick factual questions ("what is longevity?")',
        '',
        'WHAT YOU GET BACK:',
        '- GUIDANCE: a short explanation you should speak naturally to the user,',
        '  telling them about the feature and what they can do there.',
        '- NAVIGATING_TO: the screen the user is being taken to (or null if no',
        '  match was found).',
        '- If a redirect is happening, the orb will close automatically after',
        '  you finish speaking. Just speak the guidance naturally — do not add',
        '  a separate transition sentence.',
        '- If NAVIGATING_TO is null, ask the user to clarify what they are',
        '  looking for.',
        '',
        'IMPORTANT: When you speak the guidance, be helpful and warm. Explain',
        'the feature briefly, tell them what they can do on that screen, and',
        'let them know you are taking them there. Example: "The Business Hub',
        'is where you can set up your services and start earning. You\'ll find',
        'a Create button to get started. Let me take you there."',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The user\'s question, request, or intent in their own words. Pass exactly what they said — the backend handles all matching and routing.',
          },
        },
        required: ['question'],
      },
    },
  ];

  if (mode === 'anonymous') {
    // VTID-NAV-ANON-FIX: On landing/portal pages, anonymous sessions get NO
    // tools — the signup-intent regex flow (detectAuthIntent + session_limit_reached)
    // handles navigation there, and Navigator tools competed with it causing
    // double responses.
    //
    // VTID-NAV-TOKEN-FIX: On community pages (any route that isn't / or a
    // portal), an "anonymous" session is almost certainly an authenticated user
    // whose JWT expired mid-session (common on mobile Appilix WebView). Give
    // them the navigator tools so "open my profile" / "open my inbox" still
    // work even if the token refresh hasn't reached the orb widget yet.
    const landingRoutes = ['/', '/maxina', '/alkalma', '/earthlinks', '/auth'];
    const isLandingPage = !currentRoute || landingRoutes.includes(currentRoute);
    if (isLandingPage) {
      return [];
    }
    // Community page with expired token — give navigator tools only
    return [{ function_declarations: navigatorTools }];
  }

  return [
    {
      function_declarations: [
        ...navigatorTools,
        {
          name: 'search_memory',
          description: 'Search the user\'s personal memory and Memory Garden for information they have previously shared or recorded, including personal details, health data, preferences, goals, past conversations, daily diary entries, journal notes, and any other personal records.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query to find relevant memories, diary entries, or personal records',
              },
              categories: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional categories to filter: personal, health, preferences, goals, relationships, conversation, diary, notes',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'search_knowledge',
          description: [
            'Search the Vitana knowledge base for explanations, how-tos, and platform concepts.',
            'Use this WHENEVER the user asks "how does X work?", "what is Y?", "can you explain ...?",',
            '"how do I find/learn/teach/share ...?", "why are matches sparse?", or "what is the privacy here?"',
            '',
            "It's the default tool for any orientation, onboarding, or curious question — first-time users",
            'deserve a real explanation, not a one-line transactional reply. Pull from this knowledge base',
            'BEFORE answering, then synthesize into a 15-30 second voice response (~80-200 words) that',
            'sounds natural, not robotic.',
            '',
            'Topics covered include: matchmaking overview, finding a dance partner, learning dance from',
            'a teacher, offering dance lessons, why early-stage matches are sparse, sharing posts,',
            'privacy in matchmaking, the Open Asks feed, the Vitana Index, longevity research, and the',
            "Vitana platform itself. Supervisors keep adding documents, so always search before assuming",
            "something isn't covered.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: "The search query — paraphrase the user's question into the topical keywords. E.g. \"how do I find a dance partner\" or \"why am I getting no matches\".",
              },
            },
            required: ['query'],
          },
        },
        // Calendar tool — search user's personal calendar
        {
          name: 'search_calendar',
          description: 'Search the user\'s personal calendar for events, appointments, and scheduled activities. Use this when the user asks about their schedule, upcoming events, free time, availability, or wants to know what\'s planned for a specific day or week.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'What to search for in the calendar (e.g., "tomorrow", "this week", "yoga sessions", "free time")',
              },
            },
            required: ['query'],
          },
        },
        // Calendar write tool — create events via voice
        {
          name: 'create_calendar_event',
          description: [
            'Create a new event in the user\'s personal calendar. Use this when the',
            'user asks you to schedule, add, create, or book a meeting, appointment,',
            'activity, or any calendar event.',
            '',
            'IMPORTANT:',
            '- Always confirm the event details with the user BEFORE calling this tool.',
            '- If the user does not specify an end time, default to 1 hour after start.',
            '- Use ISO 8601 format for start_time and end_time (e.g. "2026-04-15T18:00:00Z").',
            '- After creating, confirm the event title and time back to the user.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'The title or name of the event (e.g., "Dinner meeting", "Yoga class", "Doctor appointment")',
              },
              start_time: {
                type: 'string',
                description: 'Start time in ISO 8601 format (e.g. "2026-04-15T18:00:00Z")',
              },
              end_time: {
                type: 'string',
                description: 'End time in ISO 8601 format. If not specified by the user, default to 1 hour after start_time.',
              },
              description: {
                type: 'string',
                description: 'Optional description or notes for the event.',
              },
              location: {
                type: 'string',
                description: 'Optional location of the event.',
              },
              event_type: {
                type: 'string',
                enum: ['personal', 'community', 'professional', 'health', 'workout', 'nutrition'],
                description: 'Type of event. Default to "personal" if unclear.',
              },
            },
            required: ['title', 'start_time'],
          },
        },
        // VTID-01270A: Community & Events voice tools
        {
          name: 'search_events',
          description: 'Search upcoming community events, meetups, and live rooms. Supports filtering by activity/keyword, location, organizer, date range, and price. Call with no parameters to list all upcoming events. For follow-up questions about events already listed, answer from conversation context — do NOT call this tool again.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Activity or keyword to search (e.g., "yoga", "dance", "boat trip", "fitness", "wellness", "coffee"). Searches title, description, and category.',
              },
              location: {
                type: 'string',
                description: 'City, venue, or country to filter by (e.g., "Berlin", "Mallorca", "Germany", "Dubai").',
              },
              organizer: {
                type: 'string',
                description: 'Name of the event organizer or host to filter by.',
              },
              date_from: {
                type: 'string',
                description: 'Start of date range in YYYY-MM-DD format (e.g., "2026-04-01"). Defaults to today.',
              },
              date_to: {
                type: 'string',
                description: 'End of date range in YYYY-MM-DD format (e.g., "2026-04-30").',
              },
              max_price: {
                type: 'number',
                description: 'Maximum price in EUR. Use 0 for free events only.',
              },
              type_filter: {
                type: 'string',
                enum: ['meetup', 'live_room', 'all'],
                description: 'Filter by event type. Defaults to all.',
              },
            },
            required: [],
          },
        },
        {
          name: 'search_community',
          description: 'Search community groups and their activities. Use when the user asks about groups, communities, who to connect with, or community activities.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query for community groups (e.g., "meditation", "runners", "nutrition")',
              },
            },
            required: ['query'],
          },
        },
        // VTID-02754 — Find one specific community member matching a free-text
        // query and redirect the user to that member's profile. Always returns
        // exactly one person; never returns lists.
        {
          name: 'find_community_member',
          description: [
            'Find ONE specific community member matching a free-text question and',
            'open their profile for the user. ALWAYS returns exactly one person —',
            'never a list, never a summary. The tool itself dispatches the',
            'navigation; you only need to read aloud the one-line voice_summary',
            'that the tool returns. Then stop speaking.',
            '',
            'CALL THIS TOOL when the user asks any "who is..." question about the',
            'community, including:',
            '  - Skill / activity:   "who is good at half marathon?"',
            '                        "who plays golf?"',
            '                        "who teaches salsa?"',
            '  - Vitana Index:       "who is the healthiest?"',
            '                        "who has the best sleep?"',
            '                        "who is the fittest?"',
            '  - Soft qualities:     "who is the funniest?"',
            '                        "who is the smartest?"',
            '                        "who is the most inspiring?"',
            '                        "who is the best teacher?"',
            '  - Tenure:             "who is the newest member?"',
            '                        "who is the longest-standing member?"',
            '  - Location:           "who is closest to me?"',
            '                        "who is in my city?"',
            '                        "who is near me?"',
            '  - Composed:           "newest salsa teacher in my city"',
            '',
            'After the tool runs:',
            '  - Read voice_summary aloud (1-2 sentences).',
            '  - DO NOT add any other commentary — the redirect is dispatched',
            '    by the tool itself and the widget is closing.',
            '  - DO NOT mention "I searched", "I looked at", "I found" — the',
            '    voice_summary already says it.',
            '',
            'NEVER use this tool for community groups or events — those have',
            'their own tools (search_community for groups, search_events for',
            'meetups/live rooms).',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The user\'s "who is..." question, in natural language. Pass the question verbatim — the backend handles all interpretation, ranking, and edge cases.',
              },
              excluded_vitana_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'OPTIONAL — only include if the user explicitly says "show me someone else" / "another one" after a previous find_community_member result. Pass the previously-shown vitana_id(s) here so the ranker picks a different person.',
              },
            },
            required: ['query'],
          },
        },
        // VTID-02830 — Find Perfect flagships (deep marketplace + practitioner search)
        {
          name: 'find_perfect_product',
          description: [
            'Recommend the perfect product for the user. Fuses their weakest',
            'Vitana Index pillar + active Life Compass goal + a free-form ask',
            'and any explicit filters (price cap, ingredients to exclude). Returns',
            'top-3 with a rationale. Use for: "find me a product for poor sleep on',
            'travel days", "what supplement should I take for my hydration?", etc.',
            '',
            'Use this for PRODUCTS (supplements, gear, food). For services or',
            'practitioners use find_perfect_practitioner. For people / community',
            'matches use find_community_member.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              goal_text: {
                type: 'string',
                description: 'Free-form description of what the user wants the product to help with.',
              },
              pillar: {
                type: 'string',
                description: 'OPTIONAL — nutrition / hydration / exercise / sleep / mental. Defaults to the user\'s weakest pillar.',
              },
              max_price: { type: 'number', description: 'OPTIONAL — price cap.' },
              exclude_ingredients: {
                type: 'array',
                items: { type: 'string' },
                description: 'OPTIONAL — list of ingredient names the user wants to avoid.',
              },
            },
            required: [],
          },
        },
        {
          name: 'find_perfect_practitioner',
          description: [
            'Recommend the perfect practitioner / coach / doctor for the user.',
            'Multi-criteria: specialty, language, telehealth-ok, price cap, fused',
            'with the active Life Compass goal. Returns top-3 with a rationale.',
            '',
            'Use for: "find me a functional medicine doc who takes telehealth",',
            '"who can coach me on sleep?", "I need a German-speaking nutritionist".',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              specialty: { type: 'string', description: 'e.g. "functional medicine", "nutrition", "therapy".' },
              goal_text: { type: 'string' },
              language: { type: 'string', description: 'OPTIONAL — language code or name, e.g. "en", "de".' },
              telehealth_ok: { type: 'boolean' },
              max_price: { type: 'number' },
            },
            required: [],
          },
        },
        {
          name: 'get_recommendations',
          description: 'Get personalized recommendations for the user including suggested groups, events to attend, and daily matches. Use when the user asks "what should I do?", "any suggestions?", "who should I meet?", or "what events are for me?"',
          parameters: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['community', 'match', 'all'],
                description: 'Type of recommendations. Defaults to all.',
              },
            },
            required: [],
          },
        },
        // VTID-01941 / VTID-01942: Play a song. Backend routes to the right
        // provider based on (a) explicit source in the phrase, (b) user
        // preference (PR 2), (c) what's connected, (d) the in-house Vitana
        // Media Hub as fallback. Model should only pass `source` when the
        // user explicitly names a provider.
        {
          name: 'play_music',
          description: [
            'Play a song, album, or playlist. CALL THIS TOOL IMMEDIATELY',
            'the moment the user asks to play, listen to, hear, or put on',
            'music. Do NOT ask which service to use, do NOT list options,',
            'do NOT confirm anything before calling — the backend picks',
            'the right provider automatically based on the user\'s',
            'preference, their connected accounts, and the Vitana Media',
            'Hub as fallback.',
            '',
            'EXAMPLES — each one triggers the tool with no clarification:',
            '  - "play Beat It by Michael Jackson"',
            '  - "play Human Nature"',
            '  - "play some Whitney Houston"',
            '',
            'ARGUMENTS:',
            '  - query (REQUIRED): the song / artist / phrase the user said,',
            '    minus the word "play". Pass as natural language.',
            '  - source (OPTIONAL): ONLY include this when the user',
            '    explicitly named a provider ("on Spotify", "from Spotify",',
            '    "on YouTube Music", "on Apple Music", "from the Vitana',
            '    hub"). Map to: spotify / google / apple_music / vitana_hub.',
            '    In ALL other cases OMIT source — the backend routes.',
            '',
            'AFTER CALLING — the tool response tells you what happened.',
            'The track is already playing by the time you speak. Keep your',
            'acknowledgement short: "Playing X by Y on YouTube Music."',
            'If the response suggests a default, ask the user if they want',
            'it AFTER the song is playing, not before. NEVER read URLs aloud.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Song / artist / album / playlist in natural language, e.g. "Human Nature by Michael Jackson".',
              },
              source: {
                type: 'string',
                enum: ['spotify', 'google', 'apple_music', 'vitana_hub'],
                description: 'OMIT unless the user explicitly said "on <provider>" or "from <provider>" in this exact request.',
              },
            },
            required: ['query'],
          },
        },
        // VTID-01942 (PR 3): set / clear the user's preferred provider for a
        // capability. Called when the user says things like "make YouTube
        // Music my default", "always play music on Spotify", "don't use
        // Apple Music as default any more".
        {
          name: 'set_capability_preference',
          description: [
            'Set or clear the user\'s default provider for a capability.',
            'Call this when the user tells you which service to use by',
            'default. Examples:',
            '  - "make YouTube Music my default" → capability="music.play", connector_id="google"',
            '  - "always play music on Spotify" → capability="music.play", connector_id="spotify"',
            '  - "use the Vitana hub by default"→ capability="music.play", connector_id="vitana_hub"',
            '  - "stop using Spotify as default"→ capability="music.play", clear=true',
            '',
            'After calling, acknowledge in ONE short sentence',
            '("Got it — YouTube Music is your default for music now.").',
            '',
            'IMPORTANT — if the user just asked to play a song immediately',
            'before saying "yes make that my default", and you had already',
            'played that song, do NOT replay it. If you had NOT played it',
            'yet (e.g. you asked them first), call play_music RIGHT AFTER',
            'this tool with the original query they asked for. Never leave',
            'them without the song they asked for.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              capability: {
                type: 'string',
                description: 'Capability id (e.g. "music.play", "email.send").',
              },
              connector_id: {
                type: 'string',
                enum: ['google', 'spotify', 'apple_music', 'vitana_hub'],
                description: 'Which provider should serve this capability by default.',
              },
              clear: {
                type: 'boolean',
                description: 'True to remove the existing preference entirely. Omit connector_id when set.',
              },
            },
            required: ['capability'],
          },
        },
        // VTID-01943: Gmail read. Routes to email.read capability.
        {
          name: 'read_email',
          description: [
            'Read the user\'s unread emails or emails from a specific sender.',
            'Call this when the user asks things like:',
            '  - "check my emails"',
            '  - "do I have any new emails?"',
            '  - "anything from Sarah today?"',
            '  - "what\'s in my inbox?"',
            '',
            'Pass optional filters: `limit` (default 5 — keep low for voice),',
            '`from` (sender filter, e.g. "sarah@example.com"),',
            '`unread_only` (default true).',
            '',
            'SPEAK THE RESULT SUCCINCTLY. Summarise count + who + subject,',
            'e.g. "You have 3 unread emails: one from Sarah about the',
            'project plan, one from Google about your account, and one',
            'newsletter from Substack. Want me to read any in detail?"',
            'Don\'t read entire message bodies unless the user asks.',
          ].join('\n'),
          parameters: {
            // BOOTSTRAP-ORB-1007-AUDIT: Vertex Live function-declaration schema
            // is the OpenAPI 3.0 SUBSET supported by Gemini — it rejects
            // `default`, `minimum`, `maximum`, and similar JSON-Schema fields
            // with WebSocket close code 1007. Keep constraints in description
            // text instead.
            type: 'object',
            properties: {
              limit: { type: 'integer', description: 'Max emails to return (1-25). Default 5.' },
              from: { type: 'string', description: 'Optional sender filter' },
              unread_only: { type: 'boolean', description: 'Only unread emails. Default true.' },
            },
          },
        },
        // VTID-01943: Calendar list. Routes to calendar.list capability.
        {
          name: 'get_schedule',
          description: [
            'Return the user\'s upcoming calendar events. Call when the user asks:',
            '  - "what\'s on today?"',
            '  - "do I have any meetings tomorrow?"',
            '  - "what does my week look like?"',
            '  - "am I free at 3pm?"',
            '',
            'Pass `days_ahead` — 1 for "today", 2 for "today and tomorrow",',
            '7 for "this week". Default 1.',
            '',
            'Summarise the events: "Today at 10am you have a call with John,',
            'and at 2pm a team sync." For longer horizons, group by day.',
            'Never dump raw timestamps — convert to natural language.',
          ].join('\n'),
          parameters: {
            // BOOTSTRAP-ORB-1007-AUDIT: no default/minimum/maximum (Vertex 1007).
            type: 'object',
            properties: {
              days_ahead: { type: 'integer', description: 'How many days ahead (1-60). Default 1 = today.' },
            },
          },
        },
        // VTID-01943: Calendar create. Routes to calendar.create capability.
        {
          name: 'add_to_calendar',
          description: [
            'Add an event to the user\'s primary calendar. Call when the user says:',
            '  - "put a meeting with Sarah on my calendar at 3pm tomorrow"',
            '  - "schedule a call with the team Friday at 10"',
            '  - "add a reminder for the dentist on Monday at 2pm"',
            '',
            'Required: `title`, `start` (RFC3339, e.g. "2026-04-21T15:00:00+02:00").',
            '`end` defaults to start + 1h. Optional: `description`, `attendees` (emails).',
            '',
            'You MUST resolve relative time phrases ("tomorrow at 3pm") into',
            'an absolute RFC3339 string in the user\'s local timezone before',
            'calling. If ambiguous, ask.',
            '',
            'Acknowledge briefly: "Added — meeting with Sarah tomorrow at 3pm."',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              start: { type: 'string', description: 'RFC3339 start time' },
              end: { type: 'string', description: 'RFC3339 end (default: start + 1h)' },
              description: { type: 'string' },
              attendees: { type: 'array', items: { type: 'string' } },
            },
            required: ['title', 'start'],
          },
        },
        // VTID-02047: Unified Feedback Pipeline — voice claim/bug/support intake.
        // VTID-02047 voice channel-swap (bidirectional): every persona has
        // this tool so the user can navigate between Vitana and her
        // colleagues by voice. Use cases:
        //   - User to Vitana:    "switch me to Devon" / "ich möchte mit Devon
        //                        sprechen" → switch_persona({to:'devon'})
        //   - User to Devon:     "connect me back to Vitana" / "zurück zu
        //                        Vitana" → switch_persona({to:'vitana'})
        //   - User to Sage:      "actually I have a billing question" →
        //                        switch_persona({to:'atlas'})
        // This tool DOES NOT create a ticket. report_to_specialist creates a
        // ticket AND swaps. switch_persona is just navigation.
        {
          name: 'switch_persona',
          description: [
            'Switch the active persona on this voice call to another colleague',
            '(or back to Vitana). Call ONLY when the user EXPLICITLY asks to',
            'talk to a different person by name — "switch me to Devon", "back',
            'to Vitana please", "I want to talk to Atlas about my refund',
            'instead". Voice + persona swap in the same call, no ticket filed.',
            '',
            'Personas: vitana (life companion + instruction manual), devon',
            '(bugs), sage (general support), atlas (marketplace claims), mira',
            '(account issues).',
            '',
            'AFTER calling: speak ONE short bridge sentence in your own',
            'natural words. ANNOUNCE the handoff — never INTRODUCE the new',
            'persona. ("I will bring Devon in" — yes. "Hi, here is Devon"',
            '— NO, that is Devon\'s job to say in his own voice.) Vary your',
            'phrasing every time, never recite a template. Then STOP.',
            '',
            'CRITICAL — never call this for instruction-manual questions',
            '("how does X work", "what is X", "explain X", "show me", "I am',
            'new"). Those are answered by Vitana inline. Specialists handle',
            'BROKEN STATE (bugs, claims, account issues) only.',
            '',
            'Specialists CAN ONLY pass to=\'vitana\' — sideways forwards to',
            'a peer specialist are server-blocked. Once a conversation has',
            'used 1 forward + 1 return, further forwards are also blocked.',
            '',
            'Do NOT use this to file a NEW bug/claim/support ticket — for',
            'that use report_to_specialist (creates ticket AND swaps).'
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              to: {
                type: 'string',
                // VTID-02651: enum is intentionally NOT hardcoded. Persona
                // keys are data-driven from agent_personas. The handler
                // validates against the live registry at exec time so any
                // newly-added specialist becomes a valid switch target with
                // zero code change. Default keys: vitana (receptionist),
                // devon, sage, atlas, mira. New specialists added by INSERT.
                description: 'Target persona key (e.g. vitana, devon, sage, atlas, mira, or any other active key from agent_personas). Use vitana to hand the user back to the receptionist.',
              },
              reason: {
                type: 'string',
                description: 'One short sentence on why the swap (e.g. "user wants to ask about longevity again", "this is a finance question, not tech").',
              },
            },
            required: ['to'],
          },
        },
        // Vitana calls this when the user wants to report something outside her
        // domain (bugs, support questions, refunds, account issues). The tool
        // creates a feedback_tickets row routed to the matching specialist
        // (Devon/Sage/Atlas/Mira). Vitana then speaks a short bridge sentence
        // confirming the handoff.
        {
          name: 'report_to_specialist',
          description: [
            'File a customer-support ticket and hand the call to a specialist',
            '(Devon/Sage/Atlas/Mira). This is RARE — typically less than 5%',
            'of conversations. You ARE the instruction manual; almost every',
            'question is yours to answer.',
            '',
            'YOU MUST PROPOSE BEFORE CALLING. Even when forwarding is warranted,',
            'first say something like "Shall I bring in Devon to file this?"',
            'and wait for the user to say yes. Implicit consent does NOT count.',
            'Vary the proposal phrasing every time.',
            '',
            'CALL ONLY WHEN ALL THREE are true:',
            '  (1) the user has described a CONCRETE PROBLEM (bug, broken',
            '      state, refund, account lockout, claim) — not a question',
            '      about how something works,',
            '  (2) the user has EXPLICITLY agreed to be connected to a',
            '      specialist (after you proposed it), and',
            '  (3) you can write a SPECIFIC `summary` (>= 15 words) that',
            '      describes WHAT broke, on WHICH screen/feature, with the',
            '      user\'s own words. If you cannot — because the user only',
            '      said "I want to report a bug" without details — DO NOT',
            '      CALL THIS TOOL YET. Instead ask ONE follow-up question:',
            '      "What\'s breaking — which screen or feature?" Get the',
            '      details, THEN call this tool. A vague summary causes the',
            '      specialist to invent the issue, which is worse than not',
            '      forwarding at all. Generic summaries like "user wants to',
            '      report a bug" are FORBIDDEN.',
            '',
            'NEVER CALL for any of these — answer them yourself inline using',
            'search_knowledge first:',
            '  - "How does X work?" / "What is X?" / "Explain X"',
            '  - "Show me how to use X" / "How do I X?" / "Teach me"',
            '  - "Tell me about X" / "I want to learn X" / "I am new"',
            '  - "Help me understand X" / "Walk me through X"',
            '  - Any health, longevity, matchmaking, community, business,',
            '    diary, calendar, or general life-companion question',
            '  - Anything that is a learning question, not a broken-state',
            '    report. First-time users asking how to use the diary is a',
            '    teaching moment, NOT a customer-support ticket.',
            '',
            'GATE-A enforcement: the backend re-checks the user\'s actual',
            'recent words (not your summary). If the gate returns STAY_INLINE,',
            'do NOT mention the routing decision out loud — silently answer',
            'the question. Same if the conversation\'s forward budget is',
            'exhausted (max 1 forward + 1 return per conversation).',
            '',
            'AFTER A FORWARD FIRES: speak ONE short bridge sentence in your',
            'own natural words. ANNOUNCE the handoff — never INTRODUCE the',
            'specialist ("Hi, here is Devon" — that is DEVON\'S job in his',
            'own voice). Vary your phrasing every time, never recite a',
            'template. Then STOP — the next voice is the specialist\'s.'
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['bug', 'ux_issue', 'support_question', 'account_issue', 'marketplace_claim', 'feature_request', 'feedback'],
                description: 'Best classification of what the user is reporting. Pick the closest match.',
              },
              specialist_hint: {
                type: 'string',
                // VTID-02651: NOT hardcoded — backend validates against the
                // agent_personas registry. Default specialists: devon (bugs/
                // UX), sage (support), atlas (marketplace/finance), mira
                // (account). New specialists added by INSERT.
                description: 'Optional: which specialist should own this (e.g. devon, sage, atlas, mira, or any other active key from agent_personas.handles_kinds). The backend re-checks via the keyword router and falls back to the kind→handles_kinds match if the hint is empty or unknown.',
              },
              summary: {
                type: 'string',
                description: 'CONCRETE one-paragraph summary using the user\'s OWN WORDS. Must include: what broke (the symptom), where (which screen/feature/flow), and any specifics the user gave (error message, order id, account email, time of day, etc). Minimum 15 words. FORBIDDEN: placeholder summaries like "user wants to report a bug" or "user has an account issue" or "user has a question". If you do not have enough specifics, ASK the user one diagnostic question first and call this tool only after you have a real description. A vague summary causes the specialist to hallucinate the issue and forces the user to correct fiction — worse than not forwarding at all.',
              },
            },
            required: ['kind', 'summary'],
          },
        },
        // VTID-01943: Contacts search. Routes to contacts.read capability.
        {
          name: 'find_contact',
          description: [
            'Find a contact by name or partial email. Call when the user asks:',
            '  - "what\'s Sarah\'s email?"',
            '  - "find John\'s phone number"',
            '  - "who is my dentist?"',
            '  - "do I have a contact for the plumber?"',
            '',
            'Pass `query` (substring). If the user asks for a generic list',
            '("show my contacts"), omit query and cap `limit` at 10.',
            '',
            'Speak naturally: "Sarah Jones — email sarah@example.com,',
            'phone +1 555-0100." If multiple matches, say so and ask which.',
          ].join('\n'),
          parameters: {
            // BOOTSTRAP-ORB-1007-AUDIT: no default/minimum/maximum (Vertex 1007).
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Name / email / phone substring' },
              limit: { type: 'integer', description: 'Max contacts to return (1-50). Default 10.' },
            },
          },
        },
        // BOOTSTRAP-ORB-DELEGATION-ROUTE: Delegate a question to another AI
        // the user has connected via Settings → Connected Apps (ChatGPT,
        // Claude, or Google AI). Vitana speaks the result in its own voice.
        // The user never sees which AI answered — it's pure backend routing.
        {
          name: 'consult_external_ai',
          description: [
            'Forward a question to one of the user\'s connected external AI',
            'accounts (ChatGPT, Claude, or Google AI / Gemini via the user\'s',
            'own API key) and return the answer. Vitana speaks the result in',
            'its OWN voice — never mention which AI produced the answer, and',
            'never say "Claude says" / "ChatGPT says".',
            '',
            'CALL THIS TOOL WHEN:',
            '  - the user explicitly names a provider ("ask ChatGPT …",',
            '    "what does Claude think about …", "frag Claude …")',
            '  - the task class strongly matches another provider\'s strength',
            '    and the user has that provider connected (e.g. long code',
            '    review → claude; image description of a supplied URL →',
            '    chatgpt with vision)',
            '  - the user asks for a "second opinion" on an answer',
            '',
            'DO NOT CALL WHEN:',
            '  - the question is about Vitana, the user\'s memory, their',
            '    calendar, events, or any internal tool you already have —',
            '    answer those yourself',
            '  - the user did not ask for an external opinion and your own',
            '    answer is sufficient',
            '',
            'ARGUMENTS:',
            '  - question (REQUIRED): a self-contained prompt. Do not rely',
            '    on Vitana-internal context; include whatever the external',
            '    AI needs to answer.',
            '  - provider_hint (OPTIONAL): include ONLY when the user named',
            '    a provider. openai = ChatGPT, anthropic = Claude,',
            '    google-ai = Google AI. Omit to let the router pick.',
            '  - task_class (OPTIONAL): hint the router toward a provider',
            '    whose strengths match the task.',
            '',
            'If the user has not connected any external AI, the tool',
            'returns a clear signal — acknowledge briefly ("you haven\'t',
            'connected an external AI yet") and answer yourself.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'Self-contained question to forward to the external AI.',
              },
              provider_hint: {
                type: 'string',
                enum: ['chatgpt', 'claude', 'google-ai'],
                description: 'Internal ID of the provider the user named. OMIT unless named.',
              },
              task_class: {
                type: 'string',
                enum: ['code', 'reasoning', 'creative', 'factual', 'summarization', 'long_context', 'vision', 'multilingual'],
                description: 'Kind of task, so the router can pick the best connected provider.',
              },
            },
            required: ['question'],
          },
        },
        // L2.2b.6 (VTID-03010) — Life Compass read tool. The Life Compass is
        // the user's authoritative long-term direction (goal + why + target
        // date). Without this tool the model has no way to answer "what is
        // my Life Compass goal?" with the canonical value — it either
        // invents one from prior conversation or denies access.
        {
          name: 'get_life_compass',
          description: [
            "Return the user's active Life Compass — the one-sentence long-term",
            'direction they set in Settings. Includes:',
            '  - goal: the current long-term goal text',
            '  - why: motivation / reasoning',
            '  - target_date: optional deadline / horizon',
            '',
            'CALL THIS WHEN the user asks any variation of:',
            '  - "What is my Life Compass?" / "Was ist mein Life Compass?"',
            '  - "What\'s my Life Compass goal?" / "Was ist mein Lebenskompass-Ziel?"',
            '  - "What am I working toward?" / "Worauf arbeite ich hin?"',
            '  - "Remind me what my goal is" / "Erinnere mich an mein Ziel"',
            '  - "What\'s my long-term direction?"',
            '',
            'If the row exists with a goal, narrate it warmly and connect the',
            "user's question or current plan back to the goal. If `available:",
            'false` with reason `not_set`, gently offer to walk them through',
            "setting one up — do NOT say 'I don't have access'. If reason is",
            '`life_compass_not_deployed`, the feature is off in this environment',
            "— acknowledge honestly that the feature isn't enabled here.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {},
          },
        },
        // ─── BOOTSTRAP-ORB-INDEX-AWARENESS-R4 — Vitana Index tools (5-pillar) ───
        {
          name: 'get_vitana_index',
          description: [
            'Return the user\'s current Vitana Index with the canonical 5-pillar',
            'breakdown: total score (0-999), tier (Starting / Early / Building /',
            'Strong / Really good / Elite), all 5 pillars (Nutrition, Hydration,',
            'Exercise, Sleep, Mental — each 0-200), 7-day trend, weakest pillar',
            'with sub-score explanation (baseline / completions / connected data /',
            'streak), balance factor, and aspirational distance to Really-good.',
            '',
            'CALL THIS WHEN the user asks:',
            '  - "What is my Vitana Index?" / "Was ist mein Vitana Index?"',
            '  - "What\'s my score / tier?" / "Welchen Tier habe ich?"',
            '  - "How am I doing?" / "Wie stehe ich?" (when health context is the topic)',
            '',
            'DO NOT CALL for generic "what IS the Vitana Index" (no "my") —',
            'that\'s a platform explanation, use search_knowledge instead.',
            '',
            'The [HEALTH] block in the system prompt usually has the same info;',
            'calling this tool gets the freshest snapshot and returns it in a',
            'single structured object you can read aloud naturally.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_index_improvement_suggestions',
          description: [
            'Return 2-3 concrete actions the user can take to improve their',
            'Vitana Index, ranked by predicted contribution to a specific pillar.',
            'Each suggestion includes a title, the pillar(s) it lifts, and a',
            'magnitude from the recommendation\'s contribution_vector.',
            '',
            'CALL THIS WHEN the user asks:',
            '  - "How can I improve my Index?" / "Wie verbessere ich meinen Index?"',
            '  - "What\'s holding me back?" / "Was hält mich zurück?"',
            '  - "What should I focus on?" / "Worauf soll ich mich konzentrieren?"',
            '  - "Which pillar needs work?" / "Welche Säule brauche ich?"',
            '',
            'If the user names a pillar ("help me with Sleep"), pass the pillar',
            'argument. Otherwise omit it and the tool targets the weakest pillar',
            'automatically — OR, when the balance factor is below 0.9, targets',
            'the imbalance itself (lifting the weakest pillar moves the balance',
            'dampener, which moves the whole score).',
            '',
            'Speak the suggestions naturally — "a ten-minute morning meditation',
            'would lift Mental by three points" — never read raw JSON.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              pillar: {
                type: 'string',
                enum: ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'],
                description: 'Optional pillar to focus on. Omit to target the weakest pillar automatically.',
              },
              limit: {
                type: 'integer',
                description: 'Max suggestions to return. Default 3.',
              },
            },
          },
        },
        {
          name: 'create_index_improvement_plan',
          description: [
            'Build a multi-event calendar plan that targets a weak pillar of',
            'the user\'s Vitana Index, then write the events to their calendar',
            'directly (autonomous — no per-event confirmation). Returns a',
            'summary of what was scheduled for you to announce.',
            '',
            'CALL THIS WHEN the user asks:',
            '  - "Make me a plan to improve my Index"',
            '  - "Mach mir einen Plan für meinen Index"',
            '  - "Schedule a routine for me" / "Plan mir eine Routine"',
            '  - "Add things to my calendar to lift [pillar]"',
            '',
            'This is AUTONOMOUS by design — you do NOT need per-event',
            'confirmation. Announce clearly in voice what you just scheduled',
            '("I\'ve added three movement sessions this week and two',
            'mindfulness blocks next week to lift your Sleep pillar").',
            '',
            'If the user names a pillar (one of nutrition / hydration / exercise',
            '/ sleep / mental), pass it. Otherwise the tool targets the weakest',
            'pillar automatically. Days defaults to 14 (2 weeks), actions_per_week',
            'defaults to 3.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              pillar: {
                type: 'string',
                enum: ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'],
                description: 'Optional pillar to focus on. Omit to target weakest automatically.',
              },
              days: {
                type: 'integer',
                description: 'How many days forward to schedule. Default 14.',
              },
              actions_per_week: {
                type: 'integer',
                description: 'Rough frequency. Default 3.',
              },
            },
          },
        },
        // ─── VTID-01983 — save_diary_entry: voice diary logging ───
        {
          name: 'save_diary_entry',
          description: [
            'Save a Daily Diary entry on the user\'s behalf when they say',
            'they did something or want to track something. Then celebrate',
            'inline using the returned pillar deltas — see the override',
            'rules block (rule M).',
            '',
            'CALL THIS WHEN the user says any of:',
            '  - "Log my diary: …" / "Trag in mein Tagebuch ein: …"',
            '  - "I had …" / "Ich hatte …" / "I drank …" / "I ate …"',
            '  - "Track my [water / hydration / meal / breakfast / lunch /',
            '     dinner / workout / walk / run / sleep / meditation]"',
            '  - "Note that I …" / "Note for today: …"',
            '  - "Just had …" — even casual mentions',
            '',
            'IMPORTANT: pass the user\'s VERBATIM words as raw_text. The',
            'gateway runs a pattern-matching extractor on the text to detect',
            'water (1L → 1000ml), meals (breakfast / lunch / Frühstück /',
            'Mittagessen → meal_log count), exercise, sleep, meditation.',
            'DO NOT summarise, paraphrase, or translate. The extractor needs',
            'the original phrasing to catch every signal.',
            '',
            'Returns:',
            '  - health_features_written: number of structured rows written',
            '    to health_features_daily',
            '  - pillars_after: full Vitana Index pillar values after the',
            '    diary entry was applied',
            '  - index_delta: per-pillar lift the diary entry produced',
            '',
            'Use index_delta to celebrate. See override rule M for the',
            'exact response shape ("Done — Hydration up, you\'re at <total>").',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              raw_text: {
                type: 'string',
                description: 'The user\'s verbatim words. Do NOT summarise or rephrase. Multi-language OK.',
              },
              entry_date: {
                type: 'string',
                description: 'Optional YYYY-MM-DD. Defaults to today.',
              },
            },
            required: ['raw_text'],
          },
        },
        // ─── VTID-02601 — set_reminder: voice-create a one-shot reminder ───
        {
          name: 'set_reminder',
          description: [
            "Set a one-time reminder when the user asks. CRITICAL: when the user says",
            "'remind me at X to Y', 'set a reminder for Z', 'erinnere mich um X', or similar,",
            "you MUST call this tool. Do NOT tell the user 'okay, I'll remind you' without",
            "calling this tool — without the tool call, NO reminder is created.",
            '',
            "You compute the absolute UTC timestamp yourself from the user's words and",
            "their local timezone (provided in your system context as user_tz). Examples:",
            "  'today at 8pm'        → user's tz, today, 20:00 → convert to UTC ISO",
            "  'in 2 hours'          → now + 2h ISO",
            "  'tomorrow morning'    → ASK 'what time tomorrow morning?' before calling",
            '',
            "If a phrase is ambiguous (vague time, no day), ASK the user to clarify",
            "before calling. Do not guess.",
            '',
            "Generate `spoken_message` as a friendly sentence in the user's language",
            "that will be spoken aloud at fire time (e.g. 'Time to take your magnesium',",
            "'Zeit für deine Magnesium-Tabletten').",
            '',
            "After the tool returns, confirm verbally with result.human_time and the",
            "action_text (e.g. 'Okay, I'll remind you at 8 PM to take your magnesium.').",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              action_text: {
                type: 'string',
                description: "Short label, max 60 chars. e.g. 'Take magnesium'",
              },
              spoken_message: {
                type: 'string',
                description: "Friendly sentence to speak aloud at fire time, in the user's language.",
              },
              scheduled_for_iso: {
                type: 'string',
                description: 'Absolute UTC ISO 8601 timestamp. Min 60s in future, max 90 days out.',
              },
              description: {
                type: 'string',
                description: 'Optional extended details',
              },
            },
            required: ['action_text', 'spoken_message', 'scheduled_for_iso'],
          },
        },
        // ─── VTID-02601 — find_reminders: read-only lookup ───
        {
          name: 'find_reminders',
          description: [
            "Search the user's active reminders by free-text query. Use BEFORE delete_reminder",
            "to find which reminder the user means, and to read back the count when they say",
            "'delete all'. Returns up to 10 matches.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: "Free-text. Empty string = all active reminders.",
              },
              include_fired: {
                type: 'boolean',
                description: 'Include already-fired but unacked reminders. Default false.',
              },
            },
            required: ['query'],
          },
        },
        // ─── VTID-02601 — delete_reminder: destructive, requires verbal confirmation ───
        {
          name: 'delete_reminder',
          description: [
            "Delete one reminder OR all the user's reminders. CRITICAL SAFETY RULES:",
            '',
            "1. You MUST verbally confirm before calling this tool. Say something like:",
            "   - single: 'Are you sure you want to delete the magnesium reminder at 8pm?'",
            "   - all:    'Are you sure you want to delete all 5 of your reminders?'",
            '',
            "2. Only call this tool with confirmed=true AFTER the user explicitly says",
            "   yes / ja / sí / yes please / definitely / go ahead. Vague answers like",
            "   'maybe' or 'I think so' are NOT confirmation — re-ask.",
            '',
            "3. NEVER skip step 1 even if the user sounds urgent. Deleting reminders",
            "   is destructive and the user wants you to double-check.",
            '',
            "4. For single deletion: first call find_reminders to get the reminder_id.",
            "   For 'delete all': call find_reminders with empty query first, read back",
            "   the count in the confirmation question.",
            '',
            "5. Soft delete only — sets status='cancelled', user can recover via UI.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['single', 'all'],
                description: "'single' = one reminder by id; 'all' = all active reminders",
              },
              reminder_id: {
                type: 'string',
                description: "Required when mode='single'. UUID from find_reminders result.",
              },
              confirmed: {
                type: 'boolean',
                description: 'Must be true. Set ONLY after explicit user yes.',
              },
              user_confirmation_phrase: {
                type: 'string',
                description: "Verbatim user phrase that confirmed (e.g. 'yes, delete it'). For audit.",
              },
            },
            required: ['mode', 'confirmed', 'user_confirmation_phrase'],
          },
        },
        // ─── BOOTSTRAP-PILLAR-AGENT-Q — per-pillar agent Q&A dispatch ───
        {
          name: 'ask_pillar_agent',
          description: [
            'Route a per-pillar deep question to the matching specialised',
            'pillar agent (Nutrition / Hydration / Exercise / Sleep / Mental).',
            'The agent grounds the answer in the user\'s LIVE pillar data',
            '(current sub-scores: baseline / completions / connected data /',
            'streak) AND cites the relevant Book of the Vitana Index chapter.',
            '',
            'CALL THIS WHEN the user asks about a specific pillar:',
            '  - "How is my sleep?" / "Wie steht mein Schlaf?"',
            '  - "Why is my nutrition low?" / "Warum ist meine Ernährung niedrig?"',
            '  - "What\'s holding back my exercise score?"',
            '  - "How do I improve my mental pillar?"',
            '',
            'Pass `pillar` when the user\'s phrasing is unambiguous; OMIT it',
            'and the tool will detect the pillar from `question`. If detection',
            'fails and `pillar` is omitted, the tool returns null — voice should',
            'then fall back to search_knowledge against the Book.',
            '',
            'Speak the returned `text` naturally and cite the Book chapter.',
            'NEVER read raw JSON. NEVER echo a retired pillar name (Physical,',
            'Social, Environmental, Prosperity) — the tool already aliases',
            'those silently.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The user\'s natural-language question, verbatim. Used for pillar detection if `pillar` is omitted.',
              },
              pillar: {
                type: 'string',
                enum: ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'],
                description: 'Optional explicit pillar. Omit to auto-detect from question text.',
              },
            },
            required: ['question'],
          },
        },
        // ─── BOOTSTRAP-TEACH-BEFORE-REDIRECT — explanation-first dispatch ───
        {
          name: 'explain_feature',
          description: [
            'Return the canonical voice-friendly explanation of a Vitana feature',
            'or how-to topic (manual hydration logging, Daily Diary dictation,',
            'connecting trackers, what Autopilot is, how to improve the Index,',
            'etc.). Returns summary + ordered steps + a redirect offer the',
            'user can accept by saying yes.',
            '',
            'CALL THIS WHEN the user shows TEACH-INTENT phrasing — examples:',
            '  - "Explain X" / "Erkläre mir X"',
            '  - "Tell me about X" / "Tell me how X works"',
            '  - "Show me how to <verb>" (NOT "show me the <noun>")',
            '  - "How does X work" / "Wie funktioniert X"',
            '  - "How do I <action>" / "How can I use X" (TEACH-THEN-NAV — speak',
            '     a brief explanation, then offer redirect)',
            '  - "I don\'t understand X" / "Ich verstehe X nicht"',
            '  - "I\'m new to this" / "Ich bin neu hier"',
            '',
            'DO NOT CALL when the user clearly wants navigation:',
            '  - "Open <thing>" / "Öffne <thing>"',
            '  - "Go to <thing>" / "Take me to <thing>"',
            '  - "Show me the <screen|page|section>" / "Zeig mir den Bildschirm"',
            '  - "I want to see the <thing>"',
            'Those are NAVIGATE-ONLY — call the navigation tool instead.',
            '',
            'Speak the returned summary_voice_<lang> verbatim, then read each',
            'item of steps_voice_<lang> in order. End with the redirect_offer_<lang>.',
            'Only call the navigation tool with redirect_route AFTER the user',
            'confirms (yes / ja / open it / do it).',
            '',
            'If found=false, fall back to search_knowledge against the',
            'kb/vitana-system/how-to/ corpus.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description: 'The user\'s natural-language topic, verbatim. Used for canonical-topic resolution.',
              },
              mode: {
                type: 'string',
                enum: ['teach_only', 'teach_then_nav'],
                description: 'Bucket per the intent classifier. teach_only = read FULL steps, no redirect. teach_then_nav = read concise steps + redirect_offer at end.',
              },
            },
            required: ['topic'],
          },
        },
        // ─── VTID-01967 — Vitana ID voice messaging ───
        // Three tools that let the user say "send a message to alex3700"
        // or "share this link with maria2307" and have ORB resolve the
        // recipient, confirm verbally, and send. These tools enforce a
        // strict confirmation contract: ALWAYS resolve first, ALWAYS
        // read back, ONLY send on explicit verbal confirmation.
        {
          name: 'resolve_recipient',
          description: [
            'Resolve a spoken recipient name or Vitana ID to a real user.',
            '',
            'YOU MUST CALL THIS before any reply about whether a person',
            'exists — including saying you can\'t find them. The ONLY way',
            'to honestly tell the user "I can\'t find that person" is to',
            'receive an empty candidates array from this tool. Without',
            'calling, you have no contact list to consult and you will',
            'hallucinate. Do not infer absence from your own knowledge.',
            '',
            'Trigger phrases (call this on ALL of them):',
            '  - "send a message to X" / "text X" / "tell X that ..."',
            '  - "share this with X" / "invite X" / "introduce me to X"',
            '  - "is X here?" / "do we have someone called X?"',
            '',
            'Spoken_name handling for hint phrases:',
            '  - User says "Maria, I think it\'s maria6": pass spoken_name="maria6"',
            '    first (the Vitana ID is the strongest signal). If empty,',
            '    retry with spoken_name="maria".',
            '  - User says "@alex3700": pass spoken_name="alex3700" (the',
            '    resolver strips leading @).',
            '  - User says "Daniela": pass spoken_name="Daniela".',
            '',
            'Returns ranked candidates. Each has:',
            '  - user_id (opaque UUID — pass to send_chat_message / share_link)',
            '  - vitana_id (speakable, e.g. "alex3700" — read this to the user)',
            '  - display_name (their full name)',
            '  - score (0.00-1.25; 1.0 = exact vitana_id match)',
            '  - reason ("vitana_id_exact" | "legacy_handle" | "fuzzy_name" | "fuzzy_chat_peer")',
            '',
            'Also returns top_confidence and ambiguous (boolean).',
            '',
            'BEHAVIOR:',
            '  1. If candidates is empty: tell the user you couldn\'t find',
            '     anyone matching that name and ask them to repeat or spell',
            '     the Vitana ID.',
            '  2. If ambiguous=false AND top_confidence >= 0.85 AND only ONE',
            '     candidate: silently pick candidates[0] and proceed to step 4.',
            '  3. If ambiguous=true OR multiple candidates: read up to 3',
            '     options to the user — "I see {N} matches: @<vid1>',
            '     ({display_name1}), @<vid2> ({display_name2}). Which one?"',
            '     Wait for them to pick by Vitana ID, by name, or by',
            '     position ("the first one", "Daniela Müller").',
            '  4. After a recipient is chosen, NEVER call send_chat_message',
            '     or share_link directly — first read the message back to',
            '     the user verbatim and ask "say send to confirm or cancel',
            '     to stop". Only on explicit confirmation, call the send',
            '     tool.',
            '',
            'NEVER resolve to the user\'s own ID — the resolver excludes self.',
            'NEVER skip this step before sending; the send tools assume a',
            'pre-resolved user_id from this call.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              spoken_name: {
                type: 'string',
                description: 'The recipient name / Vitana ID exactly as the user said it. Examples: "Daniela", "alex3700", "@alex3700", "Branislav". Strip leading @ if present (the resolver normalizes).',
              },
              limit: {
                type: 'integer',
                description: 'Maximum candidates to return (default 5). Keep low for voice — 3 is plenty.',
              },
            },
            required: ['spoken_name'],
          },
        },
        {
          name: 'send_chat_message',
          description: [
            'Send a direct message to another Vitana user. ONLY call this',
            'after resolve_recipient has returned a candidate AND the user',
            'has verbally confirmed both the recipient AND the message body',
            '(e.g. "yes send it", "send", "confirm", "ja schick es").',
            '',
            'NEVER call this without resolve_recipient first.',
            'NEVER auto-fire on "I want to message X" — always read back and wait.',
            '',
            'After a successful send, acknowledge briefly: "Sent to @<vid>."',
            'If the response says rate_limited, tell the user: "I can\'t send',
            'any more messages this session — please open the app to continue."',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              recipient_user_id: {
                type: 'string',
                description: 'Opaque user_id from resolve_recipient candidates[i].user_id. Never derive this any other way.',
              },
              recipient_label: {
                type: 'string',
                description: 'The vitana_id of the recipient, used in the OASIS audit trail and acknowledgement (e.g. "alex3700"). Pass candidates[i].vitana_id verbatim.',
              },
              body: {
                type: 'string',
                description: 'The message body, exactly as the user dictated it. Do not rephrase or summarize.',
              },
            },
            required: ['recipient_user_id', 'recipient_label', 'body'],
          },
        },
        {
          // V2 — Proactive Initiative Engine
          name: 'activate_recommendation',
          description: [
            'Activate an Autopilot recommendation on the user\'s behalf —',
            'marks the recommendation as activated and brings it to the',
            'top of their active list. Use ONLY when the user has consented',
            'to a Proactive Initiative offer where the on_yes_tool is',
            '`activate_recommendation`. The recommendation id is pre-picked',
            'at initiative-resolution time — pass it through unchanged.',
            '',
            'After success, speak the sanctioned celebratory close from the',
            'initiative\'s `build_voice_on_complete` template.',
            '',
            'Returns { ok, title, completion_message }. If ok=false, briefly',
            'acknowledge ("Hmm, couldn\'t schedule that one") and offer to',
            'open the Autopilot screen instead via navigate_to_screen.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description:
                  'The recommendation id from the initiative target. Pass verbatim — never construct or guess it.',
              },
            },
            required: ['id'],
          },
        },
        {
          name: 'share_link',
          description: [
            'Share a link with another Vitana user as a chat message with a',
            'link-card preview. Same confirmation contract as send_chat_message:',
            'ALWAYS resolve_recipient first, ALWAYS read back the link target',
            'and recipient, ONLY send on explicit confirmation.',
            '',
            'Use this when the user says "share this with X", "send the page',
            'to X", "invite X to this", or similar. If the user is on a',
            'specific screen, call get_current_screen first to learn the',
            'target_url and target_kind ("event", "post", "profile", etc.),',
            'then read both back to the user before sending.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              recipient_user_id: {
                type: 'string',
                description: 'Opaque user_id from resolve_recipient candidates[i].user_id.',
              },
              recipient_label: {
                type: 'string',
                description: 'Recipient vitana_id (e.g. "alex3700").',
              },
              target_url: {
                type: 'string',
                description: 'Full URL of the resource to share (e.g. https://vitanaland.com/events/abc).',
              },
              target_kind: {
                type: 'string',
                description: 'What is being shared. Examples: "event", "meetup", "post", "profile", "product", "campaign", "page".',
              },
            },
            required: ['recipient_user_id', 'recipient_label', 'target_url', 'target_kind'],
          },
        },
        // ─── VTID-01975 — Vitana Intent Engine ───
        // Single voice tool that handles all six intent kinds. Same
        // confirmation contract as send_chat_message: classify → extract →
        // read back → only post on explicit verbal confirmation.
        {
          name: 'post_intent',
          description: [
            'Register an intent in the Vitana community catalog. Use this',
            'whenever the user expresses a need, an offering, a desire to find',
            'an activity partner / life partner / mentor, or willingness to',
            'lend / borrow / give / receive. The classifier picks the kind',
            'automatically; you can pass kind_hint when the user is explicit.',
            '',
            'CONFIRMATION CONTRACT (mandatory):',
            '1. Call post_intent(utterance) WITHOUT confirmed=true. Server',
            '   classifies + extracts + returns a structured summary.',
            '2. Read the summary back verbatim ("Posting: ...").',
            '3. Wait for explicit confirmation (post/yes/confirm/ja).',
            '4. Call post_intent again WITH confirmed=true.',
            '',
            'For partner_seek: explain matches are revealed only after both',
            'parties express interest (privacy protocol).',
            '',
            'DANCE matchmaking (learning_seek / mentor_seek / activity_seek with dance.* category):',
            '- "I want to learn salsa, find a teacher" → learning_seek + dance.learning.salsa',
            '- "I teach salsa Tuesdays" → mentor_seek + dance.teaching.salsa',
            '- "Find me a salsa partner Saturday night" → activity_seek + dance.social_partner',
            '- "Going out dancing this weekend" → activity_seek + dance.group_outing',
            'When the user gives constraints like gender / age range / location radius / max price,',
            'put them in kind_payload.counterparty_filter.',
            '',
            'ALWAYS-POST contract: every dictated intent gets posted regardless of match count.',
            'When matches=0, do NOT say "no matches found." Say:',
            '"I posted your request — you\'re the first one looking for this in our community right now.',
            ' I\'ll let you know the moment someone matches. Your post is also visible on the board so',
            ' anyone can see it."',
            '',
            'DEDUP BEHAVIOR: if the user asks the same thing twice in a session ("looking for a dance partner"',
            'after they already posted that), the server returns deduplicated:true with the existing intent_id.',
            'When you see deduplicated:true, do NOT post again. Tell the user: "You already posted this',
            'earlier today. Refine it (different time, location, or style) if you want a new one — or open',
            'the existing post and I can show you who responded." Then call list_my_intents OR navigate_to_screen',
            'with target=my_intents so they can SEE their existing post.',
            '',
            'NEVER repeat-post the same generic ask. If the user repeats verbatim, treat it as "show me my',
            'existing post" — call list_my_intents and surface what they already have.',
            '',
            'SUCCESS CONTRACT (VTID-02790, mandatory):',
            'When the response contains stage:"posted" — regardless of match_count, cold_start, or any',
            'other field — the post is LIVE in the database. You MUST confirm success.',
            '- NEVER say "I had a problem", "there was an issue", "I couldn\'t post", "etwas ging schief",',
            '  "es gab ein Problem", "ich konnte den Beitrag nicht erstellen", or any apologetic phrase.',
            '- For match_count > 0: announce the post is live and that there are N potential matches.',
            '- For match_count = 0 (cold_start): use the "you\'re the first" copy above.',
            '- If the user later doubts ("did it really post?"), call list_my_intents and SHOW them.',
            'Do NOT invent failure modes. Do NOT apologize when the server reported success.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              utterance: { type: 'string', description: 'The user\'s words verbatim.' },
              kind_hint: {
                type: 'string',
                enum: ['commercial_buy', 'commercial_sell', 'activity_seek', 'partner_seek', 'social_seek', 'mutual_aid', 'learning_seek', 'mentor_seek'],
              },
              confirmed: { type: 'boolean' },
            },
            required: ['utterance'],
          },
        },
        {
          name: 'view_intent_matches',
          description: 'Pull the top-N matches for one of the user\'s open intents. partner_seek matches show "(redacted)" until both parties express interest.',
          parameters: {
            type: 'object',
            properties: {
              intent_id: { type: 'string' },
              limit: { type: 'integer' },
            },
            required: ['intent_id'],
          },
        },
        {
          name: 'list_my_intents',
          description: 'List the user\'s open intents. Optional kind filter.',
          parameters: {
            type: 'object',
            properties: {
              intent_kind: {
                type: 'string',
                enum: ['commercial_buy', 'commercial_sell', 'activity_seek', 'partner_seek', 'social_seek', 'mutual_aid', 'learning_seek', 'mentor_seek'],
              },
            },
          },
        },
        {
          name: 'respond_to_match',
          description: 'Express interest or decline a match. CONFIRMATION CONTRACT: read summary back, only call with confirmed=true after explicit user response. partner_seek mutual interest unlocks reciprocal-reveal.',
          parameters: {
            type: 'object',
            properties: {
              match_id: { type: 'string' },
              response: { type: 'string', enum: ['express_interest', 'decline'] },
              confirmed: { type: 'boolean' },
            },
            required: ['match_id', 'response'],
          },
        },
        {
          name: 'mark_intent_fulfilled',
          description: 'Close one of the user\'s intents because they got what they were looking for.',
          parameters: {
            type: 'object',
            properties: { intent_id: { type: 'string' } },
            required: ['intent_id'],
          },
        },
        // VTID-DANCE-D10: voice-driven direct invite.
        {
          name: 'share_intent_post',
          description: [
            'Direct-share one of the user\'s intent posts to specific community members.',
            'Use when the user says "share my <topic> post with @maria3 and @daniel4" or',
            '"send my salsa request to my friends Anna and Boris".',
            '',
            'CONFIRMATION CONTRACT (mandatory):',
            '1. Resolve each spoken name via resolve_recipient first to get the @vitana_id.',
            '2. Read back: "I\'ll share your <intent title> with @maria3 and @daniel4. Say send to confirm."',
            '3. Wait for explicit user confirmation (send/yes/confirm/ja).',
            '4. Call share_intent_post with confirmed=true.',
            '',
            'For partner_seek posts: warn the user that sharing reveals their identity to the recipient.',
            'For private posts: only the post owner can share — others should use the public link.',
            '',
            'Server is idempotent: re-sharing to the same recipient is a no-op (matches_created=0).',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              intent_id: { type: 'string', description: 'The user\'s intent_id to share. Pull from list_my_intents if needed.' },
              recipient_vitana_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Up to 20 vitana_ids (without leading @).',
              },
              note: { type: 'string', description: 'Optional short note to include with the share (≤280 chars).' },
              confirmed: { type: 'boolean' },
            },
            required: ['intent_id', 'recipient_vitana_ids'],
          },
        },
        // VTID-02770 — Voice navigation. The Navigator returns a relative URL
        // the frontend ORB widget intercepts and routes to.
        //
        // The valid set of `screen_id` values is the Navigation Catalog
        // (services/gateway/src/lib/navigation-catalog.ts) — the single source
        // of truth, ~150 entries and growing. There is no enum here on purpose:
        // an enum drifts the moment a new screen ships. Send any screen_id or
        // alias slug; the gateway validates with exact match → alias match →
        // fuzzy resolve, in that order.
        {
          name: 'navigate_to_screen',
          description: [
            'Redirect the user to a screen, page, drawer, or overlay.',
            '',
            '── HARD-REDIRECT LEXICON — ALWAYS call this tool when the user uses any of these phrasings AND the requested item maps unambiguously to one screen ──',
            '  Open       — "open …", "take me to …", "go to …", "launch …", "öffne …", "geh zu …", "bring mich zu …"',
            '  Show       — "show me …", "let me see …", "display …", "zeig mir …", "lass mich … sehen"',
            '  Guide      — "guide me to …", "navigate me to …", "lead me to …", "führe mich zu …"',
            '  Locate     — "where can I find …", "where is …", "where do I see …", "wo finde ich …", "wo ist …"',
            '  Action     — "where can I execute …", "where do I do …", "where can I log …", "wo kann ich …"',
            '  Read       — "read me my …", "read this …", "read that …", "lies mir … vor"',
            '  Not-found  — "I could not find …", "I can\'t find …", "I don\'t see …", "ich finde … nicht"',
            '',
            'When any of these phrasings is used and the target is unambiguous, the redirect IS the answer. Do not narrate, do not ask permission, do not re-confirm. After calling, say a brief voice cue ("Opening your matches" / "Hier ist dein Index").',
            '',
            '── DISAMBIGUATION ──',
            'If the request could legitimately map to multiple screens (e.g. "show me my news" → inbox / AI feed / news; "where can I see my events" → events / calendar / reminders), DO NOT GUESS. Ask one short either/or question using the catalog titles, then call this tool with the user\'s pick. Example: "Do you mean your inbox news, or your AI feed?" / "Meinst du deinen Posteingang oder den KI-Feed?"',
            '',
            '── HOW TO PICK A screen_id ──',
            'Send the canonical id when known: COMM.FIND_PARTNER, HEALTH.VITANA_INDEX, DISCOVER.MARKETPLACE, OVERLAY.CALENDAR, MEMORY.DIARY, REMINDERS.OVERVIEW, INBOX.OVERVIEW, PROFILE.ME, PROFILE.PUBLIC, SETTINGS.CONNECTED_APPS, BUSINESS.OVERVIEW, COMM.OPEN_ASKS, COMM.MEMBERS, COMM.TALK_TO_VITANA, INTENTS.BOARD, INTENTS.MINE, INTENTS.MATCH_DETAIL, etc. If you only know a slug, send that — alias resolution handles "find-partner", "marketplace", "vitana-index", "calendar", "diary", "reminders", "members", "open-asks", "intent-board", "connected-apps", and the legacy snake_case forms (find_partner, events_meetups, …). Slugs work in EN or DE.',
            '',
            'Overlays (entry_kind=overlay): they open as a popup/drawer on the current screen instead of navigating. Examples: OVERLAY.CALENDAR, LIFE_COMPASS.OVERLAY, OVERLAY.VITANA_INDEX, OVERLAY.PROFILE_PREVIEW, OVERLAY.MEETUP_DRAWER, OVERLAY.EVENT_DRAWER, OVERLAY.WALLET_POPUP, OVERLAY.MASTER_ACTION. Same tool, same call site — the catalog tells the gateway which to render.',
            '',
            '── PARAMETERIZED ROUTES ──',
            'If the catalog entry has `:param` placeholders, also send the param: `match_id` for INTENTS.MATCH_DETAIL; `vitana_id` (+ optional `intent_id`) for PROFILE.PUBLIC / PROFILE.WITH_MATCH; `meetup_id` / `event_id` for OVERLAY.MEETUP_DRAWER / OVERLAY.EVENT_DRAWER; `user_id` for OVERLAY.PROFILE_PREVIEW; `id` for DISCOVER.PRODUCT_DETAIL / DISCOVER.PROVIDER_PROFILE / NEWS.DETAIL; `groupId` for COMM.GROUP_DETAIL; `roomId` for COMM.LIVE_ROOM_VIEWER.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              screen_id: {
                type: 'string',
                description: 'Catalog screen_id (e.g. "COMM.FIND_PARTNER") OR a known alias slug ("find-partner", "marketplace"). Validated server-side with exact → alias → fuzzy resolution; unknown ids are rejected with suggestions.',
              },
              target: {
                type: 'string',
                description: 'Legacy slug field — kept for backward compatibility with older clients. Equivalent to screen_id when both are absent.',
              },
              reason: {
                type: 'string',
                description: 'One-sentence reason in the user\'s language. Surfaced in OASIS telemetry for tuning.',
              },
              intent_id: { type: 'string', description: 'For PROFILE.WITH_MATCH (the matched intent_id).' },
              match_id: { type: 'string', description: 'For INTENTS.MATCH_DETAIL.' },
              vitana_id: { type: 'string', description: 'For PROFILE.PUBLIC / PROFILE.WITH_MATCH — counterparty vitana_id without leading @.' },
              meetup_id: { type: 'string', description: 'For OVERLAY.MEETUP_DRAWER.' },
              event_id: { type: 'string', description: 'For OVERLAY.EVENT_DRAWER.' },
              user_id: { type: 'string', description: 'For OVERLAY.PROFILE_PREVIEW.' },
              groupId: { type: 'string', description: 'For COMM.GROUP_DETAIL.' },
              roomId: { type: 'string', description: 'For COMM.LIVE_ROOM_VIEWER.' },
              id: { type: 'string', description: 'For DISCOVER.PRODUCT_DETAIL, DISCOVER.PROVIDER_PROFILE, NEWS.DETAIL.' },
            },
            // Either screen_id or target must be present — checked in the
            // handler so legacy callers that send `target` continue to work.
          },
        },
        // VTID-DANCE-D11.B — pre-post candidate scan.
        {
          name: 'scan_existing_matches',
          description: [
            'BEFORE posting an intent, call this to see who is already in the catalog with a similar ask.',
            'Use the same intent_kind you would pass to post_intent + the category_prefix (e.g. dance.) and',
            'the dance variety when known.',
            '',
            'Returns: { open_intents[], dance_pref_members[], total }.',
            'If total > 0: read back the names + offer "Want to see them, share with them, or post yours so they can find you too?"',
            'If total == 0: proceed with post_intent and use the always-post readback.',
            '',
            'This call is read-only and cheap — always safe to call before post_intent.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              intent_kind: {
                type: 'string',
                enum: ['commercial_buy','commercial_sell','activity_seek','partner_seek','social_seek','mutual_aid','learning_seek','mentor_seek'],
              },
              category_prefix: {
                type: 'string',
                description: 'e.g. "dance." for any dance category, "home_services." for any home service. Optional.',
              },
              variety: {
                type: 'string',
                description: 'For dance: salsa | tango | bachata | kizomba | swing | ballroom | hiphop | contemporary. Optional.',
              },
            },
            required: ['intent_kind'],
          },
        },
        // VTID-DANCE-D12 — poll for the matchmaker agent's polished result.
        {
          name: 'get_matchmaker_result',
          description: [
            'After post_intent, the matchmaker agent runs ASYNC (~20s) re-ranking + writing a voice readback.',
            'Call this 3 seconds after post_intent to fetch the polished result. status will be:',
            '  pending/running/not_started — call again in 3 seconds',
            '  complete — read back voice_readback verbatim, then offer next steps',
            '  error — fall back to the SQL match summary already returned by post_intent',
            '',
            'CRITICAL (VTID-02861): this tool ALWAYS reports success at the wire level. The post_intent',
            'row is already in user_intents — nothing this tool returns means the post failed.',
            'NEVER say "I had a problem", "there was an issue", "I couldn\'t post", or any apologetic phrase',
            'about the post based on this tool\'s response. status:"error" / "not_started" / "not_found"',
            'just means the polish is unavailable; the post is still live. Use the SQL match summary from',
            'post_intent and continue normally.',
            '',
            'The polished result includes counter_questions when the user gave a vague intent.',
            'If counter_questions is non-empty, ASK them progressively (variety → time → location)',
            'BEFORE reading back the candidate list. The user can always say "just show me matches"',
            'to skip — never insist on filling all slots.',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: { intent_id: { type: 'string' } },
            required: ['intent_id'],
          },
        },
        // ─── VTID-02753 — Voice Tool Expansion P1a: structured Health logging ───
        // Five tools backed by POST /api/v1/integrations/manual/log. Distinct
        // from save_diary_entry (which extracts from free text). Use when the
        // user explicitly states a quantity ("log 500ml of water", "I slept 7
        // hours", "30 minutes of running"). Each call writes a row to
        // health_features_daily and triggers a Vitana Index recompute.
        {
          name: 'log_water',
          description: [
            "Log a hydration entry when the user explicitly states an amount of water/fluid drunk.",
            "",
            "CALL THIS WHEN the user says any of:",
            "  - 'log 500ml of water' / 'trag 500ml Wasser ein'",
            "  - 'I drank a glass of water' (≈250ml)",
            "  - 'two liters today' (2000ml)",
            "  - 'log my water: 1.5L'",
            "",
            "Convert to ML before calling — the gateway expects amount_ml as a number.",
            "Common conversions: 1 glass ≈ 250ml, 1 cup ≈ 240ml, 1 bottle ≈ 500ml, 1L = 1000ml.",
            "If the amount is ambiguous ('some water'), ASK before calling — do not guess.",
            "",
            "After the tool returns, briefly acknowledge ('logged 500 ml — Hydration is up').",
            "Use the index_delta to celebrate movement on the Hydration pillar.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              amount_ml: {
                type: 'number',
                description: 'Amount of fluid in milliliters. Min 50, max 5000.',
              },
              date: {
                type: 'string',
                description: 'Optional YYYY-MM-DD. Defaults to today (user local).',
              },
            },
            required: ['amount_ml'],
          },
        },
        {
          name: 'log_sleep',
          description: [
            "Log a sleep duration when the user explicitly reports how long they slept.",
            "",
            "CALL THIS WHEN the user says any of:",
            "  - 'I slept 7 hours last night' / 'ich habe 7 Stunden geschlafen'",
            "  - 'log my sleep: 8.5 hours'",
            "  - 'got 6 hours' (assume sleep context)",
            "  - 'slept from 11 to 7' — compute hours yourself",
            "",
            "Convert to MINUTES before calling. Examples: 7h → 420, 8.5h → 510, 6h30m → 390.",
            "If the user gives a sleep range without confirming hours, ASK — don't guess.",
            "",
            "After the tool returns, acknowledge briefly. If hours were below 7, gently note",
            "it without lecturing ('420 minutes logged — under your typical 7 hours').",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              minutes: {
                type: 'integer',
                description: 'Sleep duration in minutes. Min 60, max 960 (16h).',
              },
              date: {
                type: 'string',
                description: 'Optional YYYY-MM-DD for the night logged. Defaults to today.',
              },
            },
            required: ['minutes'],
          },
        },
        {
          name: 'log_exercise',
          description: [
            "Log an exercise/workout session when the user explicitly reports duration.",
            "",
            "CALL THIS WHEN the user says any of:",
            "  - '30 minutes of running' / '30 Minuten Lauf'",
            "  - 'just finished a 45-minute workout'",
            "  - 'log a 1-hour walk'",
            "  - 'I did yoga for 20 minutes'",
            "",
            "Convert duration to MINUTES. The activity_type is freeform — pass the user's",
            "phrase verbatim ('running', 'cycling', 'yoga', 'crossfit', 'walk', 'swim').",
            "If the user reports an activity without a duration ('I went for a run'), ASK",
            "how long before calling. Don't guess.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              minutes: {
                type: 'integer',
                description: 'Duration in minutes. Min 5, max 600.',
              },
              activity_type: {
                type: 'string',
                description: "Freeform activity name (e.g. 'running', 'yoga', 'crossfit'). Optional.",
              },
              date: {
                type: 'string',
                description: 'Optional YYYY-MM-DD. Defaults to today.',
              },
            },
            required: ['minutes'],
          },
        },
        {
          name: 'log_meditation',
          description: [
            "Log a meditation / mindfulness session — boosts the Mental pillar.",
            "",
            "CALL THIS WHEN the user says any of:",
            "  - '10 minutes of meditation' / '10 Minuten Meditation'",
            "  - 'just finished a 20 minute mindfulness session'",
            "  - 'log my breathwork — 15 minutes'",
            "  - 'did box breathing for 5 minutes'",
            "",
            "Pass duration in MINUTES. Don't conflate with exercise — meditation/mindfulness/",
            "breathwork/yoga-nidra all go through this tool because they lift Mental, not",
            "Exercise.",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              minutes: {
                type: 'integer',
                description: 'Meditation duration in minutes. Min 1, max 240.',
              },
              date: {
                type: 'string',
                description: 'Optional YYYY-MM-DD. Defaults to today.',
              },
            },
            required: ['minutes'],
          },
        },
        {
          name: 'get_pillar_subscores',
          description: [
            "Return the sub-score breakdown for a single Vitana Index pillar so you can",
            "explain WHY the pillar is low. Each pillar has four caps:",
            "  - baseline (0-40): from the baseline survey",
            "  - completions (0-80): from calendar tag completions",
            "  - data (0-40): from health_features_daily (this is what log_* tools lift)",
            "  - streak (0-40): consecutive-day streak for the pillar",
            "",
            "CALL THIS WHEN the user asks:",
            "  - 'why is my Sleep score low?'",
            "  - 'what's holding back my Nutrition?'",
            "  - 'break down my Hydration score'",
            "  - 'wieso ist meine Bewegung niedrig?'",
            "",
            "Speak the answer naturally — 'Your Sleep is mostly baseline because we don't",
            "have any tracker data yet — connect a wearable or log sleep manually and the",
            "data sub-score will start filling in.'",
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              pillar: {
                type: 'string',
                enum: ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'],
                description: 'Which pillar to break down.',
              },
            },
            required: ['pillar'],
          },
        },
        // BOOTSTRAP-ADMIN-DD: admin voice tools — only injected when active_role
        // is admin / exafy_admin / developer. Community sessions never see them
        // and the orb dispatcher rejects them server-side regardless.
        ...(activeRole && ['admin', 'exafy_admin', 'developer'].includes(activeRole)
          ? ADMIN_TOOL_SCHEMAS
          : []),
      ],
    },
    // VTID-GOOGLE-SEARCH: Native Google Search grounding. Gemini calls
    // Google Search directly and returns results with citations — no
    // function_response needed from our side. Replaces the broken
    // search_web custom function (which required PERPLEXITY_API_KEY, a
    // secret that was never wired into the deploy). With this, factual
    // questions like "how many calories in an apple" or "latest research
    // on sleep" get real web-grounded answers automatically.
    { google_search: {} },
  ];
}
