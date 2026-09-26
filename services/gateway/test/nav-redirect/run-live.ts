/**
 * VTID-04607 — the voice redirect suite, live. Not run in CI: it needs AWS
 * credentials (Bedrock Titan, Nova Sonic, Polly) and it takes a few minutes.
 *
 *   BEDROCK_ROLE_ARN=local npx tsx test/nav-redirect/run-live.ts
 *
 * Layers (LAYER=resolver|voice|all, default all):
 *   resolver — every case through the real `navigate` tool, against the
 *              registry a deployment serves (REGISTRY_URL, default staging),
 *              each sentence embedded fresh by Titan.
 *   voice    — each sentence spoken by Polly to Nova Sonic with the
 *              production system prompt and tool catalog (en, de), or sent
 *              to the cascade's model turn with the cascade's tools (es, fr,
 *              pt, ar …). The model must call the tools itself; a case
 *              passes when the expected screen is what finally opens.
 *              Serbian runs on the Vertex bridge, which this runner never
 *              calls, so it is reported as not covered.
 *
 * Nothing is written anywhere: OASIS and Supabase are pointed at a dead
 * local port before any gateway module loads, and no tool other than the
 * three navigation tools is executed (the rest get a stub answer).
 * Output: OUT (default ./nav-redirect-live.json) plus a table on stdout.
 * CASES=R01,R07 runs a subset.
 */
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE = 'local-redirect-suite-no-writes';
process.env.SUPABASE_ANON_KEY = 'local-redirect-suite-no-writes';
process.env.NAV_V2_ENABLED = 'true';
delete process.env.NAV_CONTINUATION_BIND;
process.env.NAV_REGISTRY_URL = process.env.REGISTRY_URL || 'https://preview-aws.vitanaland.com/nav-registry.json';
process.env.AWS_REGION = process.env.AWS_REGION || 'eu-central-1';

import * as fs from 'fs';
import { REDIRECT_CASES, RedirectCase } from './redirect-cases';

const NAV_TOOLS = ['navigate', 'navigate_to_screen', 'get_current_screen'];
const ROUTE = '/home';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ToolStep { name: string; args: unknown; directive: string | null; decision: string | null; first_candidate: string | null; ok: boolean }
interface VoiceResult {
  id: string; lang: string; say: string; expect: string[];
  path: 'nova' | 'cascade' | 'not_covered';
  outcome: 'open' | 'wrong' | 'no_open' | 'not_covered' | 'error';
  opened: string | null; heard: string | null; said: string; steps: ToolStep[]; ms: number; note?: string;
}

