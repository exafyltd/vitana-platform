/**
 * VTID-03622 — Vitana must never speak a sentence that was written by a human.
 *
 * CLAUDE.md Part 1, NEVER-rule 41: every line the voice says is composed by
 * the model at runtime from an INTENT description. A finished sentence handed
 * to the model as "open with this" overrides the system instruction's own
 * `FLEXIBLE WORDING — ABSOLUTE` rule at point-blank range, and is invisible to
 * every cadence / rotation / anti-repeat mechanism in the greeting brain —
 * those pick which rung fires, they cannot vary wording that arrived
 * pre-written.
 *
 * Reported live: the reconnect-recovery path shipped the literal German
 * sentence "Ich bin wieder da. Lass mich dir den nächsten Schritt zeigen.",
 * heard 49 times. Reconnects are not rare (Nova drops ~10% of sessions at
 * open, CLAUDE.md §2e), so a fixed recovery line became one of the
 * most-heard phrases in the product.
 *
 * This guard is deliberately narrow and mechanical rather than clever: it
 * pins the exact regressions that happened, plus the SHAPE that invites them
 * (a per-language map of finished sentences). A broad "no German anywhere"
 * heuristic would fire on i18n catalogs, comments and test fixtures, get
 * muted, and protect nothing.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const orbLiveRaw = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');
const greetingDecisionRaw = readFileSync(
  join(__dirname, '../../../../src/services/conversation/compute-greeting-decision.ts'),
  'utf8',
);
const wakeBriefRaw = readFileSync(
  join(__dirname, '../../../../src/services/assistant-continuation/providers/voice-wake-brief.ts'),
  'utf8',
);

/**
 * Scan CODE, not prose. The comments in this file deliberately quote the
 * removed sentences so the next reader knows what the regression looked like
 * — a guard that fires on its own documentation would force those comments
 * out and destroy the record of why the rule exists.
 *
 * Line-oriented and intentionally crude: it strips `//` lines and `/* … *␀/`
 * blocks. It is not a JS parser and does not need to be — a hardcoded spoken
 * sentence lives in ordinary code, and anything this misses is caught by the
 * exact-string assertions below.
 */
function stripComments(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    out.push(line);
  }
  return out.join('\n');
}

const orbLive = stripComments(orbLiveRaw);

