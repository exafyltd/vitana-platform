/**
 * VTID-04359 — customer-support follow-ups:
 *  - /mine returns the member's own report text (clipped), resolved or not;
 *  - the typed submit_* tools share report_to_specialist's 5-word minimum
 *    and placeholder check instead of their own 15/12-word thresholds.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fetchMyTickets } from '../src/routes/feedback-repository';
import { clipReportText, MY_TICKET_REPORT_TEXT_MAX_CHARS } from '../src/routes/feedback';
import {
  isVagueSummary,
  REPORT_TO_SPECIALIST_MIN_SUMMARY_WORDS,
} from '../src/services/report-to-specialist-core';

describe('fetchMyTickets', () => {
  it('selects raw_transcript so the reporter sees their own words', async () => {
    let selected = '';
    const chain: any = {
      select: (cols: string) => { selected = cols; return chain; },
      order: () => chain,
      limit: () => chain,
      lt: () => chain,
    };
    const sb: any = { from: () => chain };
    await fetchMyTickets(sb, { limit: 10, cursor: undefined });
    expect(selected.split(',').map((c) => c.trim())).toContain('raw_transcript');
  });
});

describe('clipReportText', () => {
  it('returns null for empty or non-string values', () => {
    expect(clipReportText(null)).toBeNull();
    expect(clipReportText(undefined)).toBeNull();
    expect(clipReportText('   ')).toBeNull();
    expect(clipReportText(42)).toBeNull();
  });
  it('keeps short text as is and clips long text', () => {
    expect(clipReportText('  the diary crashes  ')).toBe('the diary crashes');
    const long = 'x'.repeat(MY_TICKET_REPORT_TEXT_MAX_CHARS + 50);
    const clipped = clipReportText(long)!;
    expect(clipped.length).toBe(MY_TICKET_REPORT_TEXT_MAX_CHARS + 1);
    expect(clipped.endsWith('…')).toBe(true);
  });
  it('is applied to every /mine row, resolved or not', () => {
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/feedback.ts'), 'utf8');
    expect(route).toContain('raw_transcript: clipReportText(rest.raw_transcript)');
    expect(route).toContain('if (!RESOLVED.has(String(rest.status))) return shaped;');
  });
});

describe('isVagueSummary', () => {
  it('uses the report_to_specialist minimum of 5 words', () => {
    expect(REPORT_TO_SPECIALIST_MIN_SUMMARY_WORDS).toBe(5);
    expect(isVagueSummary('App is broken')).toBe(true);
    expect(isVagueSummary('Diary save button crashes app')).toBe(false);
  });
  it('rejects placeholder summaries regardless of length', () => {
    expect(isVagueSummary('User wants to report a bug')).toBe(true);
    expect(isVagueSummary('something is broken')).toBe(true);
  });
});

describe('typed submit_* tools', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/services/orb-tools/feedback-settings-tools.ts'), 'utf8',
  );
  it('no longer carry their own 15/12-word thresholds', () => {
    expect(src).not.toMatch(/at least 1[25] words/);
    expect(src).not.toMatch(/'(bug|support_question|marketplace_claim|account_issue)', 1[25],/);
    expect(src.match(/REPORT_TO_SPECIALIST_MIN_SUMMARY_WORDS, args/g)).toHaveLength(4);
  });
});

describe('rebuild brief status', () => {
  it('records the status of every slice', () => {
    const brief = fs.readFileSync(
      path.join(__dirname, '../../../docs/CUSTOMER-SUPPORT-REBUILD-BRIEF.md'), 'utf8',
    );
    expect(brief).toContain('### 4.1 Status (2026-09-23)');
    for (const v of ['VTID-04332', 'VTID-04333', 'VTID-04334', 'VTID-04335', 'VTID-04336', 'VTID-04359', 'VTID-04360']) {
      expect(brief).toContain(v);
    }
  });
});
