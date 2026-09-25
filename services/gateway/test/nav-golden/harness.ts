/**
 * VTID-04496 — Navigation rebuild, Phase 0: the evaluation harness.
 *
 * Resolver-agnostic on purpose. Today it measures the legacy navigator
 * (consultNavigator); in Phase 2 the new resolver plugs into the same
 * `NavResolver` shape and is held to the same set, so the rebuild is judged
 * against one fixed baseline instead of against a feeling.
 *
 * Outcomes a resolver can report:
 *   'open'    — navigate now.
 *   'offer'   — say where it is and ask "shall I open it?".
 *   'clarify' — ask the user which of several screens they meant.
 *   'none'    — no navigation.
 */
import type { GoldenCase, GoldenIntent, GoldenLang } from './golden-set';

export type NavOutcome = 'open' | 'offer' | 'clarify' | 'none';

export interface NavResolution {
  outcome: NavOutcome;
  /** The screen that would be opened or offered; null when none. */
  screen_id: string | null;
  /** Screens named when asking the user to choose. */
  candidates?: string[];
}

export type NavResolver = (c: GoldenCase) => Promise<NavResolution>;

export type Verdict =
  /** Right screen AND the behaviour the policy asks for. */
  | 'correct'
  /** Right screen, wrong behaviour (e.g. opened when it should have offered). */
  | 'right_screen_wrong_behaviour'
  /** Asked the user to choose, and the right screen was among the choices. */
  | 'clarified_with_right_option'
  /** Did nothing useful for a navigation request. */
  | 'silent'
  /** Opened or offered a screen that is not acceptable. The dangerous class. */
  | 'wrong_screen'
  /** Opened or offered something for a non-navigation utterance. */
  | 'false_action';

export interface CaseResult {
  case: GoldenCase;
  resolution: NavResolution;
  verdict: Verdict;
  /** Wrong screen that is on the case's forbid list (e.g. news → cart). */
  forbidden_hit: boolean;
}

export interface Metrics {
  total: number;
  correct: number;
  /** User ends up on (or is offered) the right screen, whatever the wording. */
  reaches_right_screen: number;
  wrong_screen: number;
  forbidden_hits: number;
  false_action: number;
  silent: number;
  clarified_with_right_option: number;
  right_screen_wrong_behaviour: number;
}

export interface Report {
  resolver: string;
  overall: Metrics;
  by_lang: Record<string, Metrics>;
  by_intent: Record<string, Metrics>;
  results: CaseResult[];
}

const EXPECTED_OUTCOME: Record<GoldenIntent, NavOutcome> = {
  open: 'open',
  where: 'offer',
  none: 'none',
};

export function judge(c: GoldenCase, r: NavResolution): CaseResult {
  const acts = r.outcome === 'open' || r.outcome === 'offer';
  const forbidden_hit = acts && !!r.screen_id && !!c.forbid?.includes(r.screen_id);

  let verdict: Verdict;
  if (c.intent === 'none') {
    verdict = acts ? 'false_action' : 'correct';
  } else if (acts) {
    const right = !!r.screen_id && c.expect.includes(r.screen_id);
    if (!right) verdict = 'wrong_screen';
    else verdict = r.outcome === EXPECTED_OUTCOME[c.intent] ? 'correct' : 'right_screen_wrong_behaviour';
  } else if (r.outcome === 'clarify' && (r.candidates || []).some((s) => c.expect.includes(s))) {
    verdict = 'clarified_with_right_option';
  } else {
    verdict = 'silent';
  }
  return { case: c, resolution: r, verdict, forbidden_hit };
}

function emptyMetrics(): Metrics {
  return {
    total: 0, correct: 0, reaches_right_screen: 0, wrong_screen: 0, forbidden_hits: 0,
    false_action: 0, silent: 0, clarified_with_right_option: 0, right_screen_wrong_behaviour: 0,
  };
}

function add(m: Metrics, r: CaseResult): void {
  m.total++;
  if (r.forbidden_hit) m.forbidden_hits++;
  switch (r.verdict) {
    case 'correct':
      m.correct++;
      if (r.case.intent !== 'none') m.reaches_right_screen++;
      break;
    case 'right_screen_wrong_behaviour':
      m.right_screen_wrong_behaviour++;
      m.reaches_right_screen++;
      break;
    case 'clarified_with_right_option': m.clarified_with_right_option++; break;
    case 'silent': m.silent++; break;
    case 'wrong_screen': m.wrong_screen++; break;
    case 'false_action': m.false_action++; break;
  }
}

export async function evaluate(name: string, cases: GoldenCase[], resolver: NavResolver): Promise<Report> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    let resolution: NavResolution;
    try {
      resolution = await resolver(c);
    } catch {
      resolution = { outcome: 'none', screen_id: null };
    }
    results.push(judge(c, resolution));
  }
  const overall = emptyMetrics();
  const by_lang: Record<string, Metrics> = {};
  const by_intent: Record<string, Metrics> = {};
  for (const r of results) {
    add(overall, r);
    add((by_lang[r.case.lang] ||= emptyMetrics()), r);
    add((by_intent[r.case.intent] ||= emptyMetrics()), r);
  }
  return { resolver: name, overall, by_lang, by_intent, results };
}

const pct = (n: number, d: number) => (d === 0 ? '  -  ' : `${((100 * n) / d).toFixed(1).padStart(5)}%`);

export function formatReport(rep: Report): string {
  const line = (label: string, m: Metrics) =>
    `${label.padEnd(8)} n=${String(m.total).padStart(3)}  correct ${pct(m.correct, m.total)}  ` +
    `reaches ${pct(m.reaches_right_screen, m.total)}  wrong ${String(m.wrong_screen).padStart(3)}  ` +
    `forbidden ${String(m.forbidden_hits).padStart(2)}  silent ${String(m.silent).padStart(3)}  ` +
    `false-action ${String(m.false_action).padStart(2)}`;
  const out: string[] = [`=== NAV GOLDEN REPORT — ${rep.resolver} ===`, line('ALL', rep.overall), ''];
  for (const [k, m] of Object.entries(rep.by_intent)) out.push(line(`intent:${k}`, m));
  out.push('');
  const langs = Object.keys(rep.by_lang).sort() as GoldenLang[];
  for (const l of langs) out.push(line(l, rep.by_lang[l]));
  out.push('', 'Failures:');
  for (const r of rep.results) {
    if (r.verdict === 'correct') continue;
    const got = r.resolution.outcome === 'clarify'
      ? `clarify[${(r.resolution.candidates || []).join('|')}]`
      : `${r.resolution.outcome}:${r.resolution.screen_id ?? '-'}`;
    out.push(
      `  ${r.forbidden_hit ? '!!' : '  '} ${r.verdict.padEnd(28)} ${r.case.id.padEnd(28)} ` +
      `"${r.case.utterance}" → ${got}  expect∈[${r.case.expect.join('|')}]`,
    );
  }
  return out.join('\n');
}

/** Numbers only — what the baseline file stores and the ratchet compares. */
export function summarize(rep: Report) {
  return { resolver: rep.resolver, overall: rep.overall, by_lang: rep.by_lang, by_intent: rep.by_intent };
}
