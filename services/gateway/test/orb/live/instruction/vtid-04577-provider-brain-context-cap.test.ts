/**
 * VTID-04577 — Nova / cascade sessions pack the brain context to 24,000 chars
 * (Vertex keeps 12,000), so the member's social context is no longer dropped
 * from a Nova prompt that has room for it.
 * VTID-04578 — the My Journey two-views block is sent once, not twice.
 * VTID-04579 — the prompt tells Vitana to search memory for what is not shown.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  resolveBootstrapMaxCharsFor,
  BOOTSTRAP_CONTEXT_MAX_CHARS,
  NOVA_BOOTSTRAP_CONTEXT_MAX_CHARS,
  NOVA_BOOTSTRAP_MAX_CHARS_ENV,
} from '../../../../src/orb/live/instruction/bootstrap-cap';
import type { BootstrapPackResult } from '../../../../src/orb/live/instruction/bootstrap-packer';
import { buildLiveSystemInstruction } from '../../../../src/orb/live/instruction/live-system-instruction';
import {
  buildJourneyModesSection,
  stripJourneyModesCopies,
} from '../../../../src/orb/live/instruction/journey-modes-prompt';
import {
  decomposeInstructionSections,
  enforceInstructionBudget,
  resolveInstructionByteBudgetFor,
  SECTION_TRIM_SENTINEL,
} from '../../../../src/orb/live/instruction/instruction-budget';

function filler(label: string, chars: number): string {
  const line = `- ${label} bullet with a real detail about the member and their week.\n`;
  let out = '';
  while (out.length < chars) out += line;
  return out;
}

/**
 * Shaped like the staging brain context measured 2026-09-25 (15.5–16.8 K
 * chars before packing): memory, the self-check, goal, awareness, social context — the section mix the staging
 * `brain_context_built` diag reports.
 */
function stagingSizedBootstrap(): string {
  return [
    '=== USER MEMORY CONTEXT ===\n',
    '## Verified Facts About This User\n- name: Mara\n- city: Berlin\n',
    '## User Context (from Memory - Relevance Scored)\n' + filler('memory', 5200),
    '=== END USER MEMORY CONTEXT ===\n',
    '=== HOW TO USE THIS MEMORY (MANDATORY SELF-CHECK) ===\n' + filler('self-check', 3400),
    '=== ACTIVE LIFE COMPASS GOAL (apply to every recommendation) ===\n- sleep better\n',
    '=== USER AWARENESS — RIGHT NOW ===\n' + filler('awareness', 3500),
    '<social_context>\n- close friend: Jonas (hikes on Sundays)\n' + filler('social', 2600) + '</social_context>\n',
  ].join('');
}

// Positional builder call; index 16 is onContextPacked, 17 is the new cap.
function build(
  bootstrap: string,
  opts: { cap?: number; surface?: string; onPack?: (p: BootstrapPackResult) => void } = {},
): string {
  return buildLiveSystemInstruction(
    'de', 'friendly, calm, empathetic', bootstrap, 'community', undefined, undefined, false,
    null, '/home', null, undefined, '@mara1', undefined, opts.surface ?? null, true, 'Mara',
    opts.onPack, opts.cap,
  );
}

describe('VTID-04577 resolveBootstrapMaxCharsFor', () => {
  it('gives Nova and the cascade 24,000 chars and keeps 12,000 for everything else', () => {
    expect(resolveBootstrapMaxCharsFor('nova_sonic', {})).toBe(NOVA_BOOTSTRAP_CONTEXT_MAX_CHARS);
    expect(resolveBootstrapMaxCharsFor('cascaded', {})).toBe(NOVA_BOOTSTRAP_CONTEXT_MAX_CHARS);
    expect(NOVA_BOOTSTRAP_CONTEXT_MAX_CHARS).toBe(24_000);
    for (const p of ['vertex', 'livekit', undefined, null, '']) {
      expect(resolveBootstrapMaxCharsFor(p as any, {})).toBe(BOOTSTRAP_CONTEXT_MAX_CHARS);
    }
  });

  it('honours a valid override for Nova and ignores garbage or a value below the Vertex cap', () => {
    expect(resolveBootstrapMaxCharsFor('nova_sonic', { [NOVA_BOOTSTRAP_MAX_CHARS_ENV]: '30000' })).toBe(30_000);
    expect(resolveBootstrapMaxCharsFor('nova_sonic', { [NOVA_BOOTSTRAP_MAX_CHARS_ENV]: 'lots' })).toBe(24_000);
    expect(resolveBootstrapMaxCharsFor('nova_sonic', { [NOVA_BOOTSTRAP_MAX_CHARS_ENV]: '4000' })).toBe(24_000);
    // The override never widens Vertex.
    expect(resolveBootstrapMaxCharsFor('vertex', { [NOVA_BOOTSTRAP_MAX_CHARS_ENV]: '30000' })).toBe(12_000);
  });
});

