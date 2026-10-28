/**
 * VTID-05088 — morning check 21 tells "nobody spoke" apart from "memory is
 * broken".
 *
 * On 2026-10-11 row 21 failed with no-memory-writes-24h while the pipeline was
 * healthy: nobody had a voice conversation in that window. The RPC now reports
 * the input side (user_speech_turns_24h, transcript_turns_24h) and the row
 * fails on zero writes only when somebody spoke.
 *
 * The decision logic is exercised by running the row's own bash, taken from
 * the workflow file, against fixture RPC responses.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../../..');
const WF_TEXT = fs.readFileSync(path.join(ROOT, '.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml'), 'utf8');
const MIG = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20261012160000_vtid_05088_ci_memory_health_speech_input.sql'),
  'utf8',
);
const OLD_MIG = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260923140000_vtid_04345_ci_memory_health.sql'),
  'utf8',
);

function row21Script(): string {
  const wf = yaml.load(WF_TEXT) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
  for (const job of Object.values(wf.jobs)) {
    const step = job.steps.find((s) => s.name === '21. Memory system health (VTID-04345)');
    if (step?.run) return step.run;
  }
  throw new Error('row 21 step not found');
}

/** Runs row 21 with curl replaced by a stub that serves `rpc` as the RPC body. */
function runRow21(rpc: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05088-'));
  const fixture = path.join(dir, 'rpc.json');
  fs.writeFileSync(fixture, JSON.stringify(rpc));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // curl -sS -o mem.json -w '%{http_code}' ... → copy the fixture, print 200.
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/bash\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then cp "${fixture}" "$2"; shift; fi; shift; done\nprintf 200\n`,
    { mode: 0o755 },
  );
  const report = path.join(dir, 'report.md');
  execFileSync('bash', ['-c', row21Script()], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPORT: report, SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE: 'k' },
  });
  return fs.readFileSync(report, 'utf8').trim();
}

const healthy = {
  facts_written_24h: 0,
  items_written_24h: 0,
  preferred_language_writes_24h: 0,
  facts_active_2h: 100,
  facts_active_embedded_2h: 99,
  items_2h: 100,
  items_embedded_2h: 97,
  dlq_new_24h: 0,
  context_built_24h: 155,
  context_with_memory_24h: 155,
  context_with_diary_24h: 0,
  ap0910_last_run: new Date().toISOString(),
  user_speech_turns_24h: 0,
  transcript_turns_24h: 0,
};

describe('VTID-05088 row 21 decision', () => {
  it('a quiet day (nobody spoke, nothing written) passes and says so', () => {
    const line = runRow21(healthy);
    expect(line).toMatch(/^\| 21 \| Memory system health \| PASS \|/);
    expect(line).toContain('no user speech in 24h (nothing to remember)');
  });

  it('speech that was written passes', () => {
    const line = runRow21({ ...healthy, user_speech_turns_24h: 15, transcript_turns_24h: 15, items_written_24h: 16 });
    expect(line).toMatch(/\| PASS \|/);
    expect(line).toContain('user speech turns 15, recorded 15');
  });

  it('speech with nothing written fails no-memory-writes-24h', () => {
    const line = runRow21({ ...healthy, user_speech_turns_24h: 5, transcript_turns_24h: 5 });
    expect(line).toMatch(/\| FAIL \|/);
    expect(line).toContain('no-memory-writes-24h;');
    expect(line).not.toContain('speech-not-recorded');
  });

  it('speech that never reached the writer fails speech-not-recorded', () => {
    const line = runRow21({ ...healthy, user_speech_turns_24h: 5, transcript_turns_24h: 0, facts_written_24h: 1 });
    expect(line).toMatch(/\| FAIL \|/);
    expect(line).toContain('speech-not-recorded;');
  });

  it('the other conditions still fail the row on a quiet day', () => {
    expect(runRow21({ ...healthy, items_embedded_2h: 50 })).toContain('embedding-coverage-');
    expect(runRow21({ ...healthy, dlq_new_24h: 2 })).toContain('dlq-2-new;');
    expect(runRow21({ ...healthy, context_with_memory_24h: 0 })).toContain('memory-never-reached-prompt;');
    expect(runRow21({ ...healthy, ap0910_last_run: '2026-01-01T00:00:00Z' })).toContain('AP-0910-last-run-');
    expect(runRow21({ ...healthy, preferred_language_writes_24h: 30 })).toContain('preferred_language-churn-30;');
  });
});

describe('VTID-05088 ci_memory_health migration', () => {
  const keysOf = (sql: string): string[] => {
    const fn = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.ci_memory_health()'));
    return [...fn.slice(0, fn.indexOf('$$;')).matchAll(/^\s*'([a-z_0-9]+)',/gm)].map((m) => m[1]);
  };

  it('keeps every existing key and adds the two input-side keys', () => {
    const before = keysOf(OLD_MIG);
    const after = keysOf(MIG);
    for (const k of before) expect(after).toContain(k);
    expect(after).toEqual(expect.arrayContaining(['user_speech_turns_24h', 'transcript_turns_24h']));
    expect(after.length).toBe(before.length + 2);
  });

  it('counts speech per (session, turn) over the summed fragments, not per fragment', () => {
    expect(MIG).toContain("metadata->>'stage' = 'input_transcription'");
    expect(MIG).toContain("GROUP BY metadata->>'session_id', metadata->>'turn_count'");
    expect(MIG).toContain("HAVING sum(char_length(coalesce(metadata->>'text_preview', ''))) > 20");
    expect(MIG).toContain('FROM memory_transcript_turns');
  });

  it('stays SECURITY DEFINER, pinned search_path, service_role only', () => {
    expect(MIG).toContain('SECURITY DEFINER');
    expect(MIG).toContain('SET search_path = public, pg_catalog');
    expect(MIG).toContain('REVOKE ALL ON FUNCTION public.ci_memory_health() FROM PUBLIC, anon, authenticated;');
    expect(MIG).toContain('GRANT EXECUTE ON FUNCTION public.ci_memory_health() TO service_role;');
    expect(MIG.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(MIG).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER TABLE)\b/);
  });
});
