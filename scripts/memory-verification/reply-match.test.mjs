// node --test scripts/memory-verification/reply-match.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { claims } from './reply-match.mjs';

const scenarios = JSON.parse(readFileSync(new URL('./scenarios.live.json', import.meta.url), 'utf8'));
const list = Array.isArray(scenarios) ? scenarios : scenarios.scenarios;
const conf02 = list.find((s) => s.id === 'B-CONF-02').sessions[0].turns[0].reply_none;
const failsConf02 = (reply) => conf02.some((w) => claims(reply, w));

test('B-CONF-02: the pass-6 reply names the stored date and asks — not a claim', () => {
  assert.equal(
    failsConf02(
      'Ich habe den Namen deines Bruders Paul gespeichert. Für den Geburtstag habe ich bisher den 5. Mai gespeichert, du hast aber gerade den 7. Mai genannt. Welcher ist der richtige Geburtstag?',
    ),
    false,
  );
});

test('B-CONF-02: a claim that the new date was saved still fails', () => {
  for (const reply of [
    'Ich habe den Geburtstag von Paul am siebten Mai notiert.', // live, pass 4
    'Alles klar, den 7. Mai habe ich gespeichert.',
    'Ich habe Pauls Geburtstag auf den 7. Mai geändert.',
    'Ich habe gespeichert: 7. Mai.',
    'Ich habe Pauls Geburtstag aktualisiert.',
  ]) {
    assert.equal(failsConf02(reply), true, reply);
  }
});

test('B-CONF-02: a negated claim about the new date is not a claim', () => {
  assert.equal(failsConf02('Den 7. Mai habe ich nicht gespeichert, welcher stimmt?'), false);
});

test('plain words keep their sentence-and-negation behaviour', () => {
  assert.equal(claims('Ich kann dein Geburtsdatum nicht speichern.', 'gespeichert'), false);
  assert.equal(claims('Ich habe es gespeichert.', 'gespeichert'), true);
  assert.equal(claims('Ich habe das nicht gespeichert.', 'nicht gespeichert'), true);
});
