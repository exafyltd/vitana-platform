/**
 * VTID-04685: a hypothetical is not stored as a fact.
 *
 * Live suite B-NOISE-01 (staging, 2026-09-26): "wenn ich einen Hund hätte,
 * würde er Max heißen" was stored as user_preference_dog_name=Max. Pins the
 * conditional-mood detector, the per-value filter the background extractor
 * applies, and that the extractor and its prompt carry the rule.
 */
import * as fs from 'fs';
import * as path from 'path';

import { isHypothetical, valueOnlyInNonStatements, memberLines } from '../../../src/services/memory/memory-intent';

describe('VTID-04685 isHypothetical', () => {
  it.each([
    'wenn ich einen hund hätte würde er max heißen',
    'Falls ich ein Auto hätte, wäre es rot',
    'hätte ich einen Garten, würde ich Tomaten pflanzen',
    'stell dir vor ich wäre Pilot',
    'if I had a dog it would be called Max',
    'imagine if I lived in Paris',
    'si tuviera un perro se llamaría Max',
  ])('treats "%s" as hypothetical', (t) => expect(isHypothetical(t)).toBe(true));

  it.each([
    'mein Hund heißt Bello',
    'wenn ich morgen Zeit habe, gehe ich laufen',
    'I have a dog called Max',
    'merk dir mein lieblingsessen ist lasagne',
    '',
  ])('does not treat "%s" as hypothetical', (t) => expect(isHypothetical(t)).toBe(false));
});

describe('VTID-04685 valueOnlyInNonStatements', () => {
  it('drops a value said only inside a hypothetical', () => {
    const convo = 'User: wenn ich einen Hund hätte, würde er Max heißen\nAssistant: Schöner Name!';
    expect(valueOnlyInNonStatements('Max', convo)).toBe(true);
  });

  it('drops a value said only inside a forget request', () => {
    const convo = 'User: vergiss bitte dass mein Hund Bello heißt\nAssistant: Erledigt.';
    expect(valueOnlyInNonStatements('Bello', convo)).toBe(true);
  });

  it('keeps a value the member also states plainly', () => {
    const convo = 'User: wenn ich einen zweiten Hund hätte, würde er Max heißen\nUser: mein Hund heißt Max';
    expect(valueOnlyInNonStatements('Max', convo)).toBe(false);
  });

  it('keeps a plain statement and ignores the assistant lines', () => {
    const convo = 'User: mein Hund heißt Bello\nAssistant: wenn du willst, würde ich Bello notieren';
    expect(valueOnlyInNonStatements('Bello', convo)).toBe(false);
  });

  it('keeps values it cannot place (the extractor paraphrased them)', () => {
    expect(valueOnlyInNonStatements('Max Mustermann', 'User: wenn ich einen Hund hätte')).toBe(false);
  });

  it('reads member lines from labelled and unlabelled transcripts', () => {
    expect(memberLines('User: a\nAssistant: b\nuser: c')).toEqual(['a', 'c']);
    expect(memberLines('plain line')).toEqual(['plain line']);
  });
});

describe('VTID-04685 the extractor applies the rule', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../../src/services/inline-fact-extractor.ts'), 'utf8');
  it('filters extracted facts through valueOnlyInNonStatements before persisting', () => {
    expect(src).toMatch(/valueOnlyInNonStatements\(f\.fact_value, input\.conversationText\)/);
  });
  it('tells the extraction model that hypotheticals and forget requests are not facts', () => {
    expect(src).toMatch(/A hypothetical, wish or "what if" is NOT a fact/);
    expect(src).toMatch(/A request to FORGET something is not a statement of it/);
  });
});
