// Phase B.3 (decision-contract refactor) — typed catalog of policy keys.
//
// VTID-03116. Every consumer of `PolicyResolver` imports its key from this
// file. Stringly-typed keys scattered across the codebase are explicitly
// forbidden by the Phase B brief (`docs/decision-contract/phase-b-brief.md`,
// section "What to keep saying NO to").
//
// Adding a new key:
//   1. Add it to the `POLICY_KEYS` const below.
//   2. Add a seed row to a new migration so the resolver returns something
//      sane on a fresh deploy. The resolver's last-resort fallback is the
//      hard-coded `defaultValue` callers pass — that exists for safety, not
//      as the production source of truth.
//   3. Wire the consumer to call `getValue(POLICY_KEYS.<key>, { defaultValue: ... })`.

export const POLICY_KEYS = {
  // ---- session.recency_bucket.* ---------------------------------
  // Thresholds that drive `describeTimeSince()` in
  // services/gateway/src/orb/live/instruction/live-system-instruction.ts.
  // Seeded by Phase B.2 (VTID-03114).
  SESSION_RECENCY_RECONNECT_MAX_SECONDS:
    'session.recency_bucket.reconnect_max_seconds',
  SESSION_RECENCY_RECENT_MAX_MINUTES:
    'session.recency_bucket.recent_max_minutes',
  SESSION_RECENCY_SAME_DAY_MAX_HOURS:
    'session.recency_bucket.same_day_max_hours',
  SESSION_RECENCY_TODAY_MAX_HOURS:
    'session.recency_bucket.today_max_hours',
  SESSION_RECENCY_WEEK_MAX_DAYS:
    'session.recency_bucket.week_max_days',

  // ---- voice.* (Phase D.1, VTID-03124) --------------------------
  // Thresholds that previously lived as `export const` in
  // services/gateway/src/orb/upstream/constants.ts. Consumed by the
  // live-session-controller, upstream-message-handler, and orb-live.ts
  // route handlers. Seeded by the Phase D.1 migration with the same
  // byte-identical values; the constants.ts file still carries the
  // literal as the safety-net `defaultValue` when the cache is cold.
  VOICE_VAD_SILENCE_DURATION_MS: 'voice.vad.silence_duration_ms',
  VOICE_POST_TURN_COOLDOWN_MS: 'voice.post_turn.cooldown_ms',
  VOICE_SILENCE_KEEPALIVE_INTERVAL_MS:
    'voice.silence_keepalive.interval_ms',
  VOICE_SILENCE_KEEPALIVE_IDLE_THRESHOLD_MS:
    'voice.silence_keepalive.idle_threshold_ms',
  VOICE_WATCHDOG_GREETING_TIMEOUT_MS:
    'voice.watchdog.greeting_timeout_ms',
  VOICE_WATCHDOG_TURN_RESPONSE_TIMEOUT_MS:
    'voice.watchdog.turn_response_timeout_ms',
  VOICE_WATCHDOG_FORWARDING_ACK_TIMEOUT_MS:
    'voice.watchdog.forwarding_ack_timeout_ms',
  VOICE_LOOP_GUARD_MAX_CONSECUTIVE_MODEL_TURNS:
    'voice.loop_guard.max_consecutive_model_turns',
  VOICE_LOOP_GUARD_MAX_CONSECUTIVE_TOOL_CALLS:
    'voice.loop_guard.max_consecutive_tool_calls',

  // ---- Phase D.4.a (VTID-03127) --------------------------------
  // Default voice cascade returned by the gateway when no per-agent
  // `agent_voice_configs` row exists. Replaces the silent all-Google
  // hardcoded fallback in `orb-agent/providers.py:54-64`. JSON shape:
  // `{stt_provider, stt_model, llm_provider, llm_model, tts_provider,
  //   tts_model}` — same 6 fields the Python agent expected.
  VOICE_CASCADE_DEFAULT: 'voice.cascade.default',

  // ---- Phase C.2 (VTID-03131) — pillar weighter ----------------
  // The 21 numeric thresholds + weights currently hard-coded inside
  // `services/gateway/src/services/recommendation-engine/ranking/index-pillar-weighter.ts`.
  // Phase C.3 will implement `PillarWeighterStrategy` reading these
  // through PolicyResolver with the same values as `defaultValue`.
  RANKER_PILLAR_ALPHA_PILLAR: 'ranker.pillar_weighter.alpha_pillar',
  RANKER_PILLAR_ALPHA_WAVE: 'ranker.pillar_weighter.alpha_wave',
  RANKER_PILLAR_COMPASS_BOOST: 'ranker.pillar_weighter.compass_boost',
  RANKER_PILLAR_QUOTA_MAX: 'ranker.pillar_weighter.pillar_quota_max',
  RANKER_PILLAR_WEAKEST_QUOTA_MAX: 'ranker.pillar_weighter.weakest_quota_max',
  RANKER_PILLAR_COMPLETION_DAMPENER: 'ranker.pillar_weighter.completion_dampener',
  RANKER_PILLAR_PLAN_DAMPENER: 'ranker.pillar_weighter.plan_dampener',
  RANKER_PILLAR_REJECTION_DAMPENER_ALPHA: 'ranker.pillar_weighter.rejection_dampener_alpha',
  RANKER_PILLAR_STREAK_REINFORCEMENT: 'ranker.pillar_weighter.streak_reinforcement',
  RANKER_PILLAR_COMMUNITY_MOMENTUM_BOOST: 'ranker.pillar_weighter.community_momentum_boost',
  RANKER_PILLAR_BALANCE_UNBALANCED_AT: 'ranker.pillar_weighter.balance_unbalanced_at',
  RANKER_PILLAR_BALANCE_AMPLIFY_AT: 'ranker.pillar_weighter.balance_amplify_at',
  RANKER_PILLAR_BALANCE_AMPLIFY_FACTOR: 'ranker.pillar_weighter.balance_amplify_factor',
  RANKER_PILLAR_JOURNEY_MODE_DAY_BREAK_1: 'ranker.pillar_weighter.journey_mode_day_break_1',
  RANKER_PILLAR_JOURNEY_MODE_DAY_BREAK_2: 'ranker.pillar_weighter.journey_mode_day_break_2',
  RANKER_PILLAR_JOURNEY_MODE_DAY_BREAK_3: 'ranker.pillar_weighter.journey_mode_day_break_3',
  RANKER_PILLAR_JOURNEY_MODE_DECAY_1TO2: 'ranker.pillar_weighter.journey_mode_decay_1to2',
  RANKER_PILLAR_JOURNEY_MODE_DECAY_2TO3: 'ranker.pillar_weighter.journey_mode_decay_2to3',
  RANKER_PILLAR_JOURNEY_MODE_TERMINAL: 'ranker.pillar_weighter.journey_mode_terminal',
  RANKER_PILLAR_COMPASS_DECAY_SUBTRACT: 'ranker.pillar_weighter.compass_decay_subtract',
  RANKER_PILLAR_SCORE_CAP: 'ranker.pillar_weighter.pillar_score_cap',
} as const;

