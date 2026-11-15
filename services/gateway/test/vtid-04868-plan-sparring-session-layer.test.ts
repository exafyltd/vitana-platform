/**
 * VTID-04868 — Plan Sparring, session layer.
 *
 * Pins the standing rule (CLAUDE.md rules 51-53), the partner agent and the skill.
 *
 * VTID-05800 (owner decision 2026-11-15, contract changed on purpose): a VTID is no longer gated on sparring. Anyone
 * may allocate one at any time, so the PreToolUse hook that DENIED an allocation without a sparring record is gone,
 * and CLAUDE.md says the VTID can come before the plan. These tests now pin that the gate stays gone.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

describe('VTID-04868 Plan Sparring — session layer (VTID-05800: the VTID is free)', () => {
  it('CLAUDE.md carries rules 51-53, sparring before code, and allocation at any time', () => {
    const md = read('CLAUDE.md');
    expect(md).toContain('### Plan Sparring Gate (STANDING RULE — VTID-04868, amended 2026-11-07 and 2026-11-15)');
    for (const n of [51, 52, 53]) expect(md).toMatch(new RegExp(`^${n}\\. \\*\\*`, 'm'));
    // Rule 51 keeps the review flow, without the VTID step in it.
    expect(md).toMatch(/[Pp]lan → sparring → owner approval[\s\S]*?→ code\.\*\*/);
    expect(md).not.toMatch(/→ VTID → code\./);
    expect(md).toContain('Claude Opus 4.6 on AWS Bedrock');
    // Owner decision 2026-10-19: Opus 4.6 → Sonnet 4.6 → DeepSeek, never Google.
    expect(md).toContain('**Fallback chain');
    expect(md).toContain('`deepseek-v4-pro`');
    expect(md).toContain('Never Google.');
    expect(md).toContain('### 4.1 Allocation (STANDING RULE — VTID-03448, VTID-04868, VTID-05800)');
    expect(md).toContain('anyone allocates it, at any time, by any path');
    expect(md).not.toMatch(/allocated only after its plan is sparred and approved/);
    expect(md).not.toMatch(/never by hand/);
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

  it('no hook denies an allocation any more (VTID-05800)', () => {
    expect(fs.existsSync(path.join(REPO, '.claude/hooks/pretooluse-plan-sparring-reminder.sh'))).toBe(false);
    const settings = JSON.parse(read('.claude/settings.json'));
    const commands = JSON.stringify(settings.hooks ?? {});
    expect(commands).not.toContain('pretooluse-plan-sparring-reminder.sh');
  });
});
