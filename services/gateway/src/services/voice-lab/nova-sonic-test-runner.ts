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
} from '../../orb/live/upstream/nova-sonic-live-client';

export interface NovaTestCheck {
  key: string;
  label: string;
  status: 'pass' | 'fail' | 'skip';
  duration_ms: number;
  /** Human-readable outcome detail. Never raw AWS text or payload content. */
  detail: string;
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

type CheckFn = () => Promise<Pick<NovaTestCheck, 'status' | 'detail'>> |
  Pick<NovaTestCheck, 'status' | 'detail'>;

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

  // LIVE probe — real Bedrock stream via the runtime credential chain.
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

    const client = new NovaSonicLiveClient({ config: cfg, voiceId: 'tiffany' });
    const t0 = Date.now();
    let connectMs = -1;
    let firstEventMs = -1;
    let firstAudioMs = -1;

    const done = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const timer = setTimeout(finish, 20_000);
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
      await client.connect({
        model: cfg.modelId,
        voiceName: 'tiffany',
        responseModalities: ['audio'],
        vadSilenceMs: 2000,
        systemInstruction: 'You are a health-check probe. Reply with one short sentence.',
        connectTimeoutMs: cfg.connectTimeoutMs,
      });
      connectMs = Date.now() - t0;
      client.sendTextTurn('Say OK.');
      await done;
      await client.close('nova_test_probe');
      if (firstEventMs < 0) {
        return {
          status: 'fail',
          detail: `stream opened (connect_ms=${connectMs}) but no model response within 20s (nova_stream_timeout)`,
        };
      }
      return {
        status: 'pass',
        detail: `connect_ms=${connectMs} first_event_ms=${firstEventMs} first_audio_ms=${firstAudioMs < 0 ? 'n/a' : firstAudioMs}`,
      };
    } catch (err) {
      await client.close('nova_test_probe_failed').catch(() => { /* idempotent */ });
      return { status: 'fail', detail: classifyNovaError(err) };
    }
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