async function main() {
  const layer = process.env.LAYER || 'all';
  const only = process.env.CASES ? new Set(process.env.CASES.split(',')) : null;
  const cases = REDIRECT_CASES.filter((c) => !only || only.has(c.id));
  const out: Record<string, unknown> = { started_at: new Date().toISOString(), registry_url: process.env.NAV_REGISTRY_URL };

  const { createTitanNavEmbedder, loadBundledEmbeddings } = await import('../../src/navigation/nav-embedder');
  const { __setNavServiceForTests, warmNavService, navServiceStatus } = await import('../../src/navigation/nav-service');
  // Registry texts reuse their stored vectors (same model); every suite
  // sentence is embedded fresh.
  const seed = new Map(loadBundledEmbeddings());
  for (const c of REDIRECT_CASES) seed.delete(c.say.trim());
  __setNavServiceForTests({ embedder: createTitanNavEmbedder({ seed }), index: null });
  await warmNavService();
  const status = navServiceStatus();
  out.nav_service = status;
  console.log('registry', JSON.stringify(status.registry), 'index', JSON.stringify(status.index));
  if (status.registry.source !== 'remote') throw new Error(`registry did not load from ${process.env.NAV_REGISTRY_URL}`);

  if (layer === 'resolver' || layer === 'all') {
    const { runRedirectCase, summarizeRedirect, formatRedirectTable } = await import('./redirect-harness');
    const results = [];
    for (const c of cases) results.push(await runRedirectCase(c));
    out.resolver = { summary: summarizeRedirect(results), results };
    console.log(`\nRESOLVER ${JSON.stringify(summarizeRedirect(results))}\n${formatRedirectTable(results)}`);
  }

  if (layer === 'voice' || layer === 'all') {
    const results: VoiceResult[] = [];
    for (const c of cases) {
      const r = await runVoice(c).catch((e: Error) => ({
        id: c.id, lang: c.lang, say: c.say, expect: c.expect, path: 'nova' as const, outcome: 'error' as const,
        opened: null, heard: null, said: '', steps: [], ms: 0, note: e.message,
      }));
      results.push(r);
      console.log(`${r.id} ${r.outcome.padEnd(11)} ${r.path.padEnd(11)} ${String(r.opened).padEnd(30)} ${r.say}  | heard: ${r.heard ?? '-'} | tools: ${r.steps.map((s) => `${s.name}→${s.directive ?? s.decision}`).join(', ')} | said: ${r.said.slice(0, 120)}${r.note ? ` | ${r.note}` : ''}`);
      fs.writeFileSync(process.env.OUT || 'nav-redirect-live.json', JSON.stringify({ ...out, voice: { results } }, null, 1));
    }
    const count = (o: string) => results.filter((r) => r.outcome === o).length;
    out.voice = { summary: { total: results.length, open: count('open'), wrong: count('wrong'), no_open: count('no_open'), not_covered: count('not_covered'), error: count('error') }, results };
    console.log(`\nVOICE ${JSON.stringify((out.voice as any).summary)}`);
  }
  out.finished_at = new Date().toISOString();
  fs.writeFileSync(process.env.OUT || 'nav-redirect-live.json', JSON.stringify(out, null, 1));
  process.exit(0);
}

function identityFor(c: RedirectCase) {
  return {
    user_id: 'redirect-suite-user', tenant_id: 'redirect-suite-tenant', role: 'community', lang: c.lang,
    session_id: `redirect-live-${c.id}`, is_anonymous: false, is_mobile: c.viewport === 'mobile',
  };
}

/** Runs one tool call the way the live session does; returns the text the model gets back. */
async function runTool(
  c: RedirectCase,
  name: string,
  args: Record<string, unknown>,
  steps: ToolStep[],
  memberWords: string,
): Promise<{ text: string; ok: boolean }> {
  const { dispatchOrbTool } = await import('../../src/services/orb-tools-shared');
  if (!NAV_TOOLS.includes(name)) {
    steps.push({ name, args, ok: true, directive: null, decision: 'not a navigation tool (stubbed)', first_candidate: null });
    return { ok: true, text: `(${name} is not available in this test; answer without it)` };
  }
  // The live session's per-turn guard (orb-live handleNavigate /
  // handleNavigateToScreen, VTID-03446/03583): once a screen has been
  // dispatched this turn, a further navigation call is refused and the first
  // screen stands.
  if (name !== 'get_current_screen' && steps.some((s) => s.directive)) {
    steps.push({ name, args, ok: true, directive: null, decision: 'blocked: already navigating this turn', first_candidate: null });
    return { ok: true, text: 'NAVIGATING_TO: (already in progress)\nA redirect is already underway from earlier in this turn. Do NOT ask another question or call navigate/navigate_to_screen again — just finish your sentence and stop.' };
  }
  // Same args orb-live's handleNavigate adds: the member's transcript.
  const res: any = await dispatchOrbTool(
    name,
    { ...args, current_route: ROUTE, is_mobile: c.viewport === 'mobile', transcript_excerpt: memberWords },
    identityFor(c) as any,
    null as any,
  );
  const d = res?.result?.directive;
  steps.push({
    name, args, ok: res?.ok !== false,
    directive: d?.screen_id ?? null,
    decision: res?.result?.decision ?? (res?.ok === false ? `error: ${res.error}` : null),
    first_candidate: res?.result?.candidates?.[0]?.screen_id ?? null,
  });
  const text = typeof res?.text === 'string' && res.text ? res.text : JSON.stringify(res?.result ?? res);
  return { ok: res?.ok !== false, text: res?.ok === false ? String(res.error) : text };
}

