/**
 * VTID-04424 (Plan v1 WS-3.1) — how can new information reach Nova Sonic in
 * the middle of a conversation without Nova treating it as a turn to answer?
 *
 * A time-boxed technical probe. It opens REAL Nova 2 Sonic streams through
 * the gateway's own `NovaSonicLiveClient` (same protocol builders, same
 * region/model pin), plays Polly-synthesised user utterances into the
 * long-lived audio block at real-time pace, and records, per scenario:
 *
 *   - unsolicited responses: assistant audio that starts while no user
 *     utterance is pending (the "duplicate response" failure);
 *   - latency: end of the user's audio → first assistant audio chunk;
 *   - recall: whether the answer used the injected fact;
 *   - errors, content-filter blocks included, verbatim (bounded).
 *
 * Scenarios (see SCENARIOS): baseline, three shapes of mid-session text
 * injection, instant vs delayed tool results (pre-fetching), a model-called
 * `get_guidance` tool, a health-flavoured guidance note, and a second
 * `promptStart` with a changed tool list.
 *
 * Synthetic content only — no user data, no database, no gateway. It talks
 * to Bedrock (eu-north-1) and Polly (eu-central-1) with the caller's AWS
 * credentials and writes a JSON report.
 *
 *   npx tsx scripts/nova-midsession-probe.ts --runs=3 --out=/tmp/probe.json
 *   npx tsx scripts/nova-midsession-probe.ts --only=inject_system_noninteractive
 */

import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { NovaSonicLiveClient } from '../src/orb/live/upstream/nova-sonic-live-client';
import { getNovaSonicConfig } from '../src/orb/live/upstream/nova-sonic-config';
import {
  buildAudioContentStart,
  buildContentEnd,
  buildPromptEnd,
  buildPromptStart,
  buildTextContentStart,
  buildTextInput,
  convertToolsToNovaSpecs,
} from '../src/orb/live/upstream/nova-sonic-protocol';

// ── audio ────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 16_000;
const FRAME_MS = 32;
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000; // 1024
const SILENCE = Buffer.alloc(FRAME_BYTES);

const polly = new PollyClient({ region: process.env.PROBE_POLLY_REGION || 'eu-central-1' });
const speechCache = new Map<string, Buffer>();

async function speech(text: string): Promise<Buffer> {
  const hit = speechCache.get(text);
  if (hit) return hit;
  const res = await polly.send(new SynthesizeSpeechCommand({
    Text: text,
    VoiceId: 'Joanna',
    Engine: 'neural',
    OutputFormat: 'pcm',
    SampleRate: String(SAMPLE_RATE),
  }));
  const bytes = Buffer.from(await res.AudioStream!.transformToByteArray());
  speechCache.set(text, bytes);
  return bytes;
}

// ── scenario model ───────────────────────────────────────────────────────

type Step =
  | { kind: 'say'; text: string; label: string }
  | { kind: 'waitResponse'; timeoutMs: number }
  | { kind: 'silence'; ms: number }
  | { kind: 'inject'; role: 'SYSTEM' | 'USER' | 'ASSISTANT'; interactive: boolean; text: string }
  | { kind: 'repromptTools'; tools: ToolDecl[] }
  | { kind: 'rolloverPrompt'; tools: ToolDecl[]; system: string };

interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface Scenario {
  id: string;
  question: string;
  system: string;
  tools: ToolDecl[];
  /** name → [delayMs, output JSON] */
  toolResults?: Record<string, { delayMs: number; output: Record<string, unknown> }>;
  steps: Step[];
  /** Regex the answer to the probe question must match to count as recall. */
  recall: RegExp;
}

const FACT_RE = /\b(seven|7)\b/i;
const Q_STREAK = 'How long is my diary streak right now?';
const HELLO = 'Hi there, I just opened the app.';

const BASE_SYSTEM = [
  'You are Vitana, a warm voice assistant in a wellness app. Keep every answer to one or two short sentences.',
  'Only state facts about the user that you were given. If you do not know something about the user, say you do not know.',
].join(' ');

