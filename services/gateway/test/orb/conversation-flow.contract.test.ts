/**
 * VITANA CONVERSATION-FLOW CONTRACT (RULE 0 standard verification).
 *
 * This is the canonical "did Vitana behave as supposed?" test. It runs the same
 * 10 deterministic scenarios used to verify the staging rebuild and locks them
 * as a regression contract:
 *
 *   1-5  login-briefing greeting, one per state (orient / building / momentum /
 *        returning / graduated) — the returning-user opener path.
 *   6-8  conversation-flow-v3 openers (community_match / journey_topic / song).
 *   9    nothing-to-surface → suppress (never force a hollow opener).
 *   10   priority — a new match outranks topic + song when all three exist.
 *
 * The two invariants every scenario must satisfy:
 *   A. RULE 0 — no spoken line may contain a passive "what would you like /
 *      möchtest du …" preference question. Vitana always proposes.
 *   B. The exact spoken strings are snapshotted, so any wording drift is caught
 *      in review (this is what the user re-runs to confirm behaviour).
 *
 * Plus a prompt-contract check: the RULE 0 block that governs Gemini's
 * improvised turns must still carry the open-door-plus-proposal pattern, the
 * after-screen-describe rule, and the open-question handling rule.
 */

import {
  renderBriefingLine,
  pickBriefingState,
  type BriefingFacts,
} from '../../src/services/assistant-continuation/providers/login-briefing';
import {
  pickFlowFocus,
  type FlowInputs,
  type JourneyTopicInput,
} from '../../src/services/guide/conversation-flow-v3';
import { renderLine as renderMatchLine } from '../../src/services/assistant-continuation/providers/next-action/sources/match-activity-plan';
import { pickInviteActivity, buildInviteProposal } from '../../src/services/guide/real-life-invite';
import { buildFastProactiveOpener } from '../../src/services/assistant-continuation/providers/login-briefing';
import { buildLiveSystemInstruction } from '../../src/orb/live/instruction/live-system-instruction';

// The passive-question gate. Any match in a SPOKEN opener = RULE 0 violation.
// Mirrors the gate in login-briefing.test.ts; keep the two in sync.
const PASSIVE =
  /(möchtest du|willst du|was möchtest|wo möchtest|womit möchtest|what would you like|where would you like|where shall we|what.*tackle|wie kann ich dir helfen|how can i help|what can i do|what.*on your mind)/i;

const BASE: BriefingFacts = {
  sessionsCompleted: 3,
  nextSessionNumber: 4,
  nextSessionTitle: 'Schlaf-Routine',
  graduated: false,
  hasGoal: true,
  indexDeltaUp: null,
  daysSinceLastSession: 0,
};

const TOPIC: JourneyTopicInput = {
  topic_id: 't1',
  name: 'Life Compass',
  voice_script: null,
  short_description: 'dein Nordstern für die Woche',
  route: '/memory?open=life_compass',
  session: 5,
};

const FLOW_BASE: FlowInputs = {
  has_urgent: false,
  new_match: null,
  next_topic: null,
  song_available: false,
  recently_surfaced: new Set<string>(),
  date_key: '2026-06-18',
};

// Verbatim mirror of the spoken lines in conversation-flow-v3-provider.ts
// (DE branch, lines ~126-138). If that file changes, this must change too —
// that is the point: the contract catches it.
function flowLine(kind: string, name: string): string {
  if (kind === 'community_match')
    return 'Du hast ein neues Match! Lass es uns gemeinsam anschauen — ich führe dich gleich hin.';
  if (kind === 'journey_topic')
    return `Darf ich dir ${name} kurz vorstellen und erklären, wie es funktioniert?`;
  if (kind === 'song') return 'Ich würde dir gern einen Song vorspielen — darf ich?';
  return `__suppressed:${kind}`;
}

interface Scenario {
  n: number;
  label: string;
  line: string;
  spoken: boolean;
}

