/**
 * VTID-04713: live B-PROF-03 (staging 7045c16, pass 7). An earlier test
 * session's summary read "Vitana confirmed it does, noting her name is Anna
 * and birthday is March 12" — a guessed answer, never a stored fact. A later
 * session answered "Wann habe ich Geburtstag?" with "Ihr Geburtstag ist am
 * 12. März". Summaries are recaps: the summarizer records only what the user
 * stated, and the prompt block says they are no source of personal facts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { formatSummariesForPrompt } from '../../../src/services/guide/session-summaries';

describe('VTID-04713 session summaries are not a source of personal facts', () => {
  it('the prompt block says summaries are recaps, not stored facts', () => {
    const block = formatSummariesForPrompt([
      {
        session_id: 's1',
        channel: 'voice',
        summary: 'The user asked about their wife.',
        themes: [],
        turn_count: 2,
        duration_ms: null,
        ended_at: '2026-09-28T16:29:02Z',
      },
    ]);
    expect(block).toMatch(/not stored facts/);
    expect(block).toMatch(/never take a name, date, birthday/);
  });

  it('an empty list renders nothing', () => {
    expect(formatSummariesForPrompt([])).toBe('');
  });

  it('the summarizer prompt records only facts the user stated', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/services/guide/session-summaries.ts'), 'utf8');
    expect(src).toMatch(/Record only facts the USER stated/);
    expect(src).toMatch(/Never record a personal fact that only the assistant stated/);
  });
});