const STREAK_TOOL: ToolDecl = {
  name: 'get_diary_streak',
  description: "Returns the user's current diary streak in days. Call it whenever the user asks about their diary streak.",
  parameters: { type: 'object', properties: {} },
};

const GUIDANCE_TOOL: ToolDecl = {
  name: 'get_guidance',
  description: 'Returns a short guidance note about this user from the conversation brain: facts to use and the next step to propose. Call it before answering any question about the user themselves.',
  parameters: { type: 'object', properties: { topic: { type: 'string', description: 'What the user asked about, in a few words.' } } },
};

const NOTE_FACT = "Context update for you, not for the user: the user's diary streak is 7 days. Do not respond to this note; use it only if the user asks.";
const NOTE_HEALTH = "Context update for you, not for the user: last night the user slept 5 hours and their resting heart rate was 8 beats above their usual. Their diary streak is 7 days. If it fits the conversation, you may propose a short breathing exercise. Do not respond to this note; use it only when relevant.";

function injectScenario(id: string, role: 'SYSTEM' | 'USER' | 'ASSISTANT', interactive: boolean, note = NOTE_FACT): Scenario {
  return {
    id,
    question: Q_STREAK,
    system: BASE_SYSTEM,
    tools: [],
    steps: [
      { kind: 'say', text: HELLO, label: 'hello' },
      { kind: 'waitResponse', timeoutMs: 15_000 },
      { kind: 'silence', ms: 1_500 },
      { kind: 'inject', role, interactive, text: note },
      // Watch window: any assistant audio here is an unsolicited response.
      { kind: 'silence', ms: 7_000 },
      { kind: 'say', text: Q_STREAK, label: 'question' },
      { kind: 'waitResponse', timeoutMs: 15_000 },
      { kind: 'silence', ms: 6_000 },
    ],
    recall: FACT_RE,
  };
}

