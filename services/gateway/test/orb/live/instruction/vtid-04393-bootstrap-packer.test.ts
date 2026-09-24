/**
 * VTID-04393 (Plan v1 WS-1.1) — the bootstrap packer keeps the session-owning
 * blocks the head-slice used to cut, packs by priority, and is byte-identical
 * under budget.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  splitBootstrapSections,
  packBootstrapContext,
  BOOTSTRAP_PACK_MAX_CHARS,
} from '../../../../src/orb/live/instruction/bootstrap-packer';
import { capBootstrapContext } from '../../../../src/orb/live/instruction/bootstrap-cap';
import { buildLiveSystemInstruction } from '../../../../src/orb/live/instruction/live-system-instruction';

function filler(label: string, chars: number): string {
  const line = `- ${label} fact bullet with some detail about the user and their week.\n`;
  let out = '';
  while (out.length < chars) out += line;
  return out;
}

/** A heavy user's bootstrap, in the order orb-live.ts concatenates it. */
function heavyBootstrap(): string {
  return [
    '=== USER MEMORY CONTEXT ===\n',
    '## MOST RECENT USER UTTERANCES (verbatim transcripts — HIGHEST PRIORITY)\n- "what did I eat yesterday"\n',
    '## Verified Facts About This User\n- name: Mara\n- city: Berlin\n',
    '## User Context (from Memory - Relevance Scored)\n' + filler('memory', 20000),
    '=== END USER MEMORY CONTEXT ===\n',
    '=== HOW TO USE THIS MEMORY (MANDATORY SELF-CHECK) ===\nCheck memory before answering.\n',
    '## USER CONTEXT PROFILE (recent activity, routines, preferences)\n' + filler('profile', 4000),
    '<social_context>\n' + filler('social', 3000) + '</social_context>\n',
    '<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>\nOpen with the lesson the user tapped.\n',
    '=== TEACHER MODE (VTID-03112) ===\nTeach step by step.\n=== END TEACHER MODE ===\n',
  ].join('');
}

describe('splitBootstrapSections', () => {
  it('concatenates back to the input exactly and classifies real headers', () => {
    const text = heavyBootstrap();
    const sections = splitBootstrapSections(text);
    expect(sections.map((s) => s.text).join('')).toBe(text);
    const keys = sections.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining([
      'memory_open', 'recent_utterances', 'verified_facts', 'memory_items', 'end:user_memory_context',
      'memory_self_check', 'context_profile', 'social_context', 'wake_brief_override', 'teacher_mode', 'end:teacher_mode',
    ]));
  });

  it('untitled leading text is its own shortenable head section', () => {
    const s = splitBootstrapSections('awareness line one\nawareness line two\n## Verified Facts About This User\n- a\n');
    expect(s[0]).toMatchObject({ key: 'head', priority: 3 });
    expect(s[1]).toMatchObject({ key: 'verified_facts', priority: 1 });
  });
});

