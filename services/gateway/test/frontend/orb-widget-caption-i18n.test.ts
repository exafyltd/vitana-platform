import * as fs from 'fs';
import * as path from 'path';

// BOOTSTRAP-ORB-CAPTION-I18N — the visible .vtorb-status caption under the
// orb (e.g. "Vitana speaking...", "Listening...") only ever localized to
// German or English: every call site branched on
// `_cfg.lang.startsWith('de') ? de : en`, so any other selected language
// (es/sr/fr/pt/ru/pl/zh/ar) silently showed English captions even though
// the actual spoken voice already correctly speaks the user's real
// selected language. There is no live transcript in this widget — that
// feature was deliberately removed — so the caption is always one of a
// small set of fixed status phrases, not spoken text.
//
// Fix: a centralized _CAPTIONS dictionary + _resolveCaptionLocale()/_loc()/
// _caption() resolver mirroring the gateway's own canonical locale set
// (services/gateway/src/i18n/catalog.ts GATEWAY_LOCALES: de, en, es, sr,
// fr, pt, ru, pl, zh, ar). _pickLang() (de/en-only) is kept, but scoped to
// exactly one remaining use: selecting the pre-rendered disconnect-alert
// MP3 clip id (_ALERT_CLIPS only has -en/-de files) — widening it would
// silently request a nonexistent MP3 for 8 of 10 locales.
//
// Static source checks (same approach as the sibling orb-widget suites):
// the widget is a plain browser IIFE with no export surface, so the
// invariants are asserted against the source text.

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);

const CAPTION_LOCALES = ['en', 'de', 'es', 'sr', 'fr', 'pt', 'ru', 'pl', 'zh', 'ar'];

