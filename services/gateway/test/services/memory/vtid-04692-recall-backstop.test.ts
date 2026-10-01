/**
 * VTID-04692: a question about a stored fact the voice model answered with
 * "not stored". Live suite on staging, 2026-09-28 — the replies below are the
 * model's own words from the failing runs.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  buildRecallBackstopNote,
  detectAboutMeQuestion,
  detectRecallQuestion,
  recallScore,
  replyContainsStoredValue,
  replyDeniesOrDefers,
} from '../../../src/services/memory/recall-backstop';
import { REMEMBER_BACKSTOP_MARKER } from '../../../src/services/memory/remember-backstop';
import { maybeRunRecallBackstop } from '../../../src/orb/live/session/remember-backstop-hook';

const BASELINE = Array.from({ length: 10 }, (_, i) => ({ fact_key: `baseline_${i}`, fact_value: `Wert ${i}` }));
const facts = [{ fact_key: 'user_pet_name', fact_value: 'Bello' }, { fact_key: 'paul_birthday', fact_value: 'May 5' }, ...BASELINE];

const LIVE_DENIALS = [
  'Ich sehe, dass du nach dem Namen deines Hundes fragst. Leider habe ich diese Information nicht in deinen gespeicherten Daten.',
  'Ich kann dir leider nicht den Namen deines Hundes sagen, da diese Information nicht in deinem Profil gespeichert ist.',
  'Ich habe in deinen Informationen nachgeschaut, aber ich konnte den Namen deines Hundes nicht finden.',
  'Ich kann dir gerne helfen, aber ich muss erst in deinen Informationen nachsehen. Einen Moment bitte.',
  'Ich habe deine Anfrage notiert, aber ich kann keine persönlichen Daten wie Geburtstage von Familienmitgliedern anzeigen oder verwalten.',
  'Leider kann ich keine relevanten Details für Ihre Frage finden.',
];

describe('VTID-04692 detection', () => {
  it.each(['Wie heißt mein Hund?', 'Wann feiert mein Bruder Paul eigentlich?', 'Wann hat mein Bruder Paul Geburtstag?', 'What is my favourite colour?', 'Weißt du noch, wie mein Hund heißt?'])(
    'a question about own details: %s',
    (q) => expect(detectRecallQuestion(q)).toBe(true),
  );
  it.each(['Wie geht es dir?', 'Was kann ich heute machen?', 'Merk dir, mein Hund heißt Bello', `${REMEMBER_BACKSTOP_MARKER} Wie heißt mein Hund?`])(
    'not a recall question: %s',
    (q) => expect(detectRecallQuestion(q)).toBe(false),
  );
  it.each(LIVE_DENIALS)('every live failing reply is a denial or deferral: %s', (r) => expect(replyDeniesOrDefers(r)).toBe(true));
  it('a real answer is not a denial', () => {
    expect(replyDeniesOrDefers('Dein Hund heißt Bello.')).toBe(false);
    expect(replyContainsStoredValue('Dein Hund heißt Bello.', facts)).toBe(true);
  });
  it('"Was weißt du eigentlich alles über mich?" is an about-me question (live B-REC-06)', () => {
    expect(detectAboutMeQuestion('Was weißt du eigentlich alles über mich?')).toBe(true);
    expect(detectAboutMeQuestion('What do you know about me?')).toBe(true);
    expect(detectAboutMeQuestion('Was weißt du über Berlin?')).toBe(false);
  });
});

describe('VTID-04692 note', () => {
  it('lists the facts with the matching one first and never the system keys', () => {
    const many = [...Array.from({ length: 60 }, (_, i) => ({ fact_key: `user_note_${i}`, fact_value: `Notiz ${i}` })), ...facts, { fact_key: 'preferred_language', fact_value: 'de' }];
    const note = buildRecallBackstopNote(many, 'Wie heißt mein Hund?')!;
    expect(note.startsWith(REMEMBER_BACKSTOP_MARKER)).toBe(true);
    expect(note.split('\n')[1]).toBe('- user_pet_name: Bello');
    expect(note).not.toMatch(/preferred_language/);
    expect(note.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(40);
  });
  it('ranks by the asked person and topic', () => {
    expect(recallScore('Wann feiert mein Bruder Paul?', { fact_key: 'paul_birthday', fact_value: 'May 5' })).toBeGreaterThan(
      recallScore('Wann feiert mein Bruder Paul?', { fact_key: 'user_pet_name', fact_value: 'Bello' }),
    );
  });
  it('is null when nothing is stored', () => {
    expect(buildRecallBackstopNote([{ fact_key: 'locale', fact_value: 'de' }])).toBeNull();
  });
  it('the about-me note asks for a few concrete facts, not keys', () => {
    expect(buildRecallBackstopNote(facts, 'Was weißt du über mich?', 'about_me_vague')).toMatch(/name two or three of the first facts/);
  });
});

describe('VTID-04692 live hook', () => {
  const diag = jest.fn();
  const ctx = { deps: { emitDiag: diag } };
  const session = (over: Record<string, unknown> = {}) =>
    ({
      sessionId: 's1',
      active: true,
      upstreamProvider: 'nova_sonic',
      identity: { user_id: 'u1', tenant_id: 't1' },
      upstreamClient: { sendTextTurn: jest.fn(() => true) },
      ...over,
    }) as any;
  const deps = { listCurrentFacts: jest.fn(async () => facts) };

  it('injects the facts after a live B-REC-01 denial', async () => {
    const s = session();
    const n = await maybeRunRecallBackstop(ctx, s, 'Wie heißt mein Hund?', LIVE_DENIALS[0], deps);
    expect(n).toBe(facts.length);
    const note = s.upstreamClient.sendTextTurn.mock.calls[0][0] as string;
    expect(note).toMatch(/user_pet_name: Bello/);
    expect(diag).toHaveBeenCalledWith(s, 'recall_backstop', expect.objectContaining({ trigger: 'denied', injected: true }));
  });
  it('injects after a vague about-me answer (live B-REC-06)', async () => {
    const s = session();
    await maybeRunRecallBackstop(
      ctx,
      s,
      'Was weißt du eigentlich alles über mich?',
      'Ich kann dir gerne einen Überblick über die Informationen geben, die ich über dich gespeichert habe.',
      deps,
    );
    expect(s.upstreamClient.sendTextTurn.mock.calls[0][0]).toMatch(/named none of the things they told you/);
  });
  it('stays silent when the reply already answered', async () => {
    const s = session();
    expect(await maybeRunRecallBackstop(ctx, s, 'Wie heißt mein Hund?', 'Leider weiß ich nicht mehr genau, aber ich glaube Bello.', deps)).toBe(0);
    expect(s.upstreamClient.sendTextTurn).not.toHaveBeenCalled();
  });
  it('stands down on a remember/forget turn, a remember request, or a non-Nova session', () => {
    expect(maybeRunRecallBackstop(ctx, session({ memoryWriteToolCalledThisTurn: true }), 'Wie heißt mein Hund?', LIVE_DENIALS[0], deps)).toBeNull();
    expect(maybeRunRecallBackstop(ctx, session(), 'Merk dir, mein Hund heißt Bello', LIVE_DENIALS[0], deps)).toBeNull();
    expect(maybeRunRecallBackstop(ctx, session({ upstreamProvider: 'vertex' }), 'Wie heißt mein Hund?', LIVE_DENIALS[0], deps)).toBeNull();
  });
  it('stays silent when nothing is stored', async () => {
    const s = session();
    await maybeRunRecallBackstop(ctx, s, 'Wie heißt mein Hund?', LIVE_DENIALS[0], { listCurrentFacts: jest.fn(async () => []) });
    expect(s.upstreamClient.sendTextTurn).not.toHaveBeenCalled();
  });
  it('is wired at turn_complete and the write-tool flag is set and cleared', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/orb/live/session/upstream-message-handler.ts'), 'utf8');
    expect(src).toMatch(/maybeRunRecallBackstop\(ctx, session, userText, session\.outputTranscriptBuffer \|\| ''\)/);
    expect(src).toMatch(/\(session as any\)\.memoryWriteToolCalledThisTurn = true;/);
    expect(src).toMatch(/\(session as any\)\.memoryWriteToolCalledThisTurn = false;/);
  });
});
