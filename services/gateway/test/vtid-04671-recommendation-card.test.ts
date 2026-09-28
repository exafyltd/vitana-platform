/**
 * VTID-04671 (P6): the Pending Approvals card shows evidence, value, odds and
 * cost; Dismiss asks why; an activated card follows its execution live.
 *
 * app.js is a plain browser script with no module system, so the pure
 * helpers are evaluated in isolation and the wiring is pinned by source text
 * (the established pattern in test/command-hub/*). The rendered result was
 * verified in a browser against a local stub — screenshots in
 * docs/validation/VTID-04671/outputs/.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { DISMISS_REASON_CODES } from '../src/services/recommendation-quality/acceptance';
import { MANUALLY_BRIDGEABLE_SOURCE_TYPES } from '../src/services/autopilot-executable-source-types';

const FE = join(__dirname, '../src/frontend/command-hub');
const APP_JS = readFileSync(join(FE, 'app.js'), 'utf8');
const STYLES = readFileSync(join(FE, 'styles.css'), 'utf8');
const INDEX_HTML = readFileSync(join(FE, 'index.html'), 'utf8');
const GUARD = readFileSync(join(__dirname, '../../../scripts/ci/command-hub-ownership-guard.js'), 'utf8');

function fnBody(name: string): string {
  const start = APP_JS.indexOf(`\nfunction ${name}(`) >= 0 ? APP_JS.indexOf(`\nfunction ${name}(`) : APP_JS.indexOf(`\nasync function ${name}(`);
  if (start === -1) throw new Error(`function ${name}() not found`);
  const rest = APP_JS.slice(start + 1);
  const next = rest.slice(1).search(/\n(async )?function /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function varBlock(name: string): string {
  const start = APP_JS.indexOf(`\nvar ${name} = `);
  if (start === -1) throw new Error(`var ${name} not found`);
  return APP_JS.slice(start, APP_JS.indexOf('];', start) + 2);
}

describe('VTID-04671 card metrics', () => {
  it('Impact/Effort is replaced by priority, value, confidence, success odds, expected cost and an executable badge', () => {
    const card = fnBody('createRecommendationCard');
    expect(card).toContain('card.appendChild(renderRecQualityMetrics(rec));');
    expect(card).not.toContain("'Impact: <strong");
    const m = fnBody('renderRecQualityMetrics');
    for (const label of ["'Priority'", "'Value'", "'Confidence'", "'Success odds'", "'Expected cost'", "'Executable'", "'Needs a person'"]) {
      expect(m).toContain(label);
    }
    expect(m).toContain('EXECUTABLE_REC_SOURCE_TYPES.indexOf');
    expect(m).toContain('q.success_odds');
    expect(m).toContain('q.expected_input_tokens');
  });

  it('the executable list is the P4 mirror (MANUALLY_BRIDGEABLE_SOURCE_TYPES), not a second copy', () => {
    const block = varBlock('EXECUTABLE_REC_SOURCE_TYPES');
    const listed = Array.from(block.matchAll(/'([a-z_-]+)'/g)).map((x) => x[1]).sort();
    expect(listed).toEqual([...MANUALLY_BRIDGEABLE_SOURCE_TYPES].sort());
  });

  it('formatRecTokens renders compact token counts', () => {
    // eslint-disable-next-line no-new-func
    const fmt = new Function(`${fnBody('formatRecTokens')}; return formatRecTokens;`)() as (n: unknown) => string;
    expect(fmt(1_000_000)).toBe('1M');
    expect(fmt(1_450_000)).toBe('1.5M');
    expect(fmt(84_000)).toBe('84k');
    expect(fmt(900)).toBe('900');
    expect(fmt(null)).toBe('0');
  });
});

describe('VTID-04671 Why section', () => {
  it('renders quality.review problem, evidence, files with risk, acceptance and why now — all through textContent', () => {
    const w = fnBody('renderRecWhySection');
    expect(w).toContain("document.createElement('details')");
    for (const k of ['review.problem', 'review.evidence', 'review.files', 'review.acceptance', 'review.why_now']) expect(w).toContain(k);
    expect(w).toContain("'Why'");
    expect(w).not.toMatch(/innerHTML/);
    expect(fnBody('appendRecWhyList')).not.toMatch(/innerHTML/);
  });

  it('a scored row without a kept review shows an awaiting-review note', () => {
    const w = fnBody('renderRecWhySection');
    expect(w).toMatch(/review\.verdict !== 'keep'/);
    expect(w).toContain('Awaiting quality review');
  });

  it('the popup footer reports below_floor_count and awaiting_review_count from the listing', () => {
    expect(APP_JS).toContain('below_floor_count: typeof data.below_floor_count');
    expect(APP_JS).toContain('awaiting_review_count: typeof data.awaiting_review_count');
    const modal = fnBody('renderAutopilotRecommendationsModal');
    expect(modal).toContain("' below the quality floor'");
    expect(modal).toContain("' awaiting review'");
  });
});

describe('VTID-04671 dismiss reason picker', () => {
  it('offers exactly the six VTID-04670 reason codes', () => {
    const block = varBlock('REC_DISMISS_REASONS');
    const codes = Array.from(block.matchAll(/code: '([a-z_]+)'/g)).map((x) => x[1]);
    expect(codes).toEqual([...DISMISS_REASON_CODES]);
  });

  it('Dismiss opens the picker; the picker posts reason + reason_code (+ note ≤ 300)', () => {
    const card = fnBody('createRecommendationCard');
    expect(card).toContain('rejectBtn.onclick = function () { openRecDismissPicker(rec); };');
    expect(card).toContain('state.autopilotDismissPickerFor === rec.id');
    const submit = fnBody('submitRecDismiss');
    expect(submit).toContain('reason_code: reasonCode');
    expect(submit).toContain('reason: reasonCode');
    expect(submit).toContain('REC_DISMISS_NOTE_MAX');
    expect(APP_JS).toContain('var REC_DISMISS_NOTE_MAX = 300;');
    const picker = fnBody('renderRecDismissPicker');
    expect(picker).toContain('confirmBtn.disabled = !draft.reason_code;');
    expect(picker).toContain("noteEl.maxLength = REC_DISMISS_NOTE_MAX;");
    expect(picker).not.toMatch(/innerHTML/);
  });

  it('the Overview card uses the same picker', () => {
    expect(APP_JS).toMatch(/dismissBtn\.onclick = function \(e\) \{\s*e\.stopPropagation\(\);\s*openRecDismissPicker\(rec\);/);
  });
});

describe('VTID-04671 live execution after Activate', () => {
  it('a queued execution keeps the card and follows the existing SSE tail', () => {
    const card = fnBody('createRecommendationCard');
    expect(card).toContain("ex.state === 'queued' && ex.execution_id");
    expect(card).toContain("followOperatorExecution(ex.execution_id, 'approved');");
    const activated = fnBody('renderActivatedRecCard');
    expect(activated).toContain('renderAutopilotLiveStepsPanel(entry.execution_id)');
    expect(fnBody('renderAutopilotRecommendationsModal')).toContain('renderActivatedRecCard(entry)');
    // No second stream implementation.
    expect(activated).not.toContain('EventSource');
    expect(fnBody('renderAutopilotRecommendationsModal')).not.toContain('EventSource');
  });

  it('closing the popup closes the followed streams and still resets the modal flag', () => {
    const reset = fnBody('resetAutopilotRecommendationsPopupState');
    expect(reset).toContain('closeOperatorExecutionFollow(e.execution_id)');
    const modal = fnBody('renderAutopilotRecommendationsModal');
    expect((modal.match(/resetAutopilotRecommendationsPopupState\(\);/g) || []).length).toBe(4);
  });
});

describe('VTID-04671 CSP, styling, cache-bust, ownership', () => {
  it('new code uses CSS classes, not inline style strings', () => {
    for (const fn of ['renderRecQualityMetrics', 'recMetric', 'renderRecWhySection', 'renderRecDismissPicker', 'renderActivatedRecCard']) {
      expect(fnBody(fn)).not.toMatch(/style\.cssText|\.style\.|setAttribute\('style'|onclick=\"/);
    }
    for (const cls of ['.rec-q-metrics', '.rec-q-badge--exec', '.rec-q-badge--manual', '.rec-why', '.rec-why-awaiting', '.rec-dismiss-picker', '.rec-footer-held', '.rec-activated']) {
      expect(STYLES).toContain(cls);
    }
  });

  it('cache-bust bumped and the guard allows both VTIDs', () => {
    expect(INDEX_HTML).toContain('app.js?v=20261017-vtid-04671');
    expect(INDEX_HTML).toContain('styles.css?v=20261017-vtid-04671');
    expect(GUARD).toMatch(/ALLOWED_VTID_PATTERN = \/VTID-04671\|VTID-04670\|/);
  });
});