function toolScenario(id: string, delayMs: number): Scenario {
  return {
    id,
    question: Q_STREAK,
    system: BASE_SYSTEM,
    tools: [STREAK_TOOL],
    toolResults: { get_diary_streak: { delayMs, output: { streak_days: 7 } } },
    steps: [
      { kind: 'say', text: HELLO, label: 'hello' },
      { kind: 'waitResponse', timeoutMs: 15_000 },
      { kind: 'silence', ms: 1_500 },
      { kind: 'say', text: Q_STREAK, label: 'question' },
      { kind: 'waitResponse', timeoutMs: 20_000 },
      { kind: 'silence', ms: 6_000 },
    ],
    recall: FACT_RE,
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'baseline_fact_in_system_prompt',
    question: Q_STREAK,
    system: `${BASE_SYSTEM} The user's diary streak is 7 days.`,
    tools: [],
    steps: [
      { kind: 'say', text: HELLO, label: 'hello' },
      { kind: 'waitResponse', timeoutMs: 15_000 },
      { kind: 'silence', ms: 1_500 },
      { kind: 'say', text: Q_STREAK, label: 'question' },
      { kind: 'waitResponse', timeoutMs: 15_000 },
      { kind: 'silence', ms: 6_000 },
    ],
    recall: FACT_RE,
  },
  injectScenario('inject_system_noninteractive', 'SYSTEM', false),
  injectScenario('inject_user_noninteractive', 'USER', false),
  injectScenario('inject_system_interactive', 'SYSTEM', true),
  injectScenario('inject_user_interactive', 'USER', true),
  injectScenario('inject_assistant_noninteractive', 'ASSISTANT', false),
  injectScenario('inject_user_noninteractive_health_note', 'USER', false, NOTE_HEALTH),
  toolScenario('tool_prefetched_instant', 0),
  toolScenario('tool_fetched_1500ms', 1_500),
  {
    id: 'get_guidance_tool',
    question: Q_STREAK,
    system: `${BASE_SYSTEM} Before answering any question about the user themselves, call get_guidance and follow its note in your own words.`,
    tools: [GUIDANCE_TOOL],
    toolResults: {
      get_guidance: {
        delayMs: 0,
        output: { note: "The user's diary streak is 7 days. State it plainly, then propose logging today's entry and wait for their answer." },
      },
    },
    steps: [
      { kind: 'say', text: HELLO, label: 'hello' },
      { kind: 'waitResponse', timeoutMs: 15_000 },
      { kind: 'silence', ms: 1_500 },
      { kind: 'say', text: Q_STREAK, label: 'question' },
      { kind: 'waitResponse', timeoutMs: 20_000 },
      { kind: 'silence', ms: 6_000 },
    ],
    recall: FACT_RE,
  },
  {
    id: 'get_guidance_tool_health_note',
    question: Q_STREAK,
    system: `${BASE_SYSTEM} Before answering any question about the user themselves, call get_guidance and follow its note in your own words.`,
    tools: [GUIDANCE_TOOL],
    toolResults: {
      get_guidance: {
        delayMs: 0,
        output: { note: "Last night the user slept 5 hours and their resting heart rate was 8 beats above their usual. Their diary streak is 7 days. Answer the question, then propose a two-minute breathing exercise and wait for their answer." },
      },
    },
    steps: [
      { kind: 'say', text: HELLO, label: 'hello' },
      { kind: 'waitResponse', timeoutMs: 15_000 },
      { kind: 'silence', ms: 1_500 },
      { kind: 'say', text: Q_STREAK, label: 'question' },
      { kind: 'waitResponse', timeoutMs: 20_000 },
      { kind: 'silence', ms: 6_000 },
    ],
    recall: FACT_RE,
  },
  {
    id: 'prompt_rollover_new_tools',
    question: Q_STREAK,
    system: BASE_SYSTEM,
    tools: [],
    toolResults: { get_diary_streak: { delayMs: 0, output: { streak_days: 7 } } },
    steps: [
      { kind: 'say', text: HELLO, label: 'hello' },
      { kind: 'waitResponse', timeoutMs: 15_000 },
      { kind: 'silence', ms: 1_500 },
      { kind: 'rolloverPrompt', tools: [STREAK_TOOL], system: BASE_SYSTEM },
      { kind: 'silence', ms: 3_000 },
      { kind: 'say', text: Q_STREAK, label: 'question' },
      { kind: 'waitResponse', timeoutMs: 15_000 },
      { kind: 'silence', ms: 6_000 },
    ],
    recall: FACT_RE,
  },
  {
    id: 'tool_list_change_midsession',
    question: Q_STREAK,
    system: BASE_SYSTEM,
    tools: [],
    toolResults: { get_diary_streak: { delayMs: 0, output: { streak_days: 7 } } },
    steps: [
      { kind: 'say', text: HELLO, label: 'hello' },
      { kind: 'waitResponse', timeoutMs: 15_000 },
      { kind: 'silence', ms: 1_500 },
      { kind: 'repromptTools', tools: [STREAK_TOOL] },
      { kind: 'silence', ms: 3_000 },
      { kind: 'say', text: Q_STREAK, label: 'question' },
      { kind: 'waitResponse', timeoutMs: 15_000 },
      { kind: 'silence', ms: 6_000 },
    ],
    recall: FACT_RE,
  },
];

// ── one session ──────────────────────────────────────────────────────────

interface LogEntry { t: number; type: string; detail?: unknown }

export interface RunResult {
  scenario: string;
  run: number;
  connected: boolean;
  errors: Array<{ t: number; code: string; diagnostic?: string }>;
  content_filter_blocked: boolean;
  closed: { t: number; reason?: string } | null;
  responses: Array<{ start: number; end: number; chunks: number; after: string; playback_ms: number }>;
  unsolicited_responses: number;
  question_latency_ms: number | null;
  hello_latency_ms: number | null;
  tool_calls: Array<{ t: number; name: string; args: unknown; answered_at?: number }>;
  tool_to_audio_ms: number | null;
  question_answer_text: string;
  recall: boolean;
  transcripts: Array<{ t: number; dir: string; text: string }>;
  log: LogEntry[];
}

