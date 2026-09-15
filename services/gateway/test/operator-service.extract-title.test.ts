/**
 * Regression test for the "TITLE:" prefix mangling bug in
 * operator-service.ts's extractTitle().
 *
 * Bug: a caller (human or LLM) writing a task description with an explicit
 * leading "TITLE: ..." line — the natural way to state a title when it
 * isn't already in "Area: description" format — got that line swallowed
 * as raw description text, re-prefixed with an auto-guessed area, and hard
 * truncated at 60 chars, producing titles like:
 *   "Frontend: TITLE: Fix — Unfollow button pushed off-screen in"
 * instead of the intended "Frontend: Fix Unfollow button pushed off-screen".
 *
 * Observed live via VTID-03900 (2026-09-15).
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || 'test-service-role';

import { extractTitle } from '../src/services/operator-service';
import { SYSTEM_AREAS } from '../src/utils/task-title';

describe('extractTitle — TITLE: prefix handling', () => {
  it('strips a leading "TITLE:" line instead of double-prefixing it', () => {
    const raw = `TITLE: Fix — Unfollow button pushed off-screen in "Following" list drawer (mobile)

REPO: exafyltd/vitana-v1
COMPONENT: src/components/ui/scroll-area.tsx (shared shadcn/ui ScrollArea primitive)`;

    const title = extractTitle(raw);

    expect(title).not.toContain('TITLE:');
    expect(title.startsWith('Frontend:')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it('is case-insensitive and tolerates surrounding whitespace on the TITLE: line', () => {
    const raw = '  title:   Add rate limiting to the auth endpoint  \n\nDetails: ...';
    const title = extractTitle(raw);
    expect(title).not.toMatch(/title:/i);
  });

  it('still normalizes a real "Area: description" title unchanged', () => {
    const title = extractTitle('Gateway: Add rate limiting to auth endpoint');
    expect(title).toBe('Gateway: Add rate limiting to auth endpoint');
  });

  it('still auto-detects a valid area and builds a title when there is no TITLE: line at all', () => {
    const title = extractTitle('Fix the button overflow on the mobile app screen');
    const area = title.split(':')[0];
    expect(SYSTEM_AREAS).toContain(area);
  });

  it('does not let a multi-line description without early punctuation drag later lines into the title', () => {
    const raw = `TITLE: Short title here

REPO: exafyltd/vitana-v1
COMPONENT: some/very/long/path/that/would/have/been/swept/into/the/old/first-sentence/match.ts`;
    const title = extractTitle(raw);
    expect(title).not.toContain('REPO:');
    expect(title).not.toContain('COMPONENT:');
  });

  it('falls back to "Gateway: Untitled task" for empty input', () => {
    expect(extractTitle('')).toBe('Gateway: Untitled task');
    expect(extractTitle('   ')).toBe('Gateway: Untitled task');
  });
});