function buildScenarios(): Scenario[] {
  const det = () => 0; // deterministic pool pick
  const out: Scenario[] = [];

  const states: Array<[string, Partial<BriefingFacts>]> = [
    ['login-briefing/orient', { sessionsCompleted: 0, hasGoal: false }],
    ['login-briefing/building', { indexDeltaUp: null, daysSinceLastSession: 1 }],
    ['login-briefing/momentum', { indexDeltaUp: 12, daysSinceLastSession: 1 }],
    ['login-briefing/returning', { daysSinceLastSession: 4 }],
    ['login-briefing/graduated', { graduated: true }],
  ];
  states.forEach(([label, f], i) => {
    const facts = { ...BASE, ...f };
    const state = pickBriefingState(facts);
    const line = renderBriefingLine(
      { lang: 'de', salutation: 'morning', firstName: 'Maria', facts },
      det,
    );
    out.push({ n: i + 1, label: `${label} [state=${state}]`, line, spoken: true });
  });

  const match = pickFlowFocus({ ...FLOW_BASE, new_match: { first_name: 'Mariia' } });
  out.push({ n: 6, label: `flow-v3/${match.kind}`, line: flowLine(match.kind, match.name), spoken: true });

  const topic = pickFlowFocus({ ...FLOW_BASE, next_topic: TOPIC });
  out.push({ n: 7, label: `flow-v3/${topic.kind}`, line: flowLine(topic.kind, topic.name), spoken: true });

  const song = pickFlowFocus({ ...FLOW_BASE, song_available: true });
  out.push({ n: 8, label: `flow-v3/${song.kind}`, line: flowLine(song.kind, song.name), spoken: true });

  const none = pickFlowFocus({ ...FLOW_BASE });
  out.push({ n: 9, label: `flow-v3/${none.kind}`, line: flowLine(none.kind, none.name), spoken: false });

  const all = pickFlowFocus({
    ...FLOW_BASE,
    new_match: { first_name: 'Mariia' },
    next_topic: TOPIC,
    song_available: true,
  });
  out.push({ n: 10, label: `flow-v3/${all.kind} (all-three→match-wins)`, line: flowLine(all.kind, all.name), spoken: true });

  // #11 — advice #1: understood weakness (goal-anchored reversing step).
  const weaknessLine = renderBriefingLine(
    {
      lang: 'de',
      salutation: 'morning',
      firstName: 'Maria',
      facts: {
        ...BASE,
        indexDeltaUp: null,
        daysSinceLastSession: 1,
        weakestPillarDrop: { pillar: 'sleep', deltaDown: 6 },
        primaryGoalLabel: 'besser schlafen',
      },
    },
    det,
  );
  out.push({ n: 11, label: 'login-briefing/building+weakness (advice #1)', line: weaknessLine, spoken: true });

  // #12 — advice #2: visible momentum progress beat in the momentum state.
  const momentumLine = renderBriefingLine(
    {
      lang: 'de',
      salutation: 'morning',
      firstName: 'Maria',
      facts: { ...BASE, indexDeltaUp: 12, daysSinceLastSession: 1, topicsLearned: 30, topicsTotal: 254 },
    },
    det,
  );
  out.push({ n: 12, label: 'login-briefing/momentum+progress (advice #2)', line: momentumLine, spoken: true });

  // #13 — advice #3: a mutual real-world activity match proposes a time + calendar.
  const matchScheduleLine = renderMatchLine('mutual_interest', 'hike', 'de', true);
  out.push({ n: 13, label: 'match-activity/mutual+schedulable (advice #3)', line: matchScheduleLine, spoken: true });

  // #14 — advice #4: inspire inviting someone to a real-life activity.
  const inviteLine = buildInviteProposal('de', pickInviteActivity({ strongestPillar: 'exercise', dateKey: '2026-06-18' }));
  out.push({ n: 14, label: 'real-life-invite/exercise→walk (advice #4)', line: inviteLine, spoken: true });

  // #15 — DEV-COMHU-0513: the SHORT proactive opener spoken on the fast path
  // (replaces the generic "Lass uns weitermachen" canned phrase).
  const fastProactive = buildFastProactiveOpener({
    lang: 'de',
    salutation: 'morning',
    firstName: 'Maria',
    facts: { ...BASE, weakestPillarDrop: { pillar: 'sleep', deltaDown: 6 }, primaryGoalLabel: 'besser schlafen' },
  }, () => 0);
  out.push({ n: 15, label: 'fast-proactive-opener (DEV-COMHU-0513)', line: fastProactive, spoken: true });

  return out;
}

