/**
 * BOOTSTRAP-NOVA-SONIC-VOICE / DEV-COMHU-0514: automated test suite for the
 * Nova 2 Sonic voice provider, driven from the Command Hub's Nova Sonic
 * Test Bench.
 *
 * Two tiers:
 *   - OFFLINE checks (always run, no cost): configuration readiness, the
 *     selector decision table (canary gates, fallbacks, emergency
 *     rollback), protocol codec round-trips, and voice mapping.
 *   - LIVE probe (opt-in `live: true`): opens a real Bedrock bidirectional
 *     stream with the runtime credential chain, sends a short text turn,
 *     and measures connect / first-event / first-audio latency. Skipped
 *     with a typed reason when Nova is not ready, so the button is always
 *     safe to press.
 *
 * No raw audio, transcripts, or AWS exception text in results — failures
 * carry the typed nova_* categories only.
 */

import { randomUUID } from 'crypto';
import {
  getNovaSonicConfig,
  isNovaSonicLanguageSupported,
  NOVA_SONIC_MODEL_ID,
  NOVA_SONIC_REGION,
} from '../../orb/live/upstream/nova-sonic-config';
import { selectUpstreamProvider } from '../../orb/live/upstream/upstream-provider-selector';
import {
  buildAudioInput,
  buildPromptStart,
  buildSessionStart,
  convertToolsToNovaSpecs,
  NovaOutputNormalizer,
  NOVA_OUTPUT_MIME,
} from '../../orb/live/upstream/nova-sonic-protocol';
import { resolveNovaSonicVoice } from '../../orb/live/voice/nova-sonic-voice';
import {
  NovaSonicLiveClient,
  classifyNovaError,
  prewarmNovaSonicBedrock,
} from '../../orb/live/upstream/nova-sonic-live-client';
import type { UpstreamLiveClient } from '../../orb/live/upstream/types';
import { VertexLiveClient } from '../../orb/live/upstream/vertex-live-client';
import { GeminiApiKeyLiveClient } from '../../orb/live/upstream/gemini-api-key-live-client';
import {
  AI_STUDIO_LIVE_MODEL,
  GEMINI_LIVE_USE_API_KEY,
  VERTEX_LOCATION,
  VERTEX_PROJECT_ID,
} from '../../orb/live/config';
import { VERTEX_LIVE_MODEL } from '../../orb/live/protocol';

export interface NovaTestCheck {
  key: string;
  label: string;
  status: 'pass' | 'fail' | 'skip';
  duration_ms: number;
  /** Human-readable outcome detail. Never raw AWS text or payload content. */
  detail: string;
  /** Numeric measurements (latency probes) — for the bench UI + comparisons. */
  metrics?: Record<string, number>;
}

export interface NovaTestRunSummary {
  run_id: string;
  started_at: string;
  duration_ms: number;
  provider: 'nova_sonic';
  model: typeof NOVA_SONIC_MODEL_ID;
  region: typeof NOVA_SONIC_REGION;
  live_probe_requested: boolean;
  checks: NovaTestCheck[];
  passed: number;
  failed: number;
  skipped: number;
}

/** In-memory ring of recent runs (per instance — for the bench UI only). */
const RECENT_RUNS: NovaTestRunSummary[] = [];
const RECENT_RUNS_MAX = 20;

export function listNovaTestRuns(): NovaTestRunSummary[] {
  return [...RECENT_RUNS];
}

type CheckOutcome = Pick<NovaTestCheck, 'status' | 'detail' | 'metrics'>;
type CheckFn = () => Promise<CheckOutcome> | CheckOutcome;

async function runCheck(key: string, label: string, fn: CheckFn): Promise<NovaTestCheck> {
  const t0 = Date.now();
  try {
    const outcome = await fn();
    return { key, label, duration_ms: Date.now() - t0, ...outcome };
  } catch (err) {
    return {
      key,
      label,
      status: 'fail',
      duration_ms: Date.now() - t0,
      detail: (err as Error).message?.slice(0, 200) ?? 'unknown error',
    };
  }
}

