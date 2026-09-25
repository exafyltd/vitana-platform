/**
 * VTID-04525 (Conversation hub B7) — the conversation flag registry.
 *
 * One list of every environment variable that changes what a voice session
 * does, with its owner VTID, what the code falls back to when it is unset,
 * and how a raw value is parsed. The Command Hub Configuration tab reads it
 * through `GET /api/v1/admin/conversation/system`.
 *
 * The effective value is not re-derived here. Wherever the owning module
 * exports its own read function, the registry calls it, so this screen cannot
 * disagree with the code a session runs. A few flags are read inline at module
 * load in routes/orb-live.ts (no exported function); for those, `read`
 * mirrors the inline expression, and the VTID-04525 test pins each mirror
 * against the source line.
 *
 * Staging / prod pins come from `conversation-flag-pins.generated.ts`, which
 * `scripts/conversation/generate-flag-pins.mjs` writes from the two gateway
 * deploy workflows. A test regenerates it and fails when it is stale.
 *
 * Reads only. Nothing here sets a flag.
 */

import { isScoredOpeningEnabled, scoredOpeningTimeoutMs } from './scored-opening';
import { isPersonalWeightsLive } from './personal-weights';
import { isTurnCandidatesEnabled } from './turn-candidates';
import { isBrainCoreSnapshotEnabled } from './brain-core-snapshot';
import { isLiveAdvisorEnabled, isAdvisorStageApproved } from './live-advisor';
import { isLessonLearnerContextEnabled } from '../../orb/live/session/session-context-builder';
import { isVoiceSessionSummaryEnabled } from '../../orb/live/session/finalize-live-session';
import { openingTurnMaxToolCalls, loopGuardReplyMaxAudioMs } from '../../orb/live/session/opening-turn-guard';
import { isToolSelectionEnabled } from '../../orb/live/tools/session-tool-selection';
import {
  resolveToolCatalogByteBudgetFor,
  resolveVertexToolCatalogByteBudget,
} from '../../orb/live/tools/vertex-tool-catalog-budget';
import { resolveGreetingDirectiveByteBudget } from '../../orb/live/instruction/greeting-directive-budget';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../assistant-continuation/decide-continuation';
import { isDiaryRollupEnabled } from '../memory/diary-theme-rollup';
import { isSupportSpecialistEnabled } from '../orchestrator/support-specialist';
import { isCommerceSpecialistEnabled } from '../orchestrator/commerce-specialist';
import { isDelegationPersistEnabled } from '../orchestrator/delegation-run-store';
import { featureFlagSetting, isFeatureLive } from '../feature-flags';
import { GATEWAY_WORKFLOW_PINS } from './conversation-flag-pins.generated';

export type FlagArea = 'opening' | 'context' | 'tools' | 'guards' | 'voice' | 'handoffs' | 'learning';

/**
 * How a raw value becomes the effective one:
 *   exact_true  — only the string `true` enables; anything else is off.
 *   not_false   — on unless the string is exactly `false`.
 *   number      — a number (clamped or defaulted by the owning module).
 *   feature_env — a FEATURE_<NAME>_ENV flag: off | staging-only | staging+prod.
 */
export type FlagParse = 'exact_true' | 'not_false' | 'number' | 'feature_env';

type Env = Record<string, string | undefined>;

export interface ConversationFlagDef {
  /** The environment variable name. */
  name: string;
  area: FlagArea;
  /**
   * The VTID named by the owning module or the read site. Null when the code
   * does not name one; the registry does not guess.
   */
  vtid: string | null;
  parse: FlagParse;
  /** What the code does when the variable is unset, as the code states it. */
  code_default: string;
  /** One line: what turning it on or changing it does. */
  description: string;
  /** Effective value on this process for an env map. Owning-module function where one exists. */
  read: (env: Env) => boolean | number | string;
  /**
   * True when the flag is read once at module load (the running process
   * keeps the value it booted with even if the environment changes).
   */
  read_at_boot?: boolean;
}

const featureEnvName = (feature: string) => `FEATURE_${feature}_ENV`;

/** Mirrors `process.env.X !== 'false'` for inline reads in orb-live.ts. */
const notFalse = (name: string) => (env: Env) => env[name] !== 'false';
/** Mirrors `process.env.X === 'true'` for inline reads. */
const exactTrue = (name: string) => (env: Env) => env[name] === 'true';
/** Mirrors `(process.env.X || '').trim() === 'true'` for inline reads. */
const trimmedTrue = (name: string) => (env: Env) => (env[name] || '').trim() === 'true';
/** Mirrors `Number(process.env.X || fallback)` for inline reads. */
const numberOr = (name: string, fallback: number) => (env: Env) => Number(env[name] || fallback);

