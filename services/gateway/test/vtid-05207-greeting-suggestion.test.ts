/**
 * VTID-05207 — "Say Hello 👋" greeting SUGGESTION
 * (services/new-member-greeting-suggestion.ts + routes/new-member-greeting.ts),
 * plan Part B, task C1.
 *
 *   - composes in the SENDER's locale via the Bedrock composer pattern;
 *   - validation rejects links, markdown, over-length and a repeat of an
 *     already-offered suggestion (so "Try another" varies);
 *   - the route is authenticated, per-viewer rate limited, returns
 *     { suggestion, language }, and NEVER sends a DM (suggest only).
 */
import {
  composeGreetingSuggestion,
  validateGreetingSuggestion,
  buildGreetingSuggestionPrompt,
  GREETING_SUGGESTION_MAX_CHARS,
} from '../src/services/new-member-greeting-suggestion';
import { allowViewerHit } from '../src/routes/new-member-greeting';

describe('validateGreetingSuggestion', () => {
  it('accepts a short warm greeting', () => {
    expect(validateGreetingSuggestion('Hi Anna, lovely to have you here! 👋', 'en')).toEqual({ ok: true, text: 'Hi Anna, lovely to have you here! 👋' });
  });
  it('rejects empty', () => {
    expect(validateGreetingSuggestion('   ', 'en')).toEqual({ ok: false, error: 'empty' });
  });
  it('rejects over-length', () => {
    const long = 'x'.repeat(GREETING_SUGGESTION_MAX_CHARS + 1);
    expect(validateGreetingSuggestion(long, 'en')).toEqual({ ok: false, error: 'too_long' });
  });
  it('rejects a link', () => {
    expect(validateGreetingSuggestion('Welcome! see https://x.co', 'en')).toEqual({ ok: false, error: 'contains_link' });
  });
  it('rejects markdown', () => {
    expect(validateGreetingSuggestion('- Welcome Anna', 'en')).toEqual({ ok: false, error: 'contains_markdown' });
  });
  it('rejects an @mention or #hashtag', () => {
    expect(validateGreetingSuggestion('Welcome @anna', 'en')).toEqual({ ok: false, error: 'contains_tag' });
    expect(validateGreetingSuggestion('Welcome #maxina', 'en')).toEqual({ ok: false, error: 'contains_tag' });
  });
  it('rejects a greeting on the avoid list (case/punct-insensitive)', () => {
    expect(validateGreetingSuggestion('Welcome to MAXINA, Anna!', 'en', ['welcome to maxina, anna'])).toEqual({ ok: false, error: 'repeated' });
  });
  it('rejects wrong script for the locale', () => {
    expect(validateGreetingSuggestion('Hello Anna!', 'ru')).toEqual({ ok: false, error: 'wrong_script' });
  });
  it('accepts correct script', () => {
    expect(validateGreetingSuggestion('Привет, Анна!', 'ru').ok).toBe(true);
  });
});

describe('buildGreetingSuggestionPrompt', () => {
  it('names the newcomer and lists the avoid set', () => {
    const p = buildGreetingSuggestionPrompt({ firstName: 'Anna', senderLocale: 'de', avoid: ['Hi Anna!'] });
    expect(p).toContain('Anna');
    expect(p).toContain('Hi Anna!');
    expect(p.toLowerCase()).toContain('do not repeat');
  });
  it('handles an unknown name', () => {
    const p = buildGreetingSuggestionPrompt({ firstName: '', senderLocale: 'en' });
    expect(p.toLowerCase()).toContain('unknown');
  });
});

describe('composeGreetingSuggestion', () => {
  const fakeRouter = (text: string): any =>
    jest.fn().mockResolvedValue({ ok: true, text, provider: 'bedrock', model: 'eu.anthropic.claude-sonnet-4-6' });

  it('returns { suggestion, language } in the sender locale', async () => {
    const r = await composeGreetingSuggestion({ firstName: 'Anna', senderLocale: 'de', avoid: [] }, fakeRouter('Hey Anna, schön dass du da bist! 👋'));
    expect(r).toEqual(expect.objectContaining({ ok: true, suggestion: 'Hey Anna, schön dass du da bist! 👋', language: 'de' }));
  });

  it('passes the SENDER locale into the system prompt (du-form for de)', async () => {
    const call = fakeRouter('Hi Anna!');
    await composeGreetingSuggestion({ firstName: 'Anna', senderLocale: 'de' }, call);
    const opts = call.mock.calls[0][2];
    expect(opts.systemPrompt).toContain('German');
    expect(opts.providerOverride).toBe('bedrock');
    expect(opts.fallbackOverride.provider).toBe('bedrock');
  });

  it('defaults language to en for an unsupported sender locale', async () => {
    const r = await composeGreetingSuggestion({ firstName: 'Anna', senderLocale: 'xx' }, fakeRouter('Hi Anna!'));
    expect(r).toEqual(expect.objectContaining({ ok: true, language: 'en' }));
  });

  it('fails when a non-Bedrock provider answers (defence in depth)', async () => {
    const call = jest.fn().mockResolvedValue({ ok: true, text: 'Hi', provider: 'vertex', model: 'g' });
    const r = await composeGreetingSuggestion({ firstName: 'Anna', senderLocale: 'en' }, call as any);
    expect(r.ok).toBe(false);
  });

  it('fails when the suggestion is unusable (contains a link)', async () => {
    const r = await composeGreetingSuggestion({ firstName: 'Anna', senderLocale: 'en' }, fakeRouter('Welcome https://x.co'));
    expect(r).toEqual({ ok: false, error: 'contains_link' });
  });

  it('rejects a suggestion that repeats one on the avoid list', async () => {
    const r = await composeGreetingSuggestion({ firstName: 'Anna', senderLocale: 'en', avoid: ['Hi Anna!'] }, fakeRouter('Hi Anna!'));
    expect(r).toEqual({ ok: false, error: 'repeated' });
  });
});

describe('allowViewerHit (per-viewer rate limit)', () => {
  it('allows up to the cap then refuses within the window', () => {
    const store = new Map<string, number[]>();
    const t = 1_000_000;
    expect(allowViewerHit('v', t, 1000, 2, store)).toBe(true);
    expect(allowViewerHit('v', t, 1000, 2, store)).toBe(true);
    expect(allowViewerHit('v', t, 1000, 2, store)).toBe(false);
  });
  it('refills after the window', () => {
    const store = new Map<string, number[]>();
    expect(allowViewerHit('v', 0, 1000, 1, store)).toBe(true);
    expect(allowViewerHit('v', 500, 1000, 1, store)).toBe(false);
    expect(allowViewerHit('v', 1500, 1000, 1, store)).toBe(true);
  });
});