const PROBE_SYSTEM_INSTRUCTION = 'You are a health-check probe. Reply with one short sentence.';
const PROBE_TIMEOUT_MS = 20_000;

interface LiveProbeMetrics extends Record<string, number> {
  connect_ms: number;
  first_event_ms: number;
  first_audio_ms: number;
}

interface LiveProbeResult {
  ok: boolean;
  metrics?: LiveProbeMetrics;
  failDetail?: string;
}

/**
 * Provider-neutral live probe: register handlers, connect, send one short
 * text turn, and measure connect / first-event / first-audio latency. Used
 * identically for Nova and the Vertex baseline so the comparison is fair.
 */
async function probeLiveClient(
  client: UpstreamLiveClient,
  connect: () => Promise<void>,
  closeReason: string,
  classifyFailure: (err: unknown) => string,
): Promise<LiveProbeResult> {
  const t0 = Date.now();
  let connectMs = -1;
  let firstEventMs = -1;
  let firstAudioMs = -1;

  const done = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const timer = setTimeout(finish, PROBE_TIMEOUT_MS);
    (timer as NodeJS.Timeout).unref?.();
    client.onTranscript(() => {
      if (firstEventMs < 0) firstEventMs = Date.now() - t0;
    });
    client.onAudioOutput(() => {
      if (firstAudioMs < 0) firstAudioMs = Date.now() - t0;
      if (firstEventMs < 0) firstEventMs = Date.now() - t0;
    });
    client.onTurnComplete(() => { clearTimeout(timer); finish(); });
    client.onError(() => { clearTimeout(timer); finish(); });
    client.onClose(() => { clearTimeout(timer); finish(); });
  });

  try {
    await connect();
    connectMs = Date.now() - t0;
    client.sendTextTurn('Say OK.');
    await done;
    await client.close(closeReason);
    if (firstEventMs < 0) {
      return {
        ok: false,
        failDetail: `stream opened (connect_ms=${connectMs}) but no model response within ${PROBE_TIMEOUT_MS / 1000}s`,
      };
    }
    return {
      ok: true,
      metrics: { connect_ms: connectMs, first_event_ms: firstEventMs, first_audio_ms: firstAudioMs },
    };
  } catch (err) {
    await client.close(`${closeReason}_failed`).catch(() => { /* idempotent */ });
    return { ok: false, failDetail: classifyFailure(err) };
  }
}

function formatProbeMetrics(m: LiveProbeMetrics): string {
  return `connect_ms=${m.connect_ms} first_event_ms=${m.first_event_ms} first_audio_ms=${m.first_audio_ms < 0 ? 'n/a' : m.first_audio_ms}`;
}

const NOVA_ALL_PASS = {
  enabled: true,
  identityAllowed: true,
  languageSupported: true,
  runtime: 'aws-ecs' as const,
};
const PROBE_IDENTITY = { userId: 'probe-user', tenantId: 'probe-tenant' };

