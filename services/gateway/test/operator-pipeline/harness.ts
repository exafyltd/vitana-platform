/**
 * VTID-04465 — the edges of the operator pipeline, and the controls a scenario
 * turns.
 *
 * The suite runs the real code of every stage. What is replaced is what lies
 * OUTSIDE the pipeline, and each replacement is here so its reason sits next
 * to it:
 *
 *   - the LLM (`llm-router.callViaRouter`) — a scripted model. The operator
 *     stage plays the console model choosing a tool; the worker stage plays the
 *     DeepSeek agent issuing read_file / edit_file / run_check / finish. Every
 *     other stage is refused and recorded, so an unexpected model call fails
 *     loudly instead of being answered.
 *   - the git clone the agent works in (`agent-workspace`) — a real temp
 *     directory seeded from the fake GitHub; the agent's real tools read and
 *     edit real files in it. Clone / diff / commit / push are emulated against
 *     the fake GitHub instead of shelling out to git.
 *   - tsc / jest inside that clone (`agent-validate`) — scripted results; the
 *     runner's real decision logic (which checks, what a failure does) stays.
 *   - the agent's memory pack and memory write (`agent-memory-context`) — they
 *     call the memory LLM stage and the bootstrap pack over the network.
 *   - the self-healing triage agent (`self-healing-triage-service`) — an LLM
 *     investigation; the bridge's real decision on its report stays.
 *   - dev_agent_memory recall/write (`dev-agent-memory`) — embeddings.
 *   - VITANA_ENV (`env`) — a getter, so one process can play staging and then
 *     production for the env-ownership scenario.
 *
 * jest.mock factories in the suite `require()` this module, so the controls
 * below are the same objects the mocked modules read.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OperatorPlatform } from './fake-operator-platform';

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

export const envState: { env: 'staging' | 'production' } = { env: 'staging' };

export const current: { platform: OperatorPlatform | null } = { platform: null };

function platform(): OperatorPlatform {
  if (!current.platform) throw new Error('harness: no platform installed for this test');
  return current.platform;
}

// ---------------------------------------------------------------------------
// Scripted model
// ---------------------------------------------------------------------------

export interface RouterToolCall { name: string; arguments: Record<string, unknown>; id?: string }
export interface RouterResult {
  ok: boolean;
  text?: string;
  toolCalls?: RouterToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  provider?: string;
  model?: string;
  fallbackUsed?: boolean;
  error?: string;
}
export interface ModelCallCtx {
  stage: string;
  prompt: string;
  opts: Record<string, any>;
  /** 0-based index of this call within the current worker run / operator queue. */
  turn: number;
}
export type Step = RouterResult | ((ctx: ModelCallCtx) => RouterResult | Promise<RouterResult>);
/** A worker run: a fixed list of turns, or a function of the turn index. */
export type WorkerRun = Step[] | ((ctx: ModelCallCtx) => RouterResult | Promise<RouterResult>);

let callSeq = 0;

/** A DeepSeek-style turn that asks for tool calls. */
export function tools(...calls: Array<[string, Record<string, unknown>]>): RouterResult {
  return {
    ok: true,
    toolCalls: calls.map(([name, args]) => ({ name, arguments: args, id: `call_${++callSeq}` })),
    provider: 'deepseek',
    model: 'deepseek-flash',
    usage: { inputTokens: 1200, outputTokens: 80 },
  };
}

export function text(t: string): RouterResult {
  return { ok: true, text: t, provider: 'deepseek', model: 'deepseek-flash', usage: { inputTokens: 900, outputTokens: 60 } };
}

export class ScriptedModel {
  readonly calls: Array<{ stage: string; service: string; providerOverride?: string; modelOverride?: string; vtid?: string | null; historyLength: number }> = [];
  readonly refused: Array<{ stage: string; service: string }> = [];
  /** Console plan calls (service `gemini-operator`), consumed in order. */
  operatorPlan: Step[] = [];
  /**
   * VTID-04628: console continuation rounds (service `gemini-operator-continue`),
   * consumed in order. Empty = the model answers in text from the results, as
   * the old single-round final call did.
   */
  operatorContinue: Step[] = [];
  /** Worker runs, one per agent execution, consumed when a run starts. */
  workerRuns: WorkerRun[] = [];
  private run: WorkerRun | null = null;
  private turn = 0;
  private opTurn = 0;

  reset(): void {
    this.calls.length = 0;
    this.refused.length = 0;
    this.operatorPlan = [];
    this.operatorContinue = [];
    this.workerRuns = [];
    this.run = null;
    this.turn = 0;
    this.opTurn = 0;
  }

  workerCalls(): number {
    return this.calls.filter((c) => c.stage === 'worker').length;
  }