function grade(c: RedirectCase, steps: ToolStep[]): Pick<VoiceResult, 'outcome' | 'opened'> {
  // The first directive is the screen that opens (later ones are refused).
  const first = steps.find((s) => s.directive)?.directive ?? null;
  if (!first) return { outcome: 'no_open', opened: null };
  return { outcome: c.expect.includes(first) ? 'open' : 'wrong', opened: first };
}

async function systemPrompt(lang: string): Promise<string> {
  const { buildLiveSystemInstruction } = await import('../../src/orb/live/instruction/live-system-instruction');
  const { decomposeInstructionSections, enforceInstructionBudget } = await import('../../src/orb/live/instruction/instruction-budget');
  const { buildPersonaBehavioralRule } = await import('../../src/routes/orb-live');
  const raw = buildLiveSystemInstruction(lang, 'friendly, calm, empathetic', buildPersonaBehavioralRule('vitana'), 'community', undefined, undefined, false, null, ROUTE, [], undefined, null, false, undefined, true);
  const capped: any = enforceInstructionBudget(decomposeInstructionSections(raw));
  return capped.text ?? capped.finalText ?? raw;
}

async function runVoice(c: RedirectCase): Promise<VoiceResult> {
  const base = { id: c.id, lang: c.lang, say: c.say, expect: c.expect };
  const { isNovaSonicLanguageSupported } = await import('../../src/orb/live/upstream/nova-sonic-config');
  if (isNovaSonicLanguageSupported(c.lang)) return runNova(c);
  if (c.lang === 'sr') {
    return { ...base, path: 'not_covered', outcome: 'not_covered', opened: null, heard: null, said: '', steps: [], ms: 0, note: 'Serbian runs on the Vertex bridge; this runner never calls Google' };
  }
  return runCascade(c);
}

/**
 * The cascade's model turn — the same runCascadeModelTurn CascadedLiveClient
 * runs (tool rounds, then a tool-less spoken continuation). Speech-to-text
 * is not exercised: the sentence goes in as the transcript.
 */
async function runCascade(c: RedirectCase): Promise<VoiceResult> {
  const started = Date.now();
  const base = { id: c.id, lang: c.lang, say: c.say, expect: c.expect };
  const { extractCascadeTools, runCascadeModelTurn } = await import('../../src/orb/live/upstream/cascaded-live-client');
  const { buildLiveApiTools } = await import('../../src/orb/live/tools/live-tool-catalog');
  const steps: ToolStep[] = [];
  const { completion } = await runCascadeModelTurn({
    userText: c.say,
    systemPrompt: await systemPrompt(c.lang),
    priorHistory: [],
    tools: extractCascadeTools(buildLiveApiTools('authenticated', ROUTE, 'community') as any),
    service: 'redirect-suite-cascade',
    runToolCalls: async (calls) => {
      const withIds = calls.map((t, i) => ({ ...t, arguments: t.arguments || {}, id: t.id || `redirect-${steps.length}-${i}` }));
      const results = [];
      for (const t of withIds) {
        const r = await runTool(c, t.name, t.arguments as Record<string, unknown>, steps, c.say);
        results.push({ id: t.id, name: t.name, result: r.text, isError: !r.ok });
      }
      return { withIds, results };
    },
  });
  if (!completion.ok) throw new Error(`cascade model call failed: ${completion.error}`);
  return {
    ...base, path: 'cascade', ...grade(c, steps), heard: c.say, said: String(completion.text ?? '').trim(), steps,
    ms: Date.now() - started, note: `text turn on ${completion.provider}/${completion.model}; speech-to-text not exercised`,
  };
}