async function runScenario(sc: Scenario, run: number): Promise<RunResult> {
  const config = getNovaSonicConfig({ ...process.env, NOVA_SONIC_ENABLED: 'true' });
  const client = new NovaSonicLiveClient({ config, voiceId: 'tiffany' });
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const log: LogEntry[] = [];
  const result: RunResult = {
    scenario: sc.id, run, connected: false, errors: [], content_filter_blocked: false, closed: null,
    responses: [], unsolicited_responses: 0, question_latency_ms: null, hello_latency_ms: null,
    tool_calls: [], tool_to_audio_ms: null, question_answer_text: '', recall: false, transcripts: [], log,
  };

  // Audio pump: one 32 ms frame per tick, speech when queued, silence otherwise.
  let pending: Buffer[] = [];
  let lastUserAudioEnd: { label: string; t: number } | null = null;
  let currentUtterance: string | null = null;
  let closed = false;
  const pump = setInterval(() => {
    if (closed) return;
    let frame = SILENCE;
    if (pending.length) {
      frame = pending.shift()!;
      if (!pending.length && currentUtterance) {
        lastUserAudioEnd = { label: currentUtterance, t: now() };
        if (currentUtterance === 'question') questionAudioEnd = now();
        log.push({ t: now(), type: 'user_audio_end', detail: currentUtterance });
        currentUtterance = null;
      }
    }
    client.sendAudioChunk(frame.toString('base64'));
  }, FRAME_MS);

  // Response segmentation: audio chunks with gaps < 2 s belong to one response.
  let lastAudioAt = -Infinity;
  let pendingUserTurn: string | null = null; // set on user_audio_end, cleared by the first response after it
  let questionAnswerStart: number | null = null;
  let questionAudioEnd: number | null = null;
  const onAudio = (bytes: number) => {
    const t = now();
    if (t - lastAudioAt > 2_000) {
      const after = pendingUserTurn ?? 'none';
      result.responses.push({ start: t, end: t, chunks: 1, after, playback_ms: Math.round(bytes / 48) });
      if (!pendingUserTurn) {
        result.unsolicited_responses += 1;
        log.push({ t, type: 'unsolicited_response_start' });
      } else if (lastUserAudioEnd) {
        const lat = t - lastUserAudioEnd.t;
        if (pendingUserTurn === 'question') {
          result.question_latency_ms = lat;
          questionAnswerStart = t;
        }
        if (pendingUserTurn === 'hello') result.hello_latency_ms = lat;
        const lastTool = result.tool_calls[result.tool_calls.length - 1];
        if (lastTool?.answered_at !== undefined && pendingUserTurn === 'question') {
          result.tool_to_audio_ms = t - lastTool.answered_at;
        }
      }
      pendingUserTurn = null;
    } else {
      const r = result.responses[result.responses.length - 1];
      r.end = t;
      r.chunks += 1;
      r.playback_ms += Math.round(bytes / 48);
    }
    lastAudioAt = t;
  };

  let responseWaiters: Array<() => void> = [];
  client.onAudioOutput((e) => onAudio(Math.floor((e.dataB64.length * 3) / 4)));
  client.onTurnComplete(() => {
    log.push({ t: now(), type: 'turn_complete' });
    const ws = responseWaiters; responseWaiters = [];
    ws.forEach((w) => w());
  });
  client.onTranscript((e) => {
    if (!e.isFinal) return;
    result.transcripts.push({ t: now(), dir: e.direction, text: e.text });
    if (e.direction === 'output' && questionAudioEnd !== null && !/^\s*\{/.test(e.text)) {
      result.question_answer_text += (result.question_answer_text ? ' ' : '') + e.text;
    }
  });
  client.onToolCall((e) => {
    for (const call of e.calls) {
      const rec: RunResult['tool_calls'][number] = { t: now(), name: call.name, args: call.args };
      result.tool_calls.push(rec);
      log.push({ t: rec.t, type: 'tool_call', detail: call.name });
      const spec = sc.toolResults?.[call.name];
      const answer = () => {
        rec.answered_at = now();
        client.sendToolResult({
          callId: call.id, name: call.name, success: !!spec,
          output: JSON.stringify(spec?.output ?? { error: 'unknown tool' }),
        });
      };
      if (spec && spec.delayMs > 0) setTimeout(answer, spec.delayMs); else answer();
    }
  });
  client.onError((e) => {
    const diag = (e.diagnostic || e.message || '').slice(0, 300);
    result.errors.push({ t: now(), code: e.code, diagnostic: diag });
    if (/content filter/i.test(diag)) result.content_filter_blocked = true;
    log.push({ t: now(), type: 'error', detail: { code: e.code, diag } });
  });
  client.onClose((e) => {
    closed = true;
    result.closed = { t: now(), reason: (e as { reason?: string }).reason };
    const ws = responseWaiters; responseWaiters = [];
    ws.forEach((w) => w());
  });

  const toolWire = sc.tools.length ? [{ function_declarations: sc.tools }] : undefined;
  try {
    await client.connect({ model: 'nova', systemInstruction: sc.system, tools: toolWire } as never);
    result.connected = true;
  } catch (err) {
    clearInterval(pump);
    result.errors.push({ t: now(), code: 'connect_failed', diagnostic: String((err as { diagnostic?: string }).diagnostic ?? err).slice(0, 300) });
    return result;
  }

  const queue = (client as unknown as { queue: { push(e: unknown): void } }).queue;
  const promptName = (client as unknown as { promptName: string }).promptName;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const step of sc.steps) {
    if (closed) break;
    if (step.kind === 'say') {
      const pcm = await speech(step.text);
      const frames: Buffer[] = [];
      for (let i = 0; i < pcm.length; i += FRAME_BYTES) {
        const f = Buffer.alloc(FRAME_BYTES);
        pcm.copy(f, 0, i, Math.min(i + FRAME_BYTES, pcm.length));
        frames.push(f);
      }
      currentUtterance = step.label;
      pending = frames;
      log.push({ t: now(), type: 'user_audio_start', detail: step.label });
      while (pending.length && !closed) await sleep(FRAME_MS);
      pendingUserTurn = step.label;
    } else if (step.kind === 'waitResponse') {
      await Promise.race([new Promise<void>((r) => responseWaiters.push(r)), sleep(step.timeoutMs)]);
      // The real client plays audio in real time; Nova streams it faster.
      // Hold the next user turn until playback of the latest response would
      // have ended, or the next turn becomes an accidental barge-in.
      const last = result.responses[result.responses.length - 1];
      if (last) {
        const playbackEnd = last.start + last.playback_ms;
        if (playbackEnd > now()) await sleep(playbackEnd - now());
      }
    } else if (step.kind === 'silence') {
      await sleep(step.ms);
    } else if (step.kind === 'inject') {
      const contentName = randomUUID();
      log.push({ t: now(), type: 'inject', detail: { role: step.role, interactive: step.interactive } });
      queue.push(buildTextContentStart({ promptName, contentName, role: step.role, interactive: step.interactive }));
      queue.push(buildTextInput({ promptName, contentName, content: step.text }));
      queue.push(buildContentEnd({ promptName, contentName }));
    } else if (step.kind === 'rolloverPrompt') {
      // End the current prompt and open a new one in the SAME stream, with a
      // new tool list and system block — the only other way a tool list could
      // change without reconnecting.
      const c = client as unknown as { promptName: string; audioContentName: string };
      const oldPrompt = c.promptName;
      const newPrompt = randomUUID();
      const newAudio = randomUUID();
      const sys = randomUUID();
      log.push({ t: now(), type: 'rollover_prompt', detail: step.tools.map((t) => t.name) });
      queue.push(buildContentEnd({ promptName: oldPrompt, contentName: c.audioContentName }));
      queue.push(buildPromptEnd(oldPrompt));
      queue.push(buildPromptStart({
        promptName: newPrompt, voiceId: 'tiffany',
        tools: convertToolsToNovaSpecs([{ function_declarations: step.tools }]),
      }));
      queue.push(buildTextContentStart({ promptName: newPrompt, contentName: sys, role: 'SYSTEM', interactive: false }));
      queue.push(buildTextInput({ promptName: newPrompt, contentName: sys, content: step.system }));
      queue.push(buildContentEnd({ promptName: newPrompt, contentName: sys }));
      queue.push(buildAudioContentStart({ promptName: newPrompt, contentName: newAudio }));
      c.promptName = newPrompt;
      c.audioContentName = newAudio;
    } else if (step.kind === 'repromptTools') {
      log.push({ t: now(), type: 'reprompt_tools', detail: step.tools.map((t) => t.name) });
      queue.push(buildPromptStart({
        promptName, voiceId: 'tiffany',
        tools: convertToolsToNovaSpecs([{ function_declarations: step.tools }]),
      }));
    }
  }

  clearInterval(pump);
  if (!closed) await client.close('probe_done').catch(() => undefined);
  result.recall = sc.recall.test(result.question_answer_text);
  return result;
}