describe('VTID-04577 the builder packs to the cap it is given', () => {
  it('at the Vertex cap the staging-sized context loses its social context', () => {
    let pack: BootstrapPackResult | undefined;
    const text = build(stagingSizedBootstrap(), { cap: 12_000, onPack: (p) => { pack = p; } });
    expect(pack?.packed).toBe(true);
    expect(pack?.sections.find((s) => s.key === 'social_context')?.outcome).toBe('dropped');
    expect(text).not.toContain('close friend: Jonas');
  });

  it('at the Nova cap the same context is kept whole, with no packing note', () => {
    let pack: BootstrapPackResult | undefined;
    const text = build(stagingSizedBootstrap(), { cap: resolveBootstrapMaxCharsFor('nova_sonic', {}), onPack: (p) => { pack = p; } });
    expect(pack?.packed).toBe(false);
    expect(pack?.sections.every((s) => s.outcome === 'kept')).toBe(true);
    expect(text).toContain('close friend: Jonas');
    expect(text).not.toContain('[context packed to fit budget');
  });

  it('no cap argument keeps the 12,000-char behaviour for every other caller', () => {
    let pack: BootstrapPackResult | undefined;
    build(stagingSizedBootstrap(), { onPack: (p) => { pack = p; } });
    expect(pack?.packed).toBe(true);
  });

  it('the Nova-packed prompt still fits the Nova instruction budget with nothing dropped', () => {
    const big = stagingSizedBootstrap() + '## User Context (from Memory - Relevance Scored)\n' + filler('extra', 7000);
    const text = build(big, { cap: resolveBootstrapMaxCharsFor('nova_sonic', {}) });
    const result = enforceInstructionBudget(decomposeInstructionSections(text), resolveInstructionByteBudgetFor('nova_sonic', {}));
    expect(result.trimmedSections).toEqual([]);
    expect(result.shortenedSections).toEqual([]);
    expect(result.totalBytesAfter).toBeLessThanOrEqual(resolveInstructionByteBudgetFor('nova_sonic', {}));
  });

  it('source contract: the session envelope passes the serving provider’s cap', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');
    const start = src.indexOf('export function assembleOrbSetupEnvelope(');
    const body = src.slice(start, src.indexOf('\nexport function', start + 10));
    expect(body).toMatch(/\(pack\) => recordBrainContextBuilt\(session, pack\),\s*(\/\/[^\n]*\n\s*)*resolveBootstrapMaxCharsFor\(session\.upstreamProvider\),/);
  });
});

describe('VTID-04578 the My Journey two-views block is sent once', () => {
  const prev = process.env.NAV_GUIDED_JOURNEY;
  afterEach(() => { if (prev === undefined) delete process.env.NAV_GUIDED_JOURNEY; else process.env.NAV_GUIDED_JOURNEY = prev; });

  const header = '=== MY JOURNEY — ZWEI ANSICHTEN';
  const count = (s: string, needle: string) => s.split(needle).length - 1;

  it('drops the brain context copy when the scaffold carries the block', () => {
    process.env.NAV_GUIDED_JOURNEY = 'true';
    const bootstrap = stagingSizedBootstrap() + buildJourneyModesSection('de') + '\n\nCurrent conversation channel: orb\n';
    const text = build(bootstrap, { cap: 24_000 });
    expect(count(text, header)).toBe(1);
    // The text after the block in the brain context is untouched.
    expect(text).toContain('Current conversation channel: orb');
  });

  it('leaves the brain copy alone when the scaffold does not add the block', () => {
    delete process.env.NAV_GUIDED_JOURNEY;
    const text = build(stagingSizedBootstrap() + buildJourneyModesSection('de'), { cap: 24_000 });
    expect(count(text, header)).toBe(1);
  });

  it('stripJourneyModesCopies removes either language and nothing else', () => {
    const s = `A${buildJourneyModesSection('de')}B${buildJourneyModesSection('en')}C`;
    expect(stripJourneyModesCopies(s)).toBe('ABC');
    expect(stripJourneyModesCopies('no block here')).toBe('no block here');
  });
});

describe('VTID-04579 memory the prompt does not show is looked up, not denied', () => {
  it('the member prompt tells Vitana to call search_memory before saying she does not know', () => {
    const text = build(stagingSizedBootstrap(), { cap: 24_000 });
    expect(text).toMatch(/MEMORY LOOKUP:[^\n]*selection[^\n]*call search_memory before saying you do not know/);
  });

  it('a work surface does not get the member rule', () => {
    const text = build('', { surface: 'command-hub' });
    expect(text).not.toContain('MEMORY LOOKUP:');
  });

  it('the dropped-context notes point at search_memory for member context only', () => {
    expect(SECTION_TRIM_SENTINEL('bootstrap')).toContain('search_memory');
    expect(SECTION_TRIM_SENTINEL('history')).toContain('search_memory');
    expect(SECTION_TRIM_SENTINEL('specialist')).not.toContain('search_memory');
    let pack: BootstrapPackResult | undefined;
    build(stagingSizedBootstrap(), { cap: 12_000, onPack: (p) => { pack = p; } });
    expect(pack?.text).toMatch(/\[context packed to fit budget — [^\]]*; use search_memory for anything not shown here\]$/);
    expect(pack!.chars_after).toBeLessThanOrEqual(12_000);
  });
});