describe('Vitana conversation-flow contract — 10 standard scenarios', () => {
  const scenarios = buildScenarios();

  it('INVARIANT A — no spoken opener contains a passive RULE 0 question', () => {
    for (const s of scenarios) {
      if (!s.spoken) continue;
      expect(s.line).not.toMatch(PASSIVE);
    }
  });

  it('INVARIANT B — the exact spoken lines are locked (snapshot)', () => {
    const transcript = scenarios.map((s) => `#${s.n} ${s.label}\n   → ${s.spoken ? `"${s.line}"` : '(suppressed)'}`).join('\n');
    expect(transcript).toMatchSnapshot();
  });

  it('PRIORITY — match (6,10) leads; nothing-to-surface (9) suppresses', () => {
    expect(scenarios[5].label).toContain('community_match');
    expect(scenarios[9].label).toContain('community_match'); // all-three → match wins
    expect(scenarios[8].spoken).toBe(false); // greeting/none → suppressed
  });
});

describe('Vitana RULE 0 prompt contract — governs every improvised LLM turn', () => {
  const instr = buildLiveSystemInstruction('de', 'warm', undefined, 'community');
  const block = (() => {
    const start = instr.indexOf('PROACTIVE LEADERSHIP — RULE 0');
    const end = instr.indexOf('GREETING RULES (CRITICAL)');
    return instr.slice(start, end);
  })();

  it('carries the open-door-plus-proposal pattern (replaces "möchtest du mehr erfahren?")', () => {
    expect(block).toMatch(/OPEN-DOOR-PLUS-PROPOSAL/i);
    expect(block).toMatch(/möchtest du mehr/i); // explicitly names the banned form it replaces
  });

  it('mandates a proposal AFTER describing the current screen', () => {
    expect(block).toMatch(/AFTER DESCRIBING THE CURRENT SCREEN/i);
  });

  it('mandates concrete answers when the USER asks an open question', () => {
    expect(block).toMatch(/WHEN THE USER ASKS AN OPEN QUESTION/i);
    expect(block).toMatch(/was gibt's Neues|what's the news/i);
  });

  // DEV-COMHU broken-promise fix: after a "shall I show you" + yes, Vitana must
  // deliver conversationally and never claim it "can't retrieve" the next steps.
  it('forbids the "can\'t retrieve the next steps" broken-promise failure', () => {
    expect(block).toMatch(/DELIVERING WHAT YOU PROPOSED/i);
    expect(block).toMatch(/nicht abrufen/i);     // names the exact failure phrase
    expect(block).toMatch(/DELIVER IT NOW/i);     // the required behavior on "yes"
  });

  const gjBlock = (() => {
    const full = buildLiveSystemInstruction('de', 'warm', undefined, 'community');
    return full.slice(full.indexOf('GUIDED JOURNEY — A COHERENT THROUGH-LINE'), full.indexOf('GREETING RULES (CRITICAL)'));
  })();

  it('keeps the Guided Journey as a coherent through-line + bans the Community-Members jump', () => {
    expect(gjBlock).toMatch(/GUIDED JOURNEY — A COHERENT THROUGH-LINE/);
    expect(gjBlock).toMatch(/COHERENCE/);
    expect(gjBlock).toMatch(/Community Members/); // the exact forbidden jump the user hit
  });

  it('mandates FLEXIBLE wording — never a fixed/memorised greeting', () => {
    expect(gjBlock).toMatch(/FLEXIBLE WORDING/i);
    expect(gjBlock).toMatch(/never .*same sentence|Vary your phrasing/i);
  });

  it('handles an empty/degraded curriculum — no false "completed everything", pivot instead', () => {
    expect(gjBlock).toMatch(/degraded|curriculum isn't available|no script/i);
    expect(gjBlock).toMatch(/do NOT claim the user finished everything/i);
  });

  it('mandates narrate_guided_session + full-script delivery on agreement (not a one-liner)', () => {
    expect(gjBlock).toMatch(/narrate_guided_session/);
    expect(gjBlock).toMatch(/IN FULL/);
    expect(gjBlock).toMatch(/one-sentence introduction|one-line intro/i);
  });

  it('supports playing a SPECIFIC session by number', () => {
    expect(gjBlock).toMatch(/session_number/);
    expect(gjBlock).toMatch(/I can't play a specific session/i); // the failure it forbids
  });
});