export async function runNovaSonicTestSuite(options: {
  live?: boolean;
  trigger?: string;
} = {}): Promise<NovaTestRunSummary> {
  const startedAt = Date.now();
  const checks: NovaTestCheck[] = [];
  const cfg = getNovaSonicConfig(process.env);

  checks.push(await runCheck('config_readiness', 'Configuration readiness', () => {
    if (cfg.issues.length > 0) {
      return { status: 'fail', detail: `typed issues: ${cfg.issues.join(', ')}` };
    }
    return {
      status: 'pass',
      detail: `enabled=${cfg.enabled} ready=${cfg.ready} canary_users=${cfg.canaryUserIds.size} canary_tenants=${cfg.canaryTenantIds.size}`,
    };
  }));

  checks.push(await runCheck('pinned_model_region', 'Model/region pinned', () => {
    const ok = cfg.modelId === NOVA_SONIC_MODEL_ID && cfg.region === NOVA_SONIC_REGION;
    return ok
      ? { status: 'pass', detail: `${cfg.modelId} @ ${cfg.region}` }
      : { status: 'fail', detail: `unexpected ${cfg.modelId} @ ${cfg.region}` };
  }));

  checks.push(await runCheck('selector_canary_allowlisted', 'Selector: allowlisted canary → nova_sonic', () => {
    const d = selectUpstreamProvider({
      systemConfigActiveProvider: 'vertex',
      nova: NOVA_ALL_PASS,
      identity: PROBE_IDENTITY,
    });
    return d.provider === 'nova_sonic' && d.reason === 'nova_canary_allowlisted'
      ? { status: 'pass', detail: d.reason }
      : { status: 'fail', detail: `got ${d.provider}/${d.reason}` };
  }));

  checks.push(await runCheck('selector_non_allowlisted', 'Selector: non-allowlisted → vertex', () => {
    const d = selectUpstreamProvider({
      systemConfigActiveProvider: 'vertex',
      nova: { ...NOVA_ALL_PASS, identityAllowed: false },
      identity: PROBE_IDENTITY,
    });
    return d.provider === 'vertex'
      ? { status: 'pass', detail: d.reason }
      : { status: 'fail', detail: `got ${d.provider}/${d.reason}` };
  }));

  checks.push(await runCheck('selector_language_fallback', 'Selector: unsupported language → vertex', () => {
    const d = selectUpstreamProvider({
      nova: { ...NOVA_ALL_PASS, languageSupported: false },
      identity: PROBE_IDENTITY,
    });
    const langGateOk = !isNovaSonicLanguageSupported('sr') && isNovaSonicLanguageSupported('de-DE');
    return d.provider === 'vertex' && langGateOk
      ? { status: 'pass', detail: d.reason }
      : { status: 'fail', detail: `got ${d.provider}/${d.reason} langGateOk=${langGateOk}` };
  }));

  checks.push(await runCheck('selector_emergency_rollback', 'Selector: ORB_LIVE_PROVIDER=vertex beats canary', () => {
    const d = selectUpstreamProvider({
      envProviderOverride: 'vertex',
      nova: NOVA_ALL_PASS,
      identity: PROBE_IDENTITY,
    });
    return d.provider === 'vertex' && d.reason === 'env_explicit_vertex'
      ? { status: 'pass', detail: d.reason }
      : { status: 'fail', detail: `got ${d.provider}/${d.reason}` };
  }));

  checks.push(await runCheck('protocol_roundtrip', 'Protocol codecs round-trip', () => {
    const session = buildSessionStart();
    const prompt = buildPromptStart({
      promptName: 'p1',
      voiceId: 'tina',
      tools: convertToolsToNovaSpecs([
        { name: 'probe_tool', description: 'x', parameters: { type: 'object' } },
      ]),
    });
    const audio = buildAudioInput({ promptName: 'p1', contentName: 'a1', dataB64: 'AQID' });
    const audioCfg = (prompt.event.promptStart as Record<string, any>)
      .audioOutputConfiguration;
    const shapesOk =
      !!(session.event as Record<string, unknown>).sessionStart &&
      audioCfg?.sampleRateHertz === 24000 &&
      (audio.event.audioInput as Record<string, unknown>).content === 'AQID';

    const n = new NovaOutputNormalizer();
    n.normalize({ event: { toolUse: { toolUseId: 'u1', toolName: 'probe_tool', content: '{}' } } });
    const toolEvents = n.normalize({ event: { contentEnd: { type: 'TOOL', stopReason: 'TOOL_USE' } } });
    const audioEvents = n.normalize({ event: { audioOutput: { content: 'QUJD' } } });
    const turnEvents = n.normalize({ event: { completionEnd: { stopReason: 'END_TURN' } } });
    const normOk =
      toolEvents[0]?.kind === 'toolCall' &&
      audioEvents[0]?.kind === 'audio' &&
      (audioEvents[0] as { mimeType: string }).mimeType === NOVA_OUTPUT_MIME &&
      turnEvents[0]?.kind === 'turnComplete';
    return shapesOk && normOk
      ? { status: 'pass', detail: 'builders + normalizer OK (24kHz out, toolUse correlation, END_TURN)' }
      : { status: 'fail', detail: `shapesOk=${shapesOk} normOk=${normOk}` };
  }));

  checks.push(await runCheck('voice_mapping', 'Voice mapping (persona × language)', () => {
    const ok =
      resolveNovaSonicVoice({ language: 'de', persona: 'vitana' }) === 'tina' &&
      resolveNovaSonicVoice({ language: 'de', persona: 'devon' }) === 'lennart' &&
      resolveNovaSonicVoice({ language: 'en', persona: 'vitana' }) === 'tiffany' &&
      resolveNovaSonicVoice({ language: 'sr', persona: 'vitana' }) === null;
    return ok
      ? { status: 'pass', detail: 'de→tina/lennart, en→tiffany, sr→null (fallback)' }
      : { status: 'fail', detail: 'unexpected voice mapping' };
  }));

  // LIVE probes — Nova via the runtime credential chain, plus a Vertex/Gemini
  // baseline through the SAME provider-neutral client contract, so latency is
  // measured apples-to-apples (both on their production warm path: Nova after
  // the Bedrock prewarm, Vertex with the token pre-fetched outside the timer).
  let novaMetrics: LiveProbeMetrics | null = null;
  let vertexMetrics: LiveProbeMetrics | null = null;

  checks.push(await runCheck('live_connect_probe', 'Live Bedrock connect + first-response latency', async () => {
    if (!options.live) {
      return { status: 'skip', detail: 'live probe not requested' };
    }
    if (!cfg.ready) {
      return {
        status: 'skip',
        detail: `Nova not ready (enabled=${cfg.enabled}, issues=${cfg.issues.join(',') || 'none'}) — enable via AWS_STAGE_NOVA_SONIC_ENABLED + deploy`,
      };
    }
    // Warm path, mirroring the boot prewarm real sessions benefit from.
    await prewarmNovaSonicBedrock(cfg);
    const client = new NovaSonicLiveClient({ config: cfg, voiceId: 'tiffany' });
    const result = await probeLiveClient(
      client,
      () => client.connect({
        model: cfg.modelId,
        voiceName: 'tiffany',
        responseModalities: ['audio'],
        vadSilenceMs: 2000,
        systemInstruction: PROBE_SYSTEM_INSTRUCTION,
        connectTimeoutMs: cfg.connectTimeoutMs,
      }),
      'nova_test_probe',
      (err) => classifyNovaError(err),
    );
    if (!result.ok) return { status: 'fail', detail: result.failDetail ?? 'nova_stream_error' };
    novaMetrics = result.metrics!;
    return { status: 'pass', detail: formatProbeMetrics(result.metrics!), metrics: result.metrics };
  }));

  checks.push(await runCheck('vertex_baseline_probe', 'Vertex baseline: connect + first-response latency', async () => {
    if (!options.live) {
      return { status: 'skip', detail: 'live probe not requested' };
    }
    if (!novaMetrics) {
      // Never open a paid Google stream when there is nothing to compare
      // against (Nova probe skipped or failed).
      return { status: 'skip', detail: 'nova live probe did not pass — baseline comparison unnecessary' };
    }
    let client: UpstreamLiveClient;
    let model: string;
    if (GEMINI_LIVE_USE_API_KEY) {
      const apiKey = process.env.GOOGLE_GEMINI_API_KEY || '';
      if (!apiKey) {
        return { status: 'skip', detail: 'api_key transport selected but GOOGLE_GEMINI_API_KEY unset' };
      }
      client = new GeminiApiKeyLiveClient({ getApiKey: async () => apiKey });
      model = AI_STUDIO_LIVE_MODEL;
    } else {
      // Pre-fetch the OAuth token OUTSIDE the timed window — production
      // sessions read a prewarmed cached token (ORB-CONVERSATION-LATENCY).
      let token: string;
      try {
        const { GoogleAuth } = await import('google-auth-library');
        const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
        const authClient = await auth.getClient();
        const tokenResponse = await authClient.getAccessToken();
        if (!tokenResponse.token) throw new Error('empty token');
        token = tokenResponse.token;
      } catch {
        return { status: 'skip', detail: 'vertex credentials (ADC) unavailable in this runtime' };
      }
      client = new VertexLiveClient({
        projectId: VERTEX_PROJECT_ID,
        location: VERTEX_LOCATION,
        getAccessToken: async () => token,
      });
      model = VERTEX_LIVE_MODEL;
    }
    const result = await probeLiveClient(
      client,
      () => client.connect({
        model,
        voiceName: 'Aoede',
        responseModalities: ['audio'],
        vadSilenceMs: 2000,
        systemInstruction: PROBE_SYSTEM_INSTRUCTION,
        connectTimeoutMs: 15_000,
      }),
      'nova_bench_vertex_baseline',
      (err) => `vertex_probe_failed: ${((err as Error)?.message ?? 'unknown').slice(0, 120)}`,
    );
    if (!result.ok) return { status: 'fail', detail: result.failDetail ?? 'vertex_probe_failed' };
    vertexMetrics = result.metrics!;
    return { status: 'pass', detail: formatProbeMetrics(result.metrics!), metrics: result.metrics };
  }));

  checks.push(await runCheck('latency_comparison', 'Nova vs Vertex: first-response latency', () => {
    if (!options.live) {
      return { status: 'skip', detail: 'live probe not requested' };
    }
    if (!novaMetrics || !vertexMetrics) {
      return {
        status: 'skip',
        detail: `needs both live probes to pass (nova=${novaMetrics ? 'ok' : 'missing'}, vertex=${vertexMetrics ? 'ok' : 'missing'})`,
      };
    }
    const delta = novaMetrics.first_event_ms - vertexMetrics.first_event_ms;
    const verdict = delta <= 0
      ? `Nova FASTER by ${-delta}ms`
      : `Nova slower by ${delta}ms`;
    const detail =
      `${verdict} — nova: connect=${novaMetrics.connect_ms}ms first_event=${novaMetrics.first_event_ms}ms` +
      ` | vertex: connect=${vertexMetrics.connect_ms}ms first_event=${vertexMetrics.first_event_ms}ms`;
    // Acceptance gate: Nova must be at least on par with Vertex; 15% headroom
    // absorbs single-shot network jitter. Anything beyond that is a real
    // regression and fails the run.
    const onPar = novaMetrics.first_event_ms <= vertexMetrics.first_event_ms * 1.15;
    return {
      status: onPar ? 'pass' : 'fail',
      detail,
      metrics: {
        nova_first_event_ms: novaMetrics.first_event_ms,
        vertex_first_event_ms: vertexMetrics.first_event_ms,
        delta_ms: delta,
      },
    };
  }));

  const summary: NovaTestRunSummary = {
    run_id: randomUUID(),
    started_at: new Date(startedAt).toISOString(),
    duration_ms: Date.now() - startedAt,
    provider: 'nova_sonic',
    model: NOVA_SONIC_MODEL_ID,
    region: NOVA_SONIC_REGION,
    live_probe_requested: options.live === true,
    checks,
    passed: checks.filter((c) => c.status === 'pass').length,
    failed: checks.filter((c) => c.status === 'fail').length,
    skipped: checks.filter((c) => c.status === 'skip').length,
  };

  RECENT_RUNS.unshift(summary);
  while (RECENT_RUNS.length > RECENT_RUNS_MAX) RECENT_RUNS.pop();
  return summary;
}
