/**
 * VTID-04868 — Plan Sparring Gate, session layer.
 *
 * Pins the standing rule (CLAUDE.md rules 51-55), the partner agent, the skill,
 * and the PreToolUse hook: it DENIES an allocation that references no sparring
 * record (a context reminder would only arrive after the VTID exists), and is
 * silent when a record is referenced or the command is unrelated.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');
const HOOK = path.join(REPO, '.claude/hooks/pretooluse-plan-sparring-reminder.sh');

function runHook(toolInput: Record<string, string>): { out: string; code: number } {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: toolInput });
  try {
    const out = execFileSync('bash', [HOOK], { input, encoding: 'utf8' });
    return { out, code: 0 };
  } catch (e: any) {
    return { out: String(e.stdout || ''), code: e.status ?? 1 };
  }
}

describe('VTID-04868 Plan Sparring Gate — session layer', () => {
  it('CLAUDE.md carries rules 51-55 and puts allocation after sparring', () => {
    const md = read('CLAUDE.md');
    expect(md).toContain('### Plan Sparring Gate (STANDING RULE — VTID-04868)');
    for (const n of [51, 52, 53, 54, 55]) expect(md).toMatch(new RegExp(`^${n}\\. \\*\\*`, 'm'));
    expect(md).toContain('Plan → sparring → owner approval → VTID → code.');
    expect(md).toContain('Claude Opus 4.6 on AWS Bedrock');
    expect(md).toContain('**No fallback**');
    expect(md).toMatch(/Step 0 \(VTID-04868\): spar the plan first\./);
  });

  it('the partner agent is read-only and pinned to Opus 4.6', () => {
    const agent = read('.claude/agents/plan-sparring-partner.md');
    expect(agent).toMatch(/^name: plan-sparring-partner$/m);
    expect(agent).toMatch(/^model: claude-opus-4-6$/m);
    expect(agent).toMatch(/^tools: Read, Grep, Glob$/m);
    expect(agent).not.toMatch(/^tools:.*\b(Edit|Write|Bash)\b/m);
  });

  it('the skill defines >=2 passes, round caps and the record location', () => {
    const skill = read('.claude/skills/plan-sparring/SKILL.md');
    expect(skill).toMatch(/^name: plan-sparring$/m);
    expect(skill).toContain('Round caps: light 2, standard 3, expedited 2');
    expect(skill).toContain('docs/validation/<VTID>/plan-sparring.md');
  });

  const denies = (r: { out: string; code: number }) => {
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('PLAN SPARRING GATE');
  };

  it('hook DENIES an allocation that references no sparring record (before it runs)', () => {
    denies(runHook({ query: "select allocate_global_vtid('claude-code','DEV','X')" }));
  });

  it('hook also denies /vtid/allocate and direct ledger inserts, including multi-line SQL', () => {
    denies(runHook({ command: 'curl -X POST $GW/api/v1/vtid/allocate' }));
    denies(runHook({ query: 'INSERT INTO public.vtid_ledger (vtid) values (1)' }));
    denies(runHook({ query: 'INSERT\nINTO public.vtid_ledger (vtid)\nvalues (1)' }));
    denies(runHook({ query: 'insert into "vtid_ledger" (vtid) values (1)' }));
  });

  it('hook allows the call when a sparring record is referenced, and ignores unrelated commands', () => {
    expect(runHook({ query: 'select allocate_global_vtid(a,b,c,p_sparring_id=>x)' })).toEqual({ out: '', code: 0 });
    expect(runHook({ query: "-- sparring_record: docs/validation/VTID-1/plan-sparring.md\nselect allocate_global_vtid('a','b','c')" })).toEqual({ out: '', code: 0 });
    expect(runHook({ command: 'ls -la' })).toEqual({ out: '', code: 0 });
  });

  it('settings.json registers the hook for Bash and execute_sql', () => {
    const settings = JSON.parse(read('.claude/settings.json'));
    const entry = settings.hooks.PreToolUse.find(
      (h: any) => h.matcher === 'Bash|mcp__Supabase__execute_sql',
    );
    expect(entry?.hooks?.[0]?.command).toContain('pretooluse-plan-sparring-reminder.sh');
  });
});