function featureFlag(feature: string, area: FlagArea, vtid: string | null, description: string): ConversationFlagDef {
  const name = featureEnvName(feature);
  return {
    name,
    area,
    vtid,
    parse: 'feature_env',
    code_default: 'off',
    description,
    // featureFlagSetting reads process.env; an explicit map is resolved the
    // same way (off | staging-only | staging+prod, anything else → off).
    read: (env) => (env === process.env ? featureFlagSetting(feature) : normalizeFeatureSetting(env[name])),
  };
}

function normalizeFeatureSetting(raw: string | undefined): string {
  return raw === 'staging-only' || raw === 'staging+prod' || raw === 'off' ? raw : 'off';
}

export const CONVERSATION_FLAGS: readonly ConversationFlagDef[] = [
  // --- Opening -------------------------------------------------------------
  {
    name: 'BRAIN_SCORED_OPENING', area: 'opening', vtid: 'VTID-04454', parse: 'exact_true', code_default: 'off',
    description: 'The weighted score chooses the opening instead of the fixed provider priority.',
    read: (env) => isScoredOpeningEnabled(env),
  },
  {
    name: 'BRAIN_SCORED_OPENING_TIMEOUT_MS', area: 'opening', vtid: 'VTID-04454', parse: 'number', code_default: '400 (clamped 100–1500)',
    description: 'How long the scored ranking may take before the fixed ranking is served.',
    read: (env) => scoredOpeningTimeoutMs(env),
  },
  {
    name: 'BRAIN_PERSONAL_WEIGHTS', area: 'opening', vtid: 'VTID-04435', parse: 'exact_true', code_default: 'off',
    description: "Rankings use the member's own weight adjustment within fixed limits.",
    read: (env) => isPersonalWeightsLive(env),
  },
  {
    name: 'BRAIN_TURN_CANDIDATES', area: 'opening', vtid: 'VTID-04423', parse: 'not_false', code_default: 'on',
    description: "The opening's unused candidates are kept and re-ranked mid-conversation for get_next_best_action.",
    read: (env) => isTurnCandidatesEnabled(env.BRAIN_TURN_CANDIDATES),
  },
  {
    name: 'WAKE_BRIEF_PROVIDER_TIMEOUT_MS', area: 'opening', vtid: 'VTID-03741', parse: 'number', code_default: '800', read_at_boot: true,
    description: 'Per-provider timeout for ambient opening providers (explicit taps get 10 s).',
    read: (env) => (env === process.env ? DEFAULT_PROVIDER_TIMEOUT_MS : (() => {
      const n = Number(env.WAKE_BRIEF_PROVIDER_TIMEOUT_MS);
      return Number.isFinite(n) && n > 0 ? n : 800;
    })()),
  },
  {
    name: 'ORB_NEWDAY_OVERVIEW_RUNG_ENABLED', area: 'opening', vtid: 'VTID-03628', parse: 'not_false', code_default: 'on', read_at_boot: true,
    description: 'The once-a-day briefing rung of the greeting ladder.',
    read: notFalse('ORB_NEWDAY_OVERVIEW_RUNG_ENABLED'),
  },
  {
    name: 'ORB_DAY_CLOSE_RUNG_ENABLED', area: 'opening', vtid: 'VTID-03629', parse: 'exact_true', code_default: 'off', read_at_boot: true,
    description: 'The end-of-day close rung (local hour 0–4).',
    read: exactTrue('ORB_DAY_CLOSE_RUNG_ENABLED'),
  },
  {
    name: 'ORB_GREETING_SILENCE_ON_SKIP_ENABLED', area: 'opening', vtid: null, parse: 'not_false', code_default: 'on',
    description: 'The silenced_on_cadence rung: when the cadence verdict skips a greeting, the opening stays silent.',
    read: notFalse('ORB_GREETING_SILENCE_ON_SKIP_ENABLED'),
  },
  {
    name: 'ORB_GREETING_DIRECTIVE_BYTE_BUDGET', area: 'opening', vtid: 'VTID-04096', parse: 'number', code_default: 'module default',
    description: 'Byte budget for the greeting directive; above it the reduced directive is sent.',
    read: (env) => resolveGreetingDirectiveByteBudget(env),
  },
  {
    name: 'ORB_CONTEXT_READY_GATE_TIMEOUT_MS', area: 'opening', vtid: null, parse: 'number', code_default: '4000', read_at_boot: true,
    description: 'How long session setup waits for the context build before opening without it.',
    read: numberOr('ORB_CONTEXT_READY_GATE_TIMEOUT_MS', 4000),
  },
  featureFlag('ORB_SAFE_FAST_GREETING', 'opening', null, 'Greeting facts prefetch (first name, last session, briefing date).'),
  featureFlag('ORB_GREETING_TTS_BRIDGE', 'opening', null, 'Pre-rendered greeting audio plays while the model connects.'),
  featureFlag('VOICE_RANKING_SHADOW', 'opening', 'BOOTSTRAP-MEMORY-DAILY-LEARNING', 'Naive-vs-ranked retrieval comparison, logged only.'),

  // --- Context -------------------------------------------------------------
  {
    name: 'BRAIN_CORE_SNAPSHOT', area: 'context', vtid: 'VTID-04399', parse: 'not_false', code_default: 'on',
    description: 'Sessions set up with the pre-computed per-user core context snapshot instead of waiting for a cold build.',
    read: (env) => isBrainCoreSnapshotEnabled(env.BRAIN_CORE_SNAPSHOT),
  },
  {
    name: 'BRAIN_CONTEXT_PACKER', area: 'context', vtid: 'VTID-04393', parse: 'not_false', code_default: 'on',
    description: 'Context blocks are packed to their budget (keep / shorten / drop) before the instruction.',
    read: notFalse('BRAIN_CONTEXT_PACKER'),
  },
  {
    name: 'BRAIN_LESSON_CONTEXT', area: 'context', vtid: 'VTID-04414', parse: 'not_false', code_default: 'on',
    description: "Guided lessons carry the learner's context, not just the lesson text.",
    read: (env) => isLessonLearnerContextEnabled(env.BRAIN_LESSON_CONTEXT),
  },
  {
    name: 'PROFILER_IN_ORB_INSTRUCTION', area: 'context', vtid: null, parse: 'not_false', code_default: 'on',
    description: 'The structured profile is included in the system instruction.',
    read: notFalse('PROFILER_IN_ORB_INSTRUCTION'),
  },
  featureFlag('ORB_BRAIN_CACHE', 'context', 'BOOTSTRAP-ORB-FASTSTART-DRIFT', 'The built brain context is cached across stacked reconnects.'),
  featureFlag('ORB_FAST_START', 'context', 'BOOTSTRAP-ORB-FASTSTART-DRIFT', 'Session start defers the context build instead of blocking on it.'),

  // --- Tools ---------------------------------------------------------------
  {
    name: 'ORB_TOOL_SELECTION_ENABLED', area: 'tools', vtid: 'VTID-04426', parse: 'exact_true', code_default: 'off',
    description: 'When the catalog is trimmed, keep the tools of the current screen and reach the rest via find_tool / use_tool.',
    read: (env) => isToolSelectionEnabled(env),
  },
  {
    name: 'NOVA_TOOL_CATALOG_BYTE_BUDGET', area: 'tools', vtid: 'VTID-04097', parse: 'number', code_default: '65536 (0 disables)',
    description: 'Byte budget for the tool declarations a Nova Sonic session is given.',
    read: (env) => resolveToolCatalogByteBudgetFor('nova_sonic', env).budgetBytes,
  },
  {
    name: 'VERTEX_TOOL_CATALOG_BYTE_BUDGET', area: 'tools', vtid: 'VTID-04026', parse: 'number', code_default: '49152 (0 disables)',
    description: 'Byte budget for the tool declarations on the Serbian Vertex bridge.',
    read: (env) => resolveVertexToolCatalogByteBudget(env),
  },
  {
    name: 'NAV_V2_ENABLED', area: 'tools', vtid: 'VTID-04517', parse: 'exact_true', code_default: 'off',
    description: 'Registry-backed navigation: `navigate` is answered by the screen registry (open vs where-is).',
    read: exactTrue('NAV_V2_ENABLED'),
  },
  {
    name: 'NAV_CONTINUATION_BIND', area: 'tools', vtid: null, parse: 'exact_true', code_default: 'off',
    description: 'A spoken yes to a pending navigation offer the model did not act on opens the offered screen.',
    read: exactTrue('NAV_CONTINUATION_BIND'),
  },

  // --- Guards --------------------------------------------------------------
  {
    name: 'ORB_OPENING_MAX_TOOL_CALLS', area: 'guards', vtid: 'VTID-04480', parse: 'number', code_default: '2 (clamped 1–5)',
    description: 'Tool calls allowed before the first word of a session.',
    read: (env) => openingTurnMaxToolCalls(env),
  },
  {
    name: 'ORB_LOOP_GUARD_REPLY_MAX_MS', area: 'guards', vtid: 'VTID-04480', parse: 'number', code_default: '20000 (clamped 5000–60000)',
    description: 'Longest reply the loop guard lets play after it fires.',
    read: (env) => loopGuardReplyMaxAudioMs(env),
  },
  {
    name: 'ORB_IDLE_NO_ENGAGEMENT_MS', area: 'guards', vtid: null, parse: 'number', code_default: '300000', read_at_boot: true,
    description: 'Idle close when the member never spoke.',
    read: numberOr('ORB_IDLE_NO_ENGAGEMENT_MS', 5 * 60 * 1000),
  },
  {
    name: 'ORB_IDLE_AFTER_ENGAGEMENT_MS', area: 'guards', vtid: null, parse: 'number', code_default: '600000', read_at_boot: true,
    description: 'Idle close after the member has spoken.',
    read: numberOr('ORB_IDLE_AFTER_ENGAGEMENT_MS', 10 * 60 * 1000),
  },

  // --- Voice ---------------------------------------------------------------
  {
    name: 'NOVA_SONIC_GLOBAL_ENABLED', area: 'voice', vtid: 'VTID-03501', parse: 'exact_true', code_default: 'off',
    description: 'Nova Sonic for everyone past the canary allowlist.',
    read: exactTrue('NOVA_SONIC_GLOBAL_ENABLED'),
  },
  {
    name: 'ORB_CASCADED_VOICE_ENABLED', area: 'voice', vtid: 'VTID-03683', parse: 'exact_true', code_default: 'off',
    description: 'Transcribe → Bedrock → Polly/Fish cascade for languages Nova cannot speak.',
    read: trimmedTrue('ORB_CASCADED_VOICE_ENABLED'),
  },
  {
    name: 'VERTEX_SERBIAN_BRIDGE_ENABLED', area: 'voice', vtid: 'VTID-04000', parse: 'exact_true', code_default: 'off',
    description: 'Serbian sessions run on the Vertex Live bridge (new GCP project).',
    read: trimmedTrue('VERTEX_SERBIAN_BRIDGE_ENABLED'),
  },
  {
    name: 'VERTEX_LIVE_UNAVAILABLE', area: 'voice', vtid: 'VTID-03649', parse: 'exact_true', code_default: 'off',
    description: 'A premature Nova close reports connection_issue instead of reconnecting to Vertex.',
    read: trimmedTrue('VERTEX_LIVE_UNAVAILABLE'),
  },
  {
    name: 'ORB_FULL_DUPLEX_ENABLED', area: 'voice', vtid: 'VTID-03706', parse: 'exact_true', code_default: 'off',
    description: 'The mic stays open while Vitana speaks (noise-gated), so the member can interrupt.',
    read: exactTrue('ORB_FULL_DUPLEX_ENABLED'),
  },
  featureFlag('ORB_NOVA_PREWARM', 'voice', 'VTID-03779', 'A Nova stream is opened before the member taps the ORB.'),
  featureFlag('ORB_GREETING_PREBUFFER', 'voice', 'DEV-COMHU-0513', 'The greeting is generated during the client audio unlock and held until audio_ready.'),
  featureFlag('ORB_WS_TRANSPORT', 'voice', 'VTID-03471', 'Browsers use one WebSocket for voice; off moves new sessions to SSE.'),

  // --- Hand-offs -----------------------------------------------------------
  {
    name: 'ORCHESTRATOR_SUPPORT_SPECIALIST_ENABLED', area: 'handoffs', vtid: 'VTID-04397', parse: 'exact_true', code_default: 'off',
    description: "Read-only support specialist over the member's own tickets and the knowledge base.",
    read: (env) => isSupportSpecialistEnabled(env as NodeJS.ProcessEnv),
  },
  {
    name: 'ORCHESTRATOR_COMMERCE_SPECIALIST_ENABLED', area: 'handoffs', vtid: 'VTID-04400', parse: 'exact_true', code_default: 'off',
    description: "Read-only commerce onboarding specialist over the caller's partner organizations.",
    read: (env) => isCommerceSpecialistEnabled(env as NodeJS.ProcessEnv),
  },
  {
    name: 'ORCHESTRATOR_DELEGATION_PERSIST_ENABLED', area: 'handoffs', vtid: 'VTID-04415', parse: 'exact_true', code_default: 'off',
    description: 'Delegation jobs are written to the agent_runs ledger.',
    read: (env) => isDelegationPersistEnabled(env as NodeJS.ProcessEnv),
  },

  // --- Learning ------------------------------------------------------------
  {
    name: 'ORB_LIVE_ADVISOR_ENABLED', area: 'learning', vtid: 'VTID-04427', parse: 'exact_true', code_default: 'off',
    description: 'The live advisor writes guidance notes during a session (also needs an approved advisor stage).',
    read: (env) => isLiveAdvisorEnabled(env),
  },
  {
    name: 'ORB_VOICE_SESSION_SUMMARY_ENABLED', area: 'learning', vtid: 'VTID-04353', parse: 'not_false', code_default: 'on',
    description: 'A summary is recorded when a voice session finalizes.',
    read: (env) => isVoiceSessionSummaryEnabled(env.ORB_VOICE_SESSION_SUMMARY_ENABLED),
  },
  {
    name: 'CONSOLIDATOR_DIARY_ROLLUP_ENABLED', area: 'learning', vtid: 'VTID-04444', parse: 'exact_true', code_default: 'off',
    description: 'Nightly diary theme rollup feeds the structured profile.',
    read: (env) => isDiaryRollupEnabled(env.CONSOLIDATOR_DIARY_ROLLUP_ENABLED),
  },
];

