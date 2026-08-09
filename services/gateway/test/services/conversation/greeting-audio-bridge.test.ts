/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: greeting audio bridge — pure text builder.
 */

import {
  buildGreetingBridgeText,
  resolveGreetingBridgeTimeOfDay,
  pickGreetingBridgeLineKey,
} from '../../../src/services/conversation/greeting-audio-bridge';

describe('resolveGreetingBridgeTimeOfDay', () => {
  it('buckets local hours into morning/afternoon/evening', () => {
    expect(resolveGreetingBridgeTimeOfDay(0)).toBe('morning');
    expect(resolveGreetingBridgeTimeOfDay(11)).toBe('morning');
    expect(resolveGreetingBridgeTimeOfDay(12)).toBe('afternoon');
    expect(resolveGreetingBridgeTimeOfDay(17)).toBe('afternoon');
    expect(resolveGreetingBridgeTimeOfDay(18)).toBe('evening');
    expect(resolveGreetingBridgeTimeOfDay(23)).toBe('evening');
  });
});

describe('pickGreetingBridgeLineKey', () => {
  it('rotates deterministically through the 5-line pool', () => {
    expect(pickGreetingBridgeLineKey(0)).toBe('orb.greeting_bridge.line_1');
    expect(pickGreetingBridgeLineKey(1)).toBe('orb.greeting_bridge.line_2');
    expect(pickGreetingBridgeLineKey(4)).toBe('orb.greeting_bridge.line_5');
    expect(pickGreetingBridgeLineKey(5)).toBe('orb.greeting_bridge.line_1'); // wraps
  });

  it('same day-of-year always yields the same line (deterministic, not random)', () => {
    expect(pickGreetingBridgeLineKey(200)).toBe(pickGreetingBridgeLineKey(200));
  });
});

describe('buildGreetingBridgeText', () => {
  it('builds an English morning greeting with date + motivational line + transition', () => {
    const text = buildGreetingBridgeText({
      lang: 'en',
      now: new Date('2026-07-26T08:00:00Z'),
      timezone: 'UTC',
    });
    expect(text).toContain('Good morning!');
    expect(text).toContain('July 26');
    expect(text).toContain('Let me pull up your latest data');
  });

  it('builds a German evening greeting in German', () => {
    const text = buildGreetingBridgeText({
      lang: 'de',
      now: new Date('2026-07-26T20:00:00Z'),
      timezone: 'UTC',
    });
    expect(text).toContain('Guten Abend!');
    expect(text).toContain('26. Juli');
    expect(text).toContain('Lass mich kurz deine aktuellen Daten anschauen');
  });

  it('picks afternoon for a midday local hour', () => {
    const text = buildGreetingBridgeText({
      lang: 'en',
      now: new Date('2026-07-26T14:00:00Z'),
      timezone: 'UTC',
    });
    expect(text).toContain('Good afternoon!');
  });

  it('respects timezone offset for the local-hour bucket (not raw UTC hour)', () => {
    // 22:00 UTC is 07:00 in a UTC+9 zone (Asia/Tokyo) — should read as morning there.
    const text = buildGreetingBridgeText({
      lang: 'en',
      now: new Date('2026-07-25T22:00:00Z'),
      timezone: 'Asia/Tokyo',
    });
    expect(text).toContain('Good morning!');
  });

  it('falls back to German (the i18n catalog default) for an unsupported/garbage language code — never mixes languages within one phrase', () => {
    const text = buildGreetingBridgeText({
      lang: 'xx-not-a-real-lang',
      now: new Date('2026-07-26T08:00:00Z'),
      timezone: 'UTC',
    });
    expect(text).toContain('Guten Morgen!');
    expect(text).toContain('26. Juli'); // date must match the same fallback language
  });

  // VTID-03559. This test previously asserted the OPPOSITE — that 'fr' falls
  // back to German — and its name gave the reason: "the i18n catalog has no
  // French entries". VTID-03509 added them, so the premise is gone and the
  // old assertion had become a pin holding the bug in place: an fr session
  // heard the whole bridge in German, spoken by a French voice.
  it.each(['fr', 'pt', 'ru', 'pl'] as const)(
    'renders %s in its own language now that the catalog has it — not German',
    (lang) => {
      const text = buildGreetingBridgeText({
        lang,
        now: new Date('2026-07-26T08:00:00Z'),
        timezone: 'UTC',
      });
      expect(text).not.toContain('Guten Morgen!');
      // The date must be in the SAME language as the sentence — the whole
      // point of normalizing at all is to never glue two languages together.
      expect(text).not.toContain('26. Juli');
    },
  );

  it('still falls back to German for a locale the catalog genuinely lacks', () => {
    const text = buildGreetingBridgeText({
      lang: 'zh' as never,
      now: new Date('2026-07-26T08:00:00Z'),
      timezone: 'UTC',
    });
    expect(text).toContain('Guten Morgen!');
    expect(text).toContain('26. Juli');
  });

  it('defaults to UTC when no timezone is provided', () => {
    const text = buildGreetingBridgeText({ lang: 'en', now: new Date('2026-07-26T08:00:00Z') });
    expect(text).toContain('Good morning!');
  });
});