function extractFunctionBody(source: string, signature: string): string {
  const sigIdx = source.indexOf(signature);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', sigIdx);
  expect(openIdx).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed function body: ${signature}`);
}

// Pulls out the top-level object literal assigned to `var <name> = { ... };`
// by brace-depth counting (mirrors extractFunctionBody's approach).
function extractObjectLiteral(source: string, varDecl: string): string {
  const declIdx = source.indexOf(varDecl);
  expect(declIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', declIdx);
  expect(openIdx).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(openIdx, i + 1);
  }
  throw new Error(`unclosed object literal: ${varDecl}`);
}

describe('orb-widget caption i18n (BOOTSTRAP-ORB-CAPTION-I18N)', () => {
  const source = fs.readFileSync(WIDGET_PATH, 'utf8');

  it('_CAPTIONS defines all 10 supported locales for every key', () => {
    const literal = extractObjectLiteral(source, 'var _CAPTIONS = {');
    const keys = [
      'speaking', 'listening', 'connecting', 'reconnecting', 'muted',
      'tapToHear', 'idleNudge', 'connectFailedRetrying', 'offline',
      'sessionEndedBackground', 'tapToReconnect', 'textModeActive', 'registerFree',
    ];
    for (const key of keys) {
      const entryIdx = literal.indexOf(`${key}: {`);
      expect(entryIdx).toBeGreaterThanOrEqual(0);
      const entryEnd = literal.indexOf('},', entryIdx);
      const entry = literal.slice(entryIdx, entryEnd >= 0 ? entryEnd : undefined);
      for (const lc of CAPTION_LOCALES) {
        // Quote-agnostic: a value containing an apostrophe (e.g. fr "J'écoute…")
        // is double-quoted in the source, so this must accept either.
        expect(entry).toMatch(new RegExp(`\\b${lc}:\\s*['"]`));
      }
    }
  });

  it('_DISCONNECT_LABELS and _RECOVERY_LABELS define all 10 locales for every reason', () => {
    for (const varName of ['_DISCONNECT_LABELS', '_RECOVERY_LABELS']) {
      const literal = extractObjectLiteral(source, `var ${varName} = {`);
      for (const reason of ['mic', 'network', 'connection', 'offline']) {
        const entryIdx = literal.indexOf(`${reason}: {`);
        expect(entryIdx).toBeGreaterThanOrEqual(0);
        const entryEnd = literal.indexOf('}', entryIdx + reason.length + 3);
        const entry = literal.slice(entryIdx, entryEnd + 1);
        for (const lc of CAPTION_LOCALES) {
          expect(entry).toMatch(new RegExp(`\\b${lc}:\\s*['"]`));
        }
      }
    }
  });

  it('_THINKING_QUICK/_PRIMARY/_ALTERNATES entries all carry the full 10-key shape', () => {
    // Quote-agnostic per field: a value with an apostrophe (French phrases
    // like "D'accord, attends…") is double-quoted, so a single-quote-only
    // pattern under-counts.
    const Q = `(?:'[^']*'|"[^"]*")`;
    const entryPattern = new RegExp(
      `\\{ en: ${Q}, de: ${Q}, es: ${Q}, sr: ${Q}, fr: ${Q}, pt: ${Q}, ru: ${Q}, pl: ${Q}, zh: ${Q}, ar: ${Q} \\}`,
      'g',
    );
    const pairs = source.match(entryPattern) || [];
    // quick(6) + primary(7) + alternates(8) = 21 entries — same total the
    // sibling orb-widget-thinking-messages.test.ts pins.
    expect(pairs.length).toBe(21);
  });

  it('no _setStatus call site still branches directly on de/en for caption text', () => {
    // Sweeps every one of the ~21 previously-hardcoded call sites in one
    // assertion. Two deliberate exceptions remain in the source and are NOT
    // caught by this pattern: _currentPlaybackRate() (line ~44, TTS speed,
    // not a caption) and _activateFallbackMode()'s _transcriptHistory push
    // (not rendered to .vtorb-status — the widget has no live transcript UI).
    expect(source).not.toMatch(/_setStatus\(_cfg\.lang\.startsWith\('de'\)/);
    expect(source).not.toMatch(/_setStatus\(de \?/);
    expect(source).not.toMatch(/_setStatus\(\s*\n?\s*_cfg\.lang\.startsWith\('de'\)/);
    expect(source).not.toMatch(/_setStatus\(lang === 'de' \?/);
    expect(source).not.toMatch(/_setStatus\(isDe \?/);
  });

  it('_pickLang() is scoped to exactly one caller — the disconnect-alert MP3 clip id', () => {
    // Counts only real code, not the explanatory comments above/around the
    // declaration that mention "_pickLang()" by name (a plain substring
    // count would over-count those).
    const codeOnly = source
      .split('\n')
      .filter((l: string) => !l.trim().startsWith('//'))
      .join('\n');
    const occurrences = (codeOnly.match(/\b_pickLang\(\)/g) || []).length;
    // 1 for `function _pickLang() { ... }`, 1 for the `clipLang = _pickLang()`
    // call inside _announceDisconnect. Guards against a future edit silently
    // widening this back into a caption-text lookup, which would break the
    // MP3 clip lookup for 8 of 10 locales (_ALERT_CLIPS only has -en/-de).
    expect(occurrences).toBe(2);

    const body = extractFunctionBody(source, 'function _announceDisconnect(');
    expect(body).toMatch(/var captionLang = _resolveCaptionLocale\(\);/);
    expect(body).toMatch(/var clipLang = _pickLang\(\);/);
    expect(body).toMatch(/_playAlert\('disconnect-' \+ reason \+ '-' \+ clipLang\)/);
  });

  it('a sample of non-English translations are real translations, not copies of the English text', () => {
    const literal = extractObjectLiteral(source, 'var _CAPTIONS = {');
    const samples = [
      { key: 'listening', locales: ['es', 'fr', 'ar', 'zh'] },
      { key: 'speaking', locales: ['es', 'de', 'ru'] },
      { key: 'connecting', locales: ['pt', 'pl', 'sr'] },
    ];
    for (const { key, locales } of samples) {
      const entryIdx = literal.indexOf(`${key}: {`);
      const entryEnd = literal.indexOf('},', entryIdx);
      const entry = literal.slice(entryIdx, entryEnd >= 0 ? entryEnd : undefined);
      // Quote-agnostic: capture from whichever quote style the field uses.
      const enMatch = entry.match(/en:\s*(?:'([^']*)'|"([^"]*)")/);
      expect(enMatch).not.toBeNull();
      const en = enMatch![1] ?? enMatch![2];
      for (const lc of locales) {
        const m = entry.match(new RegExp(`${lc}:\\s*(?:'([^']*)'|"([^"]*)")`));
        expect(m).not.toBeNull();
        const val = m![1] ?? m![2];
        expect(val).not.toBe(en);
      }
    }
  });

  it('.vtorb-status font-size and min-height are 19px/26px in both the inline style and the injected stylesheet', () => {
    // Inline style, set once at element creation in _renderOverlay().
    expect(source).toMatch(/status\.style\.cssText = '[^']*font-size:19px[^']*min-height:26px[^']*'/);
    // Injected <style> tag rule — built as an array of string literals
    // joined with '\n', so font-size and min-height live on separate lines
    // (separate quoted strings), not inside one string like the inline style.
    expect(source).toMatch(/'\s*font-size: 19px; color: rgba\(255,255,255,0\.6\); text-align: center;',/);
    expect(source).toMatch(/'\s*min-height: 26px; transition: opacity 0\.3s;',/);
    // No stray 14px/20px (original) or 17px/24px (first bump) left behind.
    expect(source).not.toMatch(/font-size:14px/);
    expect(source).not.toMatch(/font-size: 14px;/);
    expect(source).not.toMatch(/font-size:17px/);
    expect(source).not.toMatch(/font-size: 17px;/);
    expect(source).not.toMatch(/min-height:24px/);
    expect(source).not.toMatch(/min-height: 24px;/);
  });
});