// ── driver ───────────────────────────────────────────────────────────────

export function summarize(results: RunResult[]) {
  const by = new Map<string, RunResult[]>();
  for (const r of results) by.set(r.scenario, [...(by.get(r.scenario) ?? []), r]);
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return [...by.entries()].map(([scenario, rs]) => ({
    scenario,
    runs: rs.length,
    connected: rs.filter((r) => r.connected).length,
    errored: rs.filter((r) => r.errors.length > 0).length,
    content_filter_blocked: rs.filter((r) => r.content_filter_blocked).length,
    unsolicited_responses: rs.reduce((n, r) => n + r.unsolicited_responses, 0),
    answered: rs.filter((r) => r.question_latency_ms !== null).length,
    recall: rs.filter((r) => r.recall).length,
    question_latency_ms_median: median(rs.map((r) => r.question_latency_ms).filter((x): x is number => x !== null)),
    tool_calls: rs.reduce((n, r) => n + r.tool_calls.length, 0),
    tool_to_audio_ms_median: median(rs.map((r) => r.tool_to_audio_ms).filter((x): x is number => x !== null)),
    first_errors: rs.flatMap((r) => r.errors.map((e) => `${e.code}: ${e.diagnostic ?? ''}`)).slice(0, 3),
  }));
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }));
  const runs = Math.max(1, Number(args.runs ?? 1));
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const concurrency = Math.max(1, Number(args.concurrency ?? 3));
  const out = String(args.out ?? 'nova-midsession-probe.json');

  const jobs: Array<{ sc: Scenario; run: number }> = [];
  for (const sc of SCENARIOS) {
    if (only && !only.has(sc.id)) continue;
    for (let i = 1; i <= runs; i++) jobs.push({ sc, run: i });
  }

  const results: RunResult[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const r = await runScenario(job.sc, job.run);
      console.log(`[probe] ${job.sc.id}#${job.run} connected=${r.connected} errors=${r.errors.length} unsolicited=${r.unsolicited_responses} latency=${r.question_latency_ms} recall=${r.recall} tools=${r.tool_calls.map((c) => c.name).join('|')}`);
      results.push(r);
    }
  }));

  const summary = summarize(results);
  writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), summary, results }, null, 2));
  console.table(summary.map(({ first_errors, ...s }) => s));
  for (const s of summary) if (s.first_errors.length) console.log(s.scenario, s.first_errors);
  console.log(`report: ${out}`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