  async call(stage: string, prompt: string, opts: Record<string, any> = {}): Promise<RouterResult> {
    const service = String(opts.service || '');
    const history = Array.isArray(opts.history) ? opts.history : [];
    this.calls.push({ stage, service, providerOverride: opts.providerOverride, modelOverride: opts.modelOverride, vtid: opts.vtid, historyLength: history.length });

    if (stage === 'operator' && service === 'gemini-operator') {
      const step = this.operatorPlan[this.opTurn];
      const ctx = { stage, prompt, opts, turn: this.opTurn++ };
      if (!step) return text('I have nothing scripted for this turn.');
      return typeof step === 'function' ? step(ctx) : step;
    }
    if (stage === 'operator' && service === 'gemini-operator-continue') {
      const step = this.operatorContinue.shift();
      if (!step) return text(`Done. ${prompt.slice(0, 200)}`);
      return typeof step === 'function' ? step({ stage, prompt, opts, turn: this.opTurn }) : step;
    }
    if (stage === 'operator' && service === 'gemini-operator-tool-results') {
      return text(`Done. ${prompt.slice(0, 200)}`);
    }
    if (stage === 'worker' && service === 'autopilot-agent') {
      if (history.length === 0) {
        this.run = this.workerRuns.shift() || null;
        this.turn = 0;
      }
      const run = this.run;
      const ctx = { stage, prompt, opts, turn: this.turn++ };
      if (!run) return { ok: false, error: 'scripted model: no worker run queued' };
      if (typeof run === 'function') return run(ctx);
      const step = run[ctx.turn];
      if (!step) return { ok: false, error: `scripted model: worker run exhausted at turn ${ctx.turn + 1}` };
      return typeof step === 'function' ? step(ctx) : step;
    }
    this.refused.push({ stage, service });
    return { ok: false, error: `scripted model: stage ${stage} (${service}) is not part of this scenario` };
  }
}

export const model = new ScriptedModel();

// ---------------------------------------------------------------------------
// Checks the runner executes inside the clone (tsc / jest / run_check)
// ---------------------------------------------------------------------------

export interface CheckResult { ok: boolean; exit_code: number; output: string }
const PASS: CheckResult = { ok: true, exit_code: 0, output: 'PASS' };

export const checks = {
  tsc: (): CheckResult => PASS,
  jest: (_project: string, _patterns: string[]): CheckResult => PASS,
  run: (_kind: string, _target?: string): CheckResult => PASS,
  log: [] as Array<{ kind: string; target?: string }>,
  reset(): void {
    this.tsc = () => PASS;
    this.jest = () => PASS;
    this.run = () => PASS;
    this.log.length = 0;
  },
};

// ---------------------------------------------------------------------------
// Triage agent
// ---------------------------------------------------------------------------

export const triage = {
  confidence: 0.8,
  calls: [] as Array<Record<string, any>>,
  reset(): void {
    this.confidence = 0.8;
    this.calls.length = 0;
  },
};

// ---------------------------------------------------------------------------
// Fake workspace (the agent's clone)
// ---------------------------------------------------------------------------

const snapshots = new Map<string, Record<string, string>>();
export const workspaceLog: Array<{ op: string; branch?: string; existingBranch?: boolean }> = [];

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(root, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(root);
  return out;
}

function diffFiles(now: Record<string, string>, base: Record<string, string>): Array<{ path: string; action: 'create' | 'modify' | 'delete' }> {
  const out: Array<{ path: string; action: 'create' | 'modify' | 'delete' }> = [];
  for (const p of Object.keys({ ...base, ...now }).sort()) {
    if (!(p in base)) out.push({ path: p, action: 'create' });
    else if (!(p in now)) out.push({ path: p, action: 'delete' });
    else if (base[p] !== now[p]) out.push({ path: p, action: 'modify' });
  }
  return out;
}