export type PolicyKey = (typeof POLICY_KEYS)[keyof typeof POLICY_KEYS];

// ---- policy_render_block keys -----------------------------------
// Greeting bucket prompt fragments. 8 buckets, 8 languages each.
// Seeded by Phase B.2 (VTID-03114). Consumed by the Phase B.4 vertical
// proof (greeting block in live-system-instruction.ts).

export const RENDER_BLOCK_KEYS = {
  GREETING_BUCKET_RECONNECT: 'greeting.bucket.reconnect',
  GREETING_BUCKET_RECENT: 'greeting.bucket.recent',
  GREETING_BUCKET_SAME_DAY: 'greeting.bucket.same_day',
  GREETING_BUCKET_TODAY: 'greeting.bucket.today',
  GREETING_BUCKET_YESTERDAY: 'greeting.bucket.yesterday',
  GREETING_BUCKET_WEEK: 'greeting.bucket.week',
  GREETING_BUCKET_LONG: 'greeting.bucket.long',
  GREETING_BUCKET_FIRST: 'greeting.bucket.first',

  // Phase D.2 (VTID-03125) — user-facing connection-issue apology when
  // the upstream WS is unrecoverable. Localized; renderer falls back to
  // 'en' if the requested language has no row. Consumed by orb-live.ts
  // (4 call sites at the time of writing).
  VOICE_CONNECTION_ISSUE: 'voice.connection_issue',
} as const;

export type RenderBlockKey =
  (typeof RENDER_BLOCK_KEYS)[keyof typeof RENDER_BLOCK_KEYS];