describe('VTID-03622 — no hardcoded spoken wording in the ORB voice path', () => {
  it('the exact regression sentence is gone, in every language it shipped in', () => {
    // These four were one `intros` map: the same recovery slot, four locales.
    expect(orbLive).not.toContain('Ich bin wieder da.');
    expect(orbLive).not.toContain("I'm back. Let me show you your next step.");
    expect(orbLive).not.toContain('Je suis de retour.');
    expect(orbLive).not.toContain('Estoy de vuelta.');
  });

  it('the recovery path no longer carries per-language finished sentences', () => {
    // The shape, not just the strings. A `Record<lang, Record<slot, sentence>>`
    // of spoken copy is the thing that produced this bug and the thing that
    // let the locales silently drift apart (fr/es idle asked "what do you want
    // to talk about?" while en/de promised to show the next step — the
    // assistant committed to different things depending on language).
    expect(orbLive).not.toMatch(/const intros: Record<string, Record<string, string>>/);
  });

  it('the recovery path hands the model an INTENT, not a script', () => {
    expect(orbLive).toMatch(/const stageIntents: Record<string, string>/);
    expect(orbLive).toMatch(/YOUR ACKNOWLEDGMENT for this stage must: \$\{stageIntent\}/);
  });

  it('the recovery prompt explicitly forbids a memorised line', () => {
    // Without this the model is merely unscripted, not instructed to vary —
    // and an unscripted model asked the same question 49 times will happily
    // answer it the same way 49 times.
    expect(orbLive).toMatch(/Compose that sentence YOURSELF/);
    expect(orbLive).toMatch(/there is no approved phrasing to reproduce/);
    expect(orbLive).toMatch(/Do NOT speak a memorised or fixed sentence/);
  });

  it('no German second-person sentence is handed to the model as speech', () => {
    // Catches the general form of the regression: a quoted German sentence
    // addressing the user informally. Scoped to du-form verbs actually used in
    // spoken copy so it does not fire on comments or identifiers.
    const germanSpoken = /["'`](?:[A-ZÄÖÜ][^"'`\n]{0,120}\s)?(?:Lass mich dir|Ich bin wieder|Ich zeige dir|Schön, dass du)\b/;
    expect(orbLive).not.toMatch(germanSpoken);
  });
});

describe('VTID-03630 — the short-gap opener no longer hands the model a VERBATIM menu', () => {
  // The sibling regression to VTID-03622, found live once VTID-03628/03629
  // disabled the day_close/newday_overview rungs: more reconnects fell
  // through to the short-gap "safe_fast_pending_context" rung and the
  // reconnect/recent/same_day legacy-default buckets, both of which told the
  // model to pick a pool entry from greeting-pools.ts and use it VERBATIM.
  // Nova reliably recited "Lass mich dir den nächsten Schritt zeigen."
  const greetingDecision = stripComments(greetingDecisionRaw);
  const wakeBrief = stripComments(wakeBriefRaw);

  it('compute-greeting-decision.ts never instructs the model to use a menu VERBATIM', () => {
    expect(greetingDecision).not.toMatch(/VERBATIM/);
    expect(greetingDecision).not.toContain('Lass mich dir den nächsten Schritt zeigen');
  });

  it('compute-greeting-decision.ts hands the short-gap rungs an INTENT instead', () => {
    expect(greetingDecision).toMatch(/const SHORT_GAP_OPENER_INTENT =/);
    expect(greetingDecision).toContain('There is no approved phrasing to reproduce');
  });

  it('voice-wake-brief.ts never instructs the model to use a menu VERBATIM', () => {
    expect(wakeBrief).not.toMatch(/Pick ONE of these example phrasings/);
    expect(wakeBrief).not.toContain('use them VERBATIM');
    expect(wakeBrief).toContain('INTENT: briefly and warmly acknowledge');
  });
});

describe('VTID-03742 — the anonymous MAXINA Intro speech is composed fresh, not recited from a fixed script', () => {
  // buildAnonymousSystemInstruction's FIRST MESSAGE block used to hand the
  // model a literal, hand-authored ~45-second script in exactly two
  // languages (German and English), wrapped as "READ THIS SPEECH VERBATIM —
  // DO NOT SHORTEN, SKIP, OR SUMMARIZE". Any OTHER language selected the
  // English script while a separate LANGUAGE line said "Respond ONLY in
  // {language}" — a live full-recitation-translation demand, the exact
  // instruction shape VTID-03674 already proved trips Nova's content filter.
  // Reported live: an anonymous Serbian session showed the "speaking"
  // caption with no audio (VTID-03740) — traced to this rung.
  //
  // Fix mirrors the proven pattern from buildGuidedTopicNarrationBlock
  // (guided-topic-narration-prompt.ts): hand the model English-authored
  // MATERIAL and instruct it to compose the delivery fresh in the target
  // language, in its own words — applied uniformly to every language,
  // including German/English (which also got a finished script before,
  // just one that happened to already match their spoken language).

  it('the old literal German and English scripts are gone, in full', () => {
    expect(orbLive).not.toContain('Hallo aus [Stadt wenn bekannt]!');
    expect(orbLive).not.toContain('Lass mich dir erzählen, worum es hier geht.');
    expect(orbLive).not.toContain('Hello from [city if known]!');
    expect(orbLive).not.toContain("Let me tell you what this is all about.");
    expect(orbLive).not.toMatch(/READ THIS SPEECH VERBATIM/);
    expect(orbLive).not.toMatch(/\$\{lang === 'de' \? `"""\s*\nHallo aus/);
  });

  it('the anonymous intro now hands the model material to paraphrase, not a script to recite', () => {
    expect(orbLive).toMatch(
      /FIRST MESSAGE \(INTRODUCE VITANALAND — COMPOSE THIS FRESH, DO NOT RECITE THE MATERIAL BELOW WORD-FOR-WORD\)/,
    );
    expect(orbLive).toMatch(/Material to introduce, in your own words/);
    expect(orbLive).toMatch(/paraphrase and explain naturally, do NOT read aloud/);
  });

  it('the language directive is explicit that the material is reference content, not a translation target', () => {
    expect(orbLive).toMatch(
      /The material below is English reference content, not a script to translate/,
    );
  });

  it('every required talking point survives as material, not as finished prose', () => {
    const talkingPoints = [
      /Mariia Maksina/,
      /Let's Dance/,
      /Germany, Austria, and Switzerland/,
      /Mallorca/,
      /dance sessions, fitness classes, wellness workshops, cooking events, meditation groups, hiking meetups/,
      /personal AI health companion/,
      /curated soundscapes/,
      /completely free/,
      /what excites them most/,
    ];
    for (const point of talkingPoints) {
      expect(orbLive).toMatch(point);
    }
  });
});