async function runNova(c: RedirectCase): Promise<VoiceResult> {
  const started = Date.now();
  const base = { id: c.id, lang: c.lang, say: c.say, expect: c.expect };
  const { getNovaSonicConfig } = await import('../../src/orb/live/upstream/nova-sonic-config');
  const { NovaSonicLiveClient } = await import('../../src/orb/live/upstream/nova-sonic-live-client');
  const { sanitizeInstructionForNova } = await import('../../src/orb/live/upstream/nova-instruction-sanitizer');
  const { buildLiveApiTools } = await import('../../src/orb/live/tools/live-tool-catalog');
  const { enforceToolCatalogBudget, resolveToolCatalogByteBudgetFor } = await import('../../src/orb/live/tools/vertex-tool-catalog-budget');
  const { synthesizePolly } = await import('../../src/services/tts/polly');

  const cfg = getNovaSonicConfig(process.env);
  const instr = sanitizeInstructionForNova(await systemPrompt(c.lang)).text;
  const { budgetBytes } = resolveToolCatalogByteBudgetFor('nova_sonic');
  const tools = enforceToolCatalogBudget(buildLiveApiTools('authenticated', ROUTE, 'community') as any[], budgetBytes).tools as any[];
  const voice = c.lang === 'de' ? 'tina' : 'amy';
  const client = new NovaSonicLiveClient({ config: cfg, voiceId: voice } as any);
  const steps: ToolStep[] = [];
  let said = '';
  let heard = '';
  let pending = '';
  let turnDone: (() => void) | null = null;
  let toolsInFlight = 0;
  client.onTranscript((e: any) => {
    if (e.direction === 'output') { if (e.isFinal) { said += `${e.text} `; pending = ''; } else pending = e.text; } else if (e.isFinal) heard += `${e.text} `;
  });
  client.onToolCall(async (e: any) => {
    for (const call of e.calls) {
      toolsInFlight++;
      try {
        const r = await runTool(c, call.name, call.args ?? {}, steps, heard.trim() || c.say);
        client.sendToolResult({ callId: call.id, name: call.name, success: r.ok, output: r.text, error: r.ok ? undefined : r.text });
      } finally { toolsInFlight--; }
    }
  });
  client.onTurnComplete(() => { if (!said.trim() && pending) said = pending; turnDone?.(); });
  let upstreamError = '';
  client.onError((e: any) => { upstreamError = JSON.stringify(e).slice(0, 300); });

  await client.connect({
    model: cfg.modelId, voiceName: voice, responseModalities: ['audio'], vadSilenceMs: 750, systemInstruction: instr,
    systemInstructionChunkBytes: cfg.instructionChunkBytes || undefined, tools, connectTimeoutMs: cfg.connectTimeoutMs,
  } as any);
  const silence = Buffer.alloc(3200).toString('base64');
  for (let i = 0; i < 5; i++) { client.sendAudioChunk(silence); await sleep(100); }
  const speech = await synthesizePolly({ text: c.say, lang: c.lang, format: 'pcm' });
  if (!speech || speech.sampleRateHz !== 16000) throw new Error('Polly did not return 16 kHz PCM');
  const audio = Buffer.from(speech.audioB64, 'base64');
  // The widget streams continuously: speech, then silence until Vitana has
  // answered and any tool round has finished (a hand-off takes two).
  let finished = false;
  const deadline = Date.now() + 30_000;
  const waitTurn = () => new Promise<void>((r) => { turnDone = () => { turnDone = null; r(); }; });
  let turn = waitTurn().then(() => { finished = true; });
  for (let o = 0; o < audio.length; o += 3200) { client.sendAudioChunk(audio.subarray(o, o + 3200).toString('base64')); await sleep(100); }
  while (Date.now() < deadline) {
    client.sendAudioChunk(silence);
    await sleep(100);
    if (finished && toolsInFlight === 0) {
      // A tool call ends Nova's turn early; the answer to the tool result is
      // a further turn. Give it a moment to start before calling it done.
      const before = said.length + steps.length;
      await sleep(2500);
      if (said.length + steps.length === before && toolsInFlight === 0) break;
      finished = false;
      turn = waitTurn().then(() => { finished = true; });
    }
  }
  void turn;
  await client.close('redirect_suite_done').catch(() => {});
  return {
    ...base, path: 'nova', ...grade(c, steps), heard: heard.trim() || null, said: said.trim(), steps, ms: Date.now() - started,
    note: upstreamError ? `upstream: ${upstreamError}` : undefined,
  };
}

main().catch((e) => { console.error(e); process.exit(1); });