export interface ResolvedConversationFlag {
  name: string;
  area: FlagArea;
  vtid: string | null;
  parse: FlagParse;
  code_default: string;
  description: string;
  read_at_boot: boolean;
  /** The raw environment string on this process (null when unset). */
  raw: string | null;
  /** What the owning code resolves it to on this process. */
  effective: boolean | number | string;
  /** For feature_env flags: whether the feature is live on this stack. */
  live_here?: boolean;
  /** A set value the parser does not accept (e.g. `production` for a feature flag, `1` for an exact-true flag). */
  invalid: boolean;
  /** Pins declared in the two gateway deploy workflows (null = not pinned there; `dynamic` = set from a variable). */
  staging_pin: string | null;
  prod_pin: string | null;
}

/** Whether a set raw value is one the parse rule treats as meaningful. */
export function isInvalidRaw(parse: FlagParse, raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false;
  switch (parse) {
    case 'exact_true':
      return raw !== 'true' && raw !== 'false';
    case 'not_false':
      return raw !== 'true' && raw !== 'false';
    case 'number':
      return !Number.isFinite(Number(raw));
    case 'feature_env':
      return !['off', 'staging-only', 'staging+prod'].includes(raw);
    default:
      return false;
  }
}

export function resolveConversationFlags(env: Env = process.env): ResolvedConversationFlag[] {
  return CONVERSATION_FLAGS.map((def) => {
    const raw = env[def.name];
    let effective: boolean | number | string;
    try {
      effective = def.read(env);
    } catch {
      effective = 'unreadable';
    }
    const pins = GATEWAY_WORKFLOW_PINS[def.name];
    const out: ResolvedConversationFlag = {
      name: def.name,
      area: def.area,
      vtid: def.vtid,
      parse: def.parse,
      code_default: def.code_default,
      description: def.description,
      read_at_boot: !!def.read_at_boot,
      raw: raw ?? null,
      effective,
      invalid: isInvalidRaw(def.parse, raw),
      staging_pin: pins?.staging ?? null,
      prod_pin: pins?.prod ?? null,
    };
    if (def.parse === 'feature_env' && env === process.env) {
      out.live_here = isFeatureLive(def.name.replace(/^FEATURE_/, '').replace(/_ENV$/, ''));
    }
    return out;
  });
}

/** Extra state that is not a single env var: the live advisor also needs an approved stage. */
export function conversationFlagNotes(): Record<string, string> {
  return {
    ORB_LIVE_ADVISOR_ENABLED: isAdvisorStageApproved()
      ? 'advisor stage approved'
      : 'advisor stage not in VALID_STAGES — the advisor stays off whatever this flag says',
  };
}
