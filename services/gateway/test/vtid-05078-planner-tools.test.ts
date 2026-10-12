/**
 * VTID-05078 (Dev Autopilot autonomy, Phase B): the planner reads both
 * repositories and the codebase index through read-only tools, within a fixed
 * budget, with the read-only token only; plan paths are validated (B3) and a
 * community-app change goes to a human (B4).
 */
import fs from 'fs';
import path from 'path';
import {
  COMMUNITY_APP_PATH_PREFIX,
  PLANNER_DEADLINE_MS,
  PLANNER_MAX_TOOL_CALLS,
  checkPlanPaths,
  createPlannerToolExecutor,
  pathFeedback,
  plannerRouterTools,
  plannerToolsEnabled,
  readPlanPathEntries,
  resolveMainRefs,
} from '../src/services/dev-autopilot/planner-tools';
import { buildPlanningPrompt } from '../src/services/dev-autopilot-planning';

const SHA_P = 'a'.repeat(40);
const SHA_V1 = 'b'.repeat(40);

function fakeFetch(handler: (url: string, headers: Record<string, string>) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
    const headers = init?.headers || {};
    calls.push({ url, headers });
    const r = handler(url, headers);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return { impl, calls };
}

describe('VTID-05078 tools are on only with the read-only token', () => {
  it('no PLAN_SPARRING_GITHUB_TOKEN → off, even when the merge token exists', () => {
    expect(plannerToolsEnabled({})).toBe(false);
    expect(plannerToolsEnabled({ GITHUB_SAFE_MERGE_TOKEN: 'x', GITHUB_TOKEN: 'y' })).toBe(false);
  });
  it('the read-only token turns them on; DEV_PLANNER_TOOLS_ENABLED=false turns them off again', () => {
    expect(plannerToolsEnabled({ PLAN_SPARRING_GITHUB_TOKEN: 'ro' })).toBe(true);
    expect(plannerToolsEnabled({ PLAN_SPARRING_GITHUB_TOKEN: 'ro', DEV_PLANNER_TOOLS_ENABLED: 'false' })).toBe(false);
  });
  it('the tool list is the six read-only tools on both repos', () => {
    const tools = plannerRouterTools();
    expect(tools.map((t) => t.name)).toEqual(['read_file', 'list_dir', 'search', 'dev_index_query', 'dev_graph_path', 'dev_get_risk']);
    const repoEnum = (tools[0].inputSchema as any).properties.repo.enum;
    expect(repoEnum).toEqual(['exafyltd/vitana-platform', 'exafyltd/vitana-v1']);
  });
  it('the budget is 12 tool calls and 90 seconds', () => {
    expect(PLANNER_MAX_TOOL_CALLS).toBe(12);
    expect(PLANNER_DEADLINE_MS).toBe(90_000);
  });
});

describe('VTID-05078 main refs and the tool executor', () => {
  it('resolveMainRefs pins each repo to its main commit; a failed repo is left out', async () => {
    const f = fakeFetch((url) => url.includes('vitana-v1') ? { status: 500, body: {} } : { status: 200, body: { sha: SHA_P } });
    const refs = await resolveMainRefs({ token: 'ro', fetchImpl: f.impl as any });
    expect(refs).toEqual({ 'exafyltd/vitana-platform': SHA_P });
    expect(f.calls.every((c) => c.headers.Authorization === 'Bearer ro')).toBe(true);
    expect(await resolveMainRefs({ token: '', fetchImpl: f.impl as any })).toEqual({});
  });

  it('read_file on vitana-v1 reads at the pinned commit with the read-only token', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { type: 'file', encoding: 'base64', content: Buffer.from('line1\nline2').toString('base64') } }));
    const exec = createPlannerToolExecutor({ refs: { 'exafyltd/vitana-platform': SHA_P, 'exafyltd/vitana-v1': SHA_V1 }, token: 'ro', fetchImpl: f.impl as any });
    const r = await exec('read_file', { repo: 'exafyltd/vitana-v1', path: 'src/App.tsx' });
    expect(r.isError).toBe(false);
    expect(r.result).toContain('line2');
    expect(f.calls[0].url).toContain(`/repos/exafyltd/vitana-v1/contents/src/App.tsx?ref=${SHA_V1}`);
    expect(f.calls[0].headers.Authorization).toBe('Bearer ro');
  });

  it('refuses a repo outside the allowlist and works without a token only as an error', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const exec = createPlannerToolExecutor({ refs: { 'exafyltd/other': SHA_P }, token: 'ro', fetchImpl: f.impl as any });
    expect((await exec('read_file', { repo: 'exafyltd/other', path: 'a.ts' })).isError).toBe(true);
    const noToken = createPlannerToolExecutor({ refs: {}, token: '', fetchImpl: f.impl as any });
    const r = await noToken('list_dir', { repo: 'exafyltd/vitana-platform', path: '' });
    expect(r.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it('code index tools go to the loaded bundle; an unpublished index is a tool error, not a failure', async () => {
    const exec = createPlannerToolExecutor({
      refs: {},
      token: 'ro',
      loadIndex: async (repo) => {
        if (repo === 'exafyltd/vitana-v1') throw new Error('code index not published for exafyltd/vitana-v1');
        return { bundle: { sha: SHA_P } as any, fromCache: true, source: 'test', loadMs: 0 };
      },
    });
    const missing = await exec('dev_get_risk', { path: 'src/App.tsx', repo: 'exafyltd/vitana-v1' });
    expect(missing.isError).toBe(true);
    expect(missing.result).toMatch(/code index not available for exafyltd\/vitana-v1/);
  });
});