export function workspaceModule(): Record<string, unknown> {
  const actual = jest.requireActual('../../src/services/autopilot-agent/agent-workspace');
  return {
    ...actual,
    prepareWorkspace: async (opts: { baseBranch: string; branch: string; existingBranch?: boolean }) => {
      const gh = platform().github;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-04465-ws-'));
      const repoDir = path.join(root, 'repo');
      const files = gh.filesAt(opts.existingBranch ? opts.branch : opts.baseBranch);
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(repoDir, rel)), { recursive: true });
        fs.writeFileSync(path.join(repoDir, rel), content, 'utf8');
      }
      fs.mkdirSync(repoDir, { recursive: true });
      snapshots.set(repoDir, { ...files });
      workspaceLog.push({ op: 'clone', branch: opts.branch, existingBranch: !!opts.existingBranch });
      return { root, repoDir, branch: opts.branch, baseSha: gh.headOf(opts.baseBranch) };
    },
    listChangedFiles: async (repoDir: string) => diffFiles(readTree(repoDir), snapshots.get(repoDir) || {}),
    listChangedFilesSince: async (repoDir: string, baseSha: string) => diffFiles(readTree(repoDir), platform().github.filesAt(baseSha)),
    mergeBaseIntoBranch: async () => ({ status: 'up_to_date', conflicts: [], baseSha: platform().github.headOf('main') }),
    linkNodeModules: async () => 'present',
    pullCodeIndex: async () => ({
      bundle: null,
      describe: null,
      stats: { enabled: false, source: null, sha: null, built_at: null, nodes: 0, edges: 0, risk_files: 0, from_cache: false, ms: 0, error: null },
    }),
    commitAndPush: async (repoDir: string, opts: { branch: string; force?: boolean }) => {
      const tree = readTree(repoDir);
      const sha = platform().github.push(opts.branch, tree, opts.force !== false);
      snapshots.set(repoDir, { ...tree });
      workspaceLog.push({ op: 'push', branch: opts.branch });
      return { sha };
    },
    gitDiffAgainstBase: async (repoDir: string, baseSha: string) => {
      const changed = diffFiles(readTree(repoDir), platform().github.filesAt(baseSha));
      return {
        stat: changed.map((c) => ` ${c.path} | ${c.action}`).join('\n'),
        patch: changed.map((c) => `diff --git a/${c.path} b/${c.path}\n(${c.action})`).join('\n'),
        files: changed.map((c) => c.path),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Module factories
// ---------------------------------------------------------------------------

export function llmRouterModule(): Record<string, unknown> {
  const actual = jest.requireActual('../../src/services/llm-router');
  return { ...actual, callViaRouter: jest.fn((stage: string, prompt: string, opts: Record<string, any>) => model.call(stage, prompt, opts)) };
}

export function validateModule(): Record<string, unknown> {
  const actual = jest.requireActual('../../src/services/autopilot-agent/agent-validate');
  return {
    ...actual,
    runTsc: async () => { checks.log.push({ kind: 'runner:tsc' }); return checks.tsc(); },
    runJest: async (_repoDir: string, project: string, patterns: string[]) => {
      checks.log.push({ kind: 'runner:jest', target: `${project} ${patterns.join(' ')}` });
      return checks.jest(project, patterns);
    },
    makeCheckRunner: () => async (kind: string, target?: string) => { checks.log.push({ kind, target }); return checks.run(kind, target); },
  };
}

export function memoryContextModule(): Record<string, unknown> {
  const actual = jest.requireActual('../../src/services/autopilot-agent/agent-memory-context');
  return {
    ...actual,
    buildAgentMemoryContext: async () => ({
      text: '',
      stats: { enabled: false, total_chars: 0, bootstrap_sections: 0, bootstrap_chars: 0, recall_rows: 0, prior_runs: 0, recall_titles: [], errors: [] },
    }),
    recordAgentRunMemory: async () => ({ written: 0, skipped: 'disabled in the operator pipeline suite' }),
  };
}

export function triageModule(): Record<string, unknown> {
  const actual = jest.requireActual('../../src/services/self-healing-triage-service');
  return {
    ...actual,
    spawnTriageAgent: async (input: Record<string, any>) => {
      triage.calls.push(input);
      const c = triage.confidence;
      return {
        ok: true,
        report: {
          session_id: `triage-${triage.calls.length}`,
          severity: 'warning',
          root_cause_hypothesis: 'the change broke the paired test',
          affected_component: 'services/gateway',
          evidence: [String(input?.original_diagnosis?.error || '').slice(0, 200)],
          recommended_fix: 'fix the failing assertion on the same branch',
          confidence: c >= 0.7 ? 'high' : c >= 0.4 ? 'medium' : 'low',
          confidence_numeric: c,
          elapsed_ms: 1,
          mode: input?.mode,
          raw_output: '',
        },
      };
    },
  };
}

export function devMemoryModule(): Record<string, unknown> {
  const actual = jest.requireActual('../../src/services/dev-agent-memory');
  return {
    ...actual,
    recallDevMemory: async () => ({ ok: true, hits: [] }),
    writeDevMemory: async () => ({ ok: true }),
  };
}

export function envModule(): Record<string, unknown> {
  const actual = jest.requireActual('../../src/env');
  const m: Record<string, unknown> = { ...actual };
  Object.defineProperty(m, 'VITANA_ENV', { enumerable: true, get: () => envState.env });
  Object.defineProperty(m, 'isStaging', { enumerable: true, get: () => envState.env === 'staging' });
  Object.defineProperty(m, 'isProduction', { enumerable: true, get: () => envState.env === 'production' });
  return m;
}
