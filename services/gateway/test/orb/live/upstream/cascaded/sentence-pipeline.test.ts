/**
 * VTID-04550 — pure pieces of the cascade sentence pipeline: the flag reader,
 * the sentence splitter (partition property across every cascade language)
 * and the in-order synthesize-then-emit loop.
 */

import {
  isCascadeStreamingEnabled,
  splitReplyIntoSentences,
  speakableSegments,
  speakSegmentsInOrder,
} from '../../../../../src/orb/live/upstream/cascaded/sentence-pipeline';

describe('VTID-04550 isCascadeStreamingEnabled', () => {
  it('is on only for the exact string "true"', () => {
    expect(isCascadeStreamingEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    for (const v of ['false', 'TRUE', 'True', '1', 'yes', ' true', 'staging-only', '']) {
      expect(isCascadeStreamingEnabled({ ORB_CASCADE_STREAMING_ENABLED: v } as NodeJS.ProcessEnv)).toBe(false);
    }
    expect(isCascadeStreamingEnabled({ ORB_CASCADE_STREAMING_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('VTID-04550 splitReplyIntoSentences', () => {
  const cases: Array<[string, string, string[]]> = [
    ['de', 'Hallo Anna! Wie geht es dir heute? Ich habe eine Idee.', ['Hallo Anna! ', 'Wie geht es dir heute? ', 'Ich habe eine Idee.']],
    ['en', 'Sure. Let me check that for you.', ['Sure. ', 'Let me check that for you.']],
    ['ru', 'Привет! Как дела? Всё хорошо.', ['Привет! ', 'Как дела? ', 'Всё хорошо.']],
    ['pl', 'Cześć! Jak się masz?', ['Cześć! ', 'Jak się masz?']],
    ['tr', 'Merhaba! Bugün nasılsın? Harika.', ['Merhaba! ', 'Bugün nasılsın? ', 'Harika.']],
    ['zh', '你好！今天怎么样？我们开始吧。', ['你好！', '今天怎么样？', '我们开始吧。']],
    ['ar', 'مرحبا! كيف حالك اليوم؟ لنبدأ.', ['مرحبا! ', 'كيف حالك اليوم؟ ', 'لنبدأ.']],
    ['sr', 'Zdravo! Kako si danas? Hajde da počnemo.', ['Zdravo! ', 'Kako si danas? ', 'Hajde da počnemo.']],
  ];

  it.each(cases)('%s: splits on sentence punctuation', (_lang, text, expected) => {
    expect(splitReplyIntoSentences(text)).toEqual(expected);
  });

  it.each(cases)('%s: segments concatenate to exactly the input', (_lang, text) => {
    expect(splitReplyIntoSentences(text).join('')).toBe(text);
    expect(speakableSegments(text).join('')).toBe(text);
  });

  it('does not split decimals, abbreviations, or a lowercase continuation', () => {
    expect(splitReplyIntoSentences('Dein Wert ist 3.5 Punkte.')).toEqual(['Dein Wert ist 3.5 Punkte.']);
    expect(splitReplyIntoSentences('Das ist z. B. ein Test. Gut.')).toEqual(['Das ist z. B. ein Test. ', 'Gut.']);
    expect(splitReplyIntoSentences('Dr. Müller hat heute Zeit.')).toEqual(['Dr. Müller hat heute Zeit.']);
    expect(splitReplyIntoSentences('Siehe Abschnitt Nummer. danach weiter.')).toEqual(['Siehe Abschnitt Nummer. danach weiter.']);
  });

  it('keeps closing quotes and terminator runs with their sentence', () => {
    expect(splitReplyIntoSentences('Sie sagte: „Super!“ Dann ging sie. Wirklich?!  Ja.')).toEqual([
      'Sie sagte: „Super!“ ',
      'Dann ging sie. ',
      'Wirklich?!  ',
      'Ja.',
    ]);
  });

  it('text with no terminator is a single segment; empty text is none', () => {
    expect(splitReplyIntoSentences('Kein Satzende hier')).toEqual(['Kein Satzende hier']);
    expect(splitReplyIntoSentences('')).toEqual([]);
  });

  it('partition property holds on awkward inputs', () => {
    for (const t of ['...', 'a.b.c', '  Hi.  There!  ', '?!?', '。。。', 'Ende.\n\nNeuer Absatz.', '…und dann? Nichts.']) {
      expect(splitReplyIntoSentences(t).join('')).toBe(t);
      expect(speakableSegments(t).join('')).toBe(t);
    }
  });
});

describe('VTID-04550 speakSegmentsInOrder', () => {
  it('emits each segment before synthesizing the next, in order, with trimmed text', async () => {
    const log: string[] = [];
    const res = await speakSegmentsInOrder(
      ['One. ', 'Two. ', 'Three.'],
      async (t) => {
        log.push(`synth:${t}`);
        return { audioB64: t };
      },
      (a) => log.push(`emit:${a}`),
    );
    expect(res).toEqual({ ok: true, emitted: 3 });
    expect(log).toEqual(['synth:One.', 'emit:One.', 'synth:Two.', 'emit:Two.', 'synth:Three.', 'emit:Three.']);
  });

  it('stops at the first failed segment and reports its index; earlier audio stays emitted', async () => {
    const emitted: string[] = [];
    const synth = jest.fn(async (t: string) => (t === 'Two.' ? null : { audioB64: t }));
    const res = await speakSegmentsInOrder(['One. ', 'Two. ', 'Three.'], synth, (a) => emitted.push(a));
    expect(res).toEqual({ ok: false, emitted: 1, failedIndex: 1 });
    expect(emitted).toEqual(['One.']);
    expect(synth).toHaveBeenCalledTimes(2);
  });

  it('stops without error when the caller says to stop', async () => {
    let go = true;
    const emitted: string[] = [];
    const res = await speakSegmentsInOrder(
      ['One. ', 'Two.'],
      async (t) => {
        go = false;
        return { audioB64: t };
      },
      (a) => emitted.push(a),
      () => go,
    );
    expect(res).toEqual({ ok: false, emitted: 0, stopped: true });
    expect(emitted).toEqual([]);
  });
});
