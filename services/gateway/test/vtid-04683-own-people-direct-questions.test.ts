/**
 * VTID-04683 — staging 2026-09-26, after VTID-04645: "erinnerst du dich an
 * den Geburtstag meiner Frau" was answered, but the direct question "wie
 * heißt meine Frau" was refused on privacy grounds while spouse_name was in
 * the prompt's structured facts. Rule 6b only covered "whether you remember
 * it", and the structured-facts header presented the spouse's name as a bare
 * "fact about the user" with no word on whose it is.
 */

import { wrapLegacyMemoryPreamble } from '../src/services/memory-orchestrator';
import * as fs from 'fs';
import * as path from 'path';

describe('VTID-04683 direct questions about the member\'s own people', () => {
  it('rule 6b covers a direct question, not only "do you remember"', () => {
    const text = wrapLegacyMemoryPreamble('spouse_name: Anna');
    expect(text).toMatch(/ask about it in any form/);
    expect(text).toMatch(/or directly:\s+their partner's name/);
    expect(text).toMatch(/answer with it plainly/);
    // the VTID-04618 / 04645 guarantees stay
    expect(text).toMatch(/never cite privacy or data\s+protection/);
    expect(text).toMatch(/Match the person\s+exactly/);
    expect(text).toContain('ANOTHER MEMBER');
  });

  it('the structured-facts header says the facts came from the user and are theirs', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/context-pack-builder.ts'),
      'utf8',
    );
    expect(src).not.toContain('verified structured facts about the user');
    expect(src).toContain('facts the user told you about themselves and their own people');
    expect(src).toContain('They belong to the user');
  });
});
