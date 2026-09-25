/**
 * VTID-04553 — acknowledgement intent before slow tools.
 *
 * Contract:
 *   - flag OFF (unset, 'false', any non-exact value) → the live system
 *     instruction is byte-identical to the pre-VTID text (the A0.1
 *     characterization snapshots pin that independently);
 *   - flag ON ('true') → the paragraph appears exactly once, in the static
 *     scaffold, positively phrased (0 negative imperatives by the VTID-04124
 *     counter), carries no quoted example sentence, stays within ~450 chars,
 *     survives the Nova sanitizer and the aggregate budget guard, and makes the
 *     guard trim nothing it would not already trim.
 */

import { buildLiveSystemInstruction } from '../../../../src/orb/live/instruction/live-system-instruction';
import {
  TOOL_ACK_INTENT_PARAGRAPH,
  buildToolAckIntentLine,
  isToolAckIntentEnabled,
} from '../../../../src/orb/live/instruction/tool-ack-intent';
import {
  decomposeInstructionSections,
  enforceInstructionBudget,
  BOOTSTRAP_CONTEXT_START_MARKER,
} from '../../../../src/orb/live/instruction/instruction-budget';
import { sanitizeInstructionForNova } from '../../../../src/orb/live/upstream/nova-instruction-sanitizer';

