/**
 * VTID-04618 — Vitana refused to say the member's wife's birthday, citing
 * privacy (production 2026-09-26). The fact was stored (spouse_birthday);
 * the refusal came from the memory self-check, which told the model never
 * to name "a third person's private detail". Facts the member told Vitana
 * about their own people are the member's.
 */

import {
  formatMemoryContextForPrompt,
  wrapLegacyMemoryPreamble,
} from '../src/services/memory-orchestrator';
import * as fs from 'fs';
import * as path from 'path';

function renders(): string[] {
  return [wrapLegacyMemoryPreamble('spouse_birthday: 4. November 1999')];
}

describe('VTID-04618 memory self-check', () => {
  it('both memory renderers carry the same self-check', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/memory-orchestrator.ts'), 'utf8');
    const fmt = src.slice(src.indexOf('export function formatMemoryContextForPrompt'), src.indexOf('export function wrapLegacyMemoryPreamble'));
    expect(fmt).toContain('${buildSelfCheckSection()}');
    expect(typeof formatMemoryContextForPrompt).toBe('function');
  });

  it('tells the model that what the member told it is theirs and must never be refused', () => {
    for (const text of renders()) {
      expect(text).toContain('WHAT THE USER TOLD YOU IS THEIRS');
      expect(text).toMatch(/partner, family, friends: names,\s+birthdays/);
      expect(text).toContain('Never refuse');
      expect(text).toMatch(/never cite privacy or data\s+protection/);
      expect(text).toContain('call search_memory before');
    }
  });

  // VTID-04645: staging 2026-09-26 — asked for the wife's birthday, Vitana
  // answered with the brother's date from a session summary instead of
  // looking it up.
  it('never lends one person\'s fact to another, and says so when it is not found', () => {
    for (const text of renders()) {
      expect(text).toMatch(/Match the person\s+exactly/);
      expect(text).toMatch(/is never the answer for another/);
      expect(text).toMatch(/no such fact for exactly that person, call search_memory before\s+you answer/);
      expect(text).toMatch(/say you don't have it\s+yet and ask for it/);
    }
  });

  it('no longer carries the clause that produced the refusal', () => {
    for (const text of renders()) {
      expect(text).not.toContain('Still respect privacy');
      expect(text).not.toContain("never name a THIRD person's private detail");
    }
  });

  it('keeps the limit for other members\' private data and the no-invention rule', () => {
    for (const text of renders()) {
      expect(text).toContain('ANOTHER MEMBER');
      expect(text).toContain("Never invent a name that isn't in memory.");
    }
  });
});