describe('VTID-05078 plan path validation (B3) and community-app routing (B4)', () => {
  const plan = [
    '## Context', 'x', '',
    '## Files to modify',
    '- services/gateway/src/routes/a.ts',
    '- services/gateway/test/a.test.ts (new)',
    `- ${COMMUNITY_APP_PATH_PREFIX}src/pages/Home.tsx`,
    '', '## Verification', '- tests',
  ].join('\n');

  it('reads entries with their new and community-app markers', () => {
    expect(readPlanPathEntries(plan)).toEqual([
      { path: 'services/gateway/src/routes/a.ts', isNew: false, communityApp: false },
      { path: 'services/gateway/test/a.test.ts', isNew: true, communityApp: false },
      { path: 'src/pages/Home.tsx', isNew: false, communityApp: true },
    ]);
  });

  it('a missing path, a "new" path that exists and a denied path are each a problem', async () => {
    const entries = [
      { path: 'services/gateway/src/missing.ts', isNew: false, communityApp: false },
      { path: 'services/gateway/src/exists.ts', isNew: true, communityApp: false },
      { path: 'supabase/migrations/2026_x.sql', isNew: true, communityApp: false },
    ];
    const r = await checkPlanPaths(entries, {
      deny: ['supabase/migrations/**'],
      exists: async (p) => p.endsWith('exists.ts'),
    });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      'services/gateway/src/missing.ts does not exist at main (mark it "(new)" if the plan creates it)',
      'services/gateway/src/exists.ts is marked new but already exists at main',
      'supabase/migrations/2026_x.sql is in the deny scope — the autopilot may not change it',
    ]);
    expect(pathFeedback(r.problems)).toContain('Mark a file the plan creates with "(new)"');
  });

  it('an unanswerable existence check never fails a plan; a community-app path is flagged, not checked', async () => {
    const seen: string[] = [];
    const r = await checkPlanPaths(readPlanPathEntries(plan), {
      deny: [],
      exists: async (p) => { seen.push(p); return p.endsWith('a.ts') ? null : false; },
    });
    expect(r.ok).toBe(true);
    expect(r.communityApp).toBe(true);
    expect(seen).not.toContain('src/pages/Home.tsx');
  });
});

describe('VTID-05078 prompt and wiring', () => {
  const finding = { id: 'f1', title: 't', summary: 's', domain: 'd', risk_class: 'low', spec_snapshot: { file_path: 'services/gateway/src/a.ts', scanner: 'todo-scanner-v1' } } as any;

  it('with tools the prompt explains them and drops "Do NOT ask to see other files"; without, it keeps the old text', () => {
    const withTools = buildPlanningPrompt(finding, undefined, undefined, undefined, [], '', '', '', { toolsEnabled: true });
    expect(withTools).toContain('## Your tools (read-only)');
    expect(withTools).toContain(COMMUNITY_APP_PATH_PREFIX);
    expect(withTools).not.toContain('Do NOT ask to see other');
    const without = buildPlanningPrompt(finding);
    expect(without).toContain('Do NOT ask to see other');
    expect(without).not.toContain('## Your tools (read-only)');
  });

  it('the planner loop keeps the Phase A model choice and the budget, and validates paths before persisting', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/dev-autopilot-planning.ts'), 'utf8');
    const loop = src.slice(src.indexOf('async function callPlannerWithTools('), src.indexOf('/** VTID-05077: what one planner call returned'));
    for (const s of ['maxToolCalls: PLANNER_MAX_TOOL_CALLS', 'deadlineMs: PLANNER_DEADLINE_MS', 'fallbackOverride: { provider: fallback.provider, model: fallback.model }', "deepseekThinking: 'disabled' as const", 'execute: createPlannerToolExecutor({ refs })']) {
      expect(loop).toContain(s);
    }
    expect(src).toContain('const toolsOn = plannerToolsEnabled() && !isWorkerQueueEnabled();');
    const validate = src.indexOf('let check = await checkPlanPaths(pathEntries');
    const persist = src.indexOf("'/rest/v1/dev_autopilot_plan_versions', {");
    expect(validate).toBeGreaterThan(-1);
    expect(persist).toBeGreaterThan(validate);
    expect(src).toContain("type: 'dev_autopilot.plan.needs_human'");
  });
});