/** Same counter as test/services/conversation/vtid-04124-greeting-prohibition-stack.test.ts. */
const PROHIBITION = /\b(do not|don't|never|no approved phrasing|nothing to recite|nothing to pick)\b|say exactly|sag genau|dis exactement/gi;

const FLAG = 'ORB_TOOL_ACK_INTENT_ENABLED';

function build(opts: { bootstrap?: string; route?: string; role?: string } = {}): string {
  return buildLiveSystemInstruction(
    'de',
    'friendly, calm, empathetic',
    opts.bootstrap ?? '',
    opts.role ?? 'community',
    '',
    '',
    false,
    null,
    opts.route ?? '/home',
    [],
    undefined,
    '@dragan1',
  );
}

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('VTID-04553 — flag reader', () => {
  it('is on only for the exact string "true"', () => {
    expect(isToolAckIntentEnabled({ [FLAG]: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    for (const v of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true']) {
      const env = (v === undefined ? {} : { [FLAG]: v }) as NodeJS.ProcessEnv;
      expect(isToolAckIntentEnabled(env)).toBe(false);
      expect(buildToolAckIntentLine(env)).toBe('');
    }
    expect(buildToolAckIntentLine({ [FLAG]: 'true' } as NodeJS.ProcessEnv)).toBe(`${TOOL_ACK_INTENT_PARAGRAPH}\n`);
  });
});

describe('VTID-04553 — flag OFF leaves the instruction byte-identical', () => {
  it.each([undefined, 'false', 'TRUE', 'yes'])('value %p renders the same text as unset, without the paragraph', (value) => {
    const baseline = withFlag(undefined, () => build());
    const rendered = withFlag(value, () => build());
    expect(rendered).toBe(baseline);
    expect(rendered).not.toContain('ACKNOWLEDGE BEFORE SLOW LOOKUPS');
  });
});

describe('VTID-04553 — flag ON adds one positively phrased intent paragraph', () => {
  it('appears exactly once, inside the TOOLS section, and adds only its own bytes', () => {
    const off = withFlag(undefined, () => build());
    const on = withFlag('true', () => build());
    expect(occurrences(on, TOOL_ACK_INTENT_PARAGRAPH)).toBe(1);
    const tools = on.indexOf('\nTOOLS:\n');
    const important = on.indexOf('\n\nIMPORTANT:\n');
    const at = on.indexOf(TOOL_ACK_INTENT_PARAGRAPH);
    expect(tools).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(tools);
    expect(at).toBeLessThan(important);
    // Nothing else moved: removing the paragraph line restores the flag-off text.
    expect(on.replace(`${TOOL_ACK_INTENT_PARAGRAPH}\n`, '')).toBe(off);
  });

  it('is present on the Command Hub surface too (same builder, same section)', () => {
    const on = withFlag('true', () => build({ route: '/command-hub/overview', role: 'developer' }));
    expect(occurrences(on, TOOL_ACK_INTENT_PARAGRAPH)).toBe(1);
  });

  it('carries zero negative imperatives by the VTID-04124 counter', () => {
    expect(TOOL_ACK_INTENT_PARAGRAPH.match(PROHIBITION)).toBeNull();
  });

  it('is intent, not a script: no quoted example sentence, and it asks for varied wording', () => {
    expect(TOOL_ACK_INTENT_PARAGRAPH).not.toMatch(/["“”„«»]/);
    expect(TOOL_ACK_INTENT_PARAGRAPH).toContain("in the user's language");
    expect(TOOL_ACK_INTENT_PARAGRAPH).toContain('in your own words, different each time');
  });

  it('keeps every requested clause', () => {
    const p = TOOL_ACK_INTENT_PARAGRAPH;
    // slow tools → brief acknowledgement first, then the call
    expect(p).toContain('a tool that can take a moment (searching, looking something up, several steps)');
    expect(p).toContain('first say one very brief, natural acknowledgement');
    expect(p).toContain('then call the tool right away');
    // instant actions (navigation) are not acknowledged
    expect(p).toContain('Instant actions such as opening a screen go straight to the tool');
    // tool names stay unspoken
    expect(p).toContain('keep tool names to yourself');
  });

  it('stays within ~450 characters', () => {
    expect(TOOL_ACK_INTENT_PARAGRAPH.length).toBeLessThanOrEqual(460);
  });

  it('reaches the Nova path intact (the sanitizer rewrites only the IDENTITY LOCK block)', () => {
    const on = withFlag('true', () => build());
    const nova = sanitizeInstructionForNova(on).text;
    expect(occurrences(nova, TOOL_ACK_INTENT_PARAGRAPH)).toBe(1);
  });
});

describe('VTID-04553 — instruction budget', () => {
  // A realistic heavy bootstrap: well over the packer cap, so the assembled
  // instruction exceeds the 30,720-byte aggregate budget.
  const heavyBootstrap = [
    '=== USER CONTEXT PROFILE ===',
    'Member since 2025. Prefers morning walks. '.repeat(160),
    '## RECENT ACTIVITY',
    'Logged water, sleep and a short run. '.repeat(160),
  ].join('\n');

  it('the paragraph lives in the preserved scaffold, never in a trimmable section', () => {
    const on = withFlag('true', () => build({ bootstrap: heavyBootstrap }));
    expect(on).toContain(BOOTSTRAP_CONTEXT_START_MARKER);
    const sections = decomposeInstructionSections(on);
    const holder = sections.filter((s) => s.text.includes(TOOL_ACK_INTENT_PARAGRAPH));
    expect(holder).toHaveLength(1);
    expect(holder[0].kind).toBe('scaffold');
  });

  it('with the flag on, the guard trims exactly what it trims with the flag off, and keeps the paragraph', () => {
    const off = withFlag(undefined, () => build({ bootstrap: heavyBootstrap }));
    const on = withFlag('true', () => build({ bootstrap: heavyBootstrap }));
    const rOff = enforceInstructionBudget(decomposeInstructionSections(off));
    const rOn = enforceInstructionBudget(decomposeInstructionSections(on));
    // The fixture really is over budget, so the guard really trims.
    expect(rOff.trimmedSections).toContain('bootstrap');
    expect(rOn.trimmedSections).toEqual(rOff.trimmedSections);
    expect(rOn.text).toContain(TOOL_ACK_INTENT_PARAGRAPH);
    expect(rOn.totalBytesAfter - rOff.totalBytesAfter).toBe(Buffer.byteLength(`${TOOL_ACK_INTENT_PARAGRAPH}\n`));
    // Every non-paragraph byte of the flag-off result survives unchanged.
    expect(rOn.text.replace(`${TOOL_ACK_INTENT_PARAGRAPH}\n`, '')).toBe(rOff.text);
  });
});