describe('packBootstrapContext', () => {
  it('under budget: returned byte-for-byte, nothing packed', () => {
    const small = '## Verified Facts About This User\n- name: Mara\n';
    const r = packBootstrapContext(small);
    expect(r.text).toBe(small);
    expect(r.packed).toBe(false);
  });

  it('the head-slice cut the tail-appended override and Teacher block; the packer keeps them', () => {
    const text = heavyBootstrap();
    expect(text.length).toBeGreaterThan(BOOTSTRAP_PACK_MAX_CHARS);

    const legacy = capBootstrapContext(text).text;
    expect(legacy).not.toContain('<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>');
    expect(legacy).not.toContain('=== TEACHER MODE');

    const r = packBootstrapContext(text);
    expect(r.packed).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(BOOTSTRAP_PACK_MAX_CHARS);
    for (const must of [
      '<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>', '=== TEACHER MODE (VTID-03112) ===', '=== END TEACHER MODE ===',
      '=== HOW TO USE THIS MEMORY', '## MOST RECENT USER UTTERANCES', '- name: Mara', '=== END USER MEMORY CONTEXT ===',
    ]) {
      expect(r.text).toContain(must);
    }
  });

  it('drops the lowest priority first and shortens rather than drops a large memory block', () => {
    const r = packBootstrapContext(heavyBootstrap());
    const outcome = (k: string) => r.sections.find((s) => s.key === k)!.outcome;
    expect(outcome('social_context')).toBe('dropped');
    expect(outcome('context_profile')).toBe('dropped');
    expect(outcome('memory_items')).toBe('shortened');
    expect(outcome('wake_brief_override')).toBe('kept');
    expect(r.text).toMatch(/\[context packed to fit budget — shortened: memory_items; omitted: context_profile, social_context\]$/);
  });

  it('keeps the original order of the kept sections', () => {
    const r = packBootstrapContext(heavyBootstrap());
    const order = ['=== USER MEMORY CONTEXT ===', '## Verified Facts', '=== END USER MEMORY CONTEXT ===', '<<VERTEX_WAKE_BRIEF', '=== TEACHER MODE'];
    const idx = order.map((m) => r.text.indexOf(m));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('a shortened section is cut at a line boundary', () => {
    const r = packBootstrapContext(heavyBootstrap());
    const mem = r.text.slice(r.text.indexOf('## User Context (from Memory'), r.text.indexOf('=== END USER MEMORY CONTEXT ==='));
    expect(mem.endsWith('\n')).toBe(true);
  });
});

describe('wiring through buildLiveSystemInstruction', () => {
  const OLD = process.env.BRAIN_CONTEXT_PACKER;
  afterEach(() => {
    if (OLD === undefined) delete process.env.BRAIN_CONTEXT_PACKER; else process.env.BRAIN_CONTEXT_PACKER = OLD;
  });

  function build(onPacked?: (r: unknown) => void): string {
    return buildLiveSystemInstruction(
      'en', 'friendly', heavyBootstrap(), 'community', undefined, undefined, false, null,
      null, null, undefined, null, undefined, undefined, true, null, onPacked as any,
    );
  }

  it('a heavy user keeps the override and Teacher Mode in the real instruction and the report reaches the caller', () => {
    delete process.env.BRAIN_CONTEXT_PACKER;
    const reports: any[] = [];
    const instruction = build((r) => reports.push(r));
    expect(instruction).toContain('=== TEACHER MODE (VTID-03112) ===');
    expect(reports).toHaveLength(1);
    expect(reports[0].packed).toBe(true);
  });

  it('BRAIN_CONTEXT_PACKER=false restores the head-slice (kill switch)', () => {
    process.env.BRAIN_CONTEXT_PACKER = 'false';
    const reports: any[] = [];
    const instruction = build((r) => reports.push(r));
    expect(instruction).not.toContain('=== TEACHER MODE (VTID-03112) ===');
    expect(reports).toHaveLength(0);
  });

  it('the activity-awareness override re-quotes only the profile, never the blocks after it (was: everything to end of string)', () => {
    delete process.env.BRAIN_CONTEXT_PACKER;
    const boot = '## USER CONTEXT PROFILE (recent activity, routines, preferences)\n' + filler('profile', 400) +
      '\nENVIRONMENT CONTEXT:\nTimezone: Europe/Berlin\n\n[BEHAVIORAL RULES — universal]\nBe kind.\n' +
      '<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>\nOpen with the lesson.\n=== TEACHER MODE (VTID-03112) ===\nTeach.\n=== END TEACHER MODE ===\n';
    const instruction = buildLiveSystemInstruction('en', 'friendly', boot, 'community', undefined, undefined, false, null,
      null, null, undefined, null, undefined, undefined, true, null);
    const count = (needle: string) => instruction.split(needle).length - 1;
    expect(count('=== TEACHER MODE (VTID-03112) ===')).toBe(1);
    expect(count('<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>')).toBeLessThanOrEqual(1);
    expect(count('[BEHAVIORAL RULES — universal]')).toBe(1);
  });

  it('source contract: orb-live records a brain_context_built diag from the packer callback', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');
    expect(src).toMatch(/\(pack\) => recordBrainContextBuilt\(session, pack\)/);
    expect(src).toMatch(/emitDiag\(session, 'brain_context_built', payload\)/);
  });

  it('source contract: every header the builders emit for the session-owning blocks is classified pinned', () => {
    const root = path.join(__dirname, '../../../../src');
    const teacher = fs.readFileSync(path.join(root, 'orb/teacher/teacher-mode-prompt.ts'), 'utf8');
    const guide = fs.readFileSync(path.join(root, 'orb/live/instruction/journey-guide-prompt.ts'), 'utf8');
    const topic = fs.readFileSync(path.join(root, 'orb/live/instruction/guided-topic-narration-prompt.ts'), 'utf8');
    expect(teacher).toContain('=== TEACHER MODE (VTID-03112) ===');
    for (const src of [guide, topic]) {
      const headers = src.match(/'## GUIDE[- ]MOD[^']*'/g) || [];
      expect(headers.length).toBeGreaterThan(0);
      for (const h of headers) {
        const header = h.slice(1, -1);
        const s = splitBootstrapSections(`${header}\nbody\n`);
        expect(s[0]).toMatchObject({ key: 'guide_mode', priority: 0 });
      }
    }
  });
});
