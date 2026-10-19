/**
 * VTID-05082 / DEV-COMHU-0205 — Command Hub operator inline SVG rendering.
 *
 * The Operator chat transcript detects SVG inside an assistant reply and
 * renders it as a sanitized <img src="data:image/svg+xml;base64,…">. SVG is
 * untrusted: it is allowlist-sanitized before any data URI is built, and shown
 * only through an <img> (never inline in the live DOM).
 *
 * operator-console.js is a plain browser script with no build step, so —
 * matching this repo's established pattern (see
 * test/command-hub/escape-html.test.ts) — the SVG helper block is sliced out of
 * the source and evaluated directly against a jsdom window that supplies the
 * browser globals the helpers use (DOMParser, XMLSerializer, btoa, document,
 * window, console). The assertions then exercise the real shipped code.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { JSDOM } from 'jsdom';

// VTID-05073 moved renderOperatorChat (and the SVG helper block that lives
// beside it) out of app.js into operator-console.js. The helpers are sliced
// from operator-console.js, which is where they are defined and shipped.
const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/operator-console.js');
const APP_JS = readFileSync(APP_JS_PATH, 'utf8');

interface SvgHelpers {
  extractSvgPayloads: (content: unknown) => string[];
  sanitizeSvgMarkup: (raw: unknown) => string;
  toUtf8Base64Safe: (s: unknown) => string;
  buildSvgDataUrl: (markup: string) => string;
}

/**
 * Slices the self-contained SVG-preview helper block out of app.js and
 * evaluates it in a scope wired to a jsdom window, returning the pure helpers.
 * The block runs from the VTID-05082 marker comment to just before
 * `function renderOperatorChat()`.
 */
function loadSvgHelpers(): SvgHelpers {
  const startMarker = '// === VTID-05082 / DEV-COMHU-0205: Operator chat inline SVG rendering ===';
  const start = APP_JS.indexOf(startMarker);
  if (start === -1) throw new Error('VTID-05082 SVG helper block not found in app.js');
  const end = APP_JS.indexOf('\nfunction renderOperatorChat()', start);
  if (end === -1) throw new Error('renderOperatorChat boundary not found after the SVG block');
  const block = APP_JS.slice(start, end);

  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const w = dom.window as unknown as Record<string, unknown>;

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'window', 'document', 'DOMParser', 'XMLSerializer', 'btoa', 'unescape', 'encodeURIComponent', 'console', 'Blob', 'URL',
    block +
      '\nreturn { extractSvgPayloads: extractSvgPayloads, sanitizeSvgMarkup: sanitizeSvgMarkup, toUtf8Base64Safe: toUtf8Base64Safe, buildSvgDataUrl: buildSvgDataUrl };',
  );

  return factory(
    w,
    (w as any).document,
    (w as any).DOMParser,
    (w as any).XMLSerializer,
    (globalThis as any).btoa,
    (globalThis as any).unescape,
    (globalThis as any).encodeURIComponent,
    console,
    (w as any).Blob,
    (w as any).URL,
  ) as SvgHelpers;
}

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

function parse(markup: string): Document {
  const dom = new JSDOM('<!DOCTYPE html>');
  return new dom.window.DOMParser().parseFromString(markup, 'image/svg+xml');
}

describe('VTID-05082: extractSvgPayloads', () => {
  const { extractSvgPayloads } = loadSvgHelpers();

  it('pulls an SVG out of a ```svg fenced block', () => {
    const content = 'Here is the mockup:\n\n```svg\n<svg ' + SVG_NS + '><rect width="10" height="10"/></svg>\n```\n';
    const got = extractSvgPayloads(content);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain('<svg');
    expect(got[0]).toContain('<rect');
  });

  it('pulls a raw <svg>…</svg> out of prose with no fence', () => {
    const content = 'mockup: <svg ' + SVG_NS + '><circle r="5"/></svg> done';
    const got = extractSvgPayloads(content);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain('<circle');
  });

  it('returns [] when there is no SVG at all', () => {
    expect(extractSvgPayloads('just a normal reply, nothing to see')).toEqual([]);
  });

  it('skips an over-cap (>200KB) payload', () => {
    const huge = '<svg ' + SVG_NS + '>' + '<rect/>'.repeat(40000) + '</svg>';
    expect(huge.length).toBeGreaterThan(204800);
    expect(extractSvgPayloads(huge)).toEqual([]);
  });
});

describe('VTID-05082: sanitizeSvgMarkup (the hostile-SVG security boundary)', () => {
  const { sanitizeSvgMarkup } = loadSvgHelpers();

  it('MANDATORY — a <script> + onload hostile SVG is stripped, geometry survives', () => {
    const hostile =
      '<svg ' + SVG_NS + ' onload="window.__xss=1">' +
      '<script>window.__xss=1</script>' +
      '<rect width="10" height="10" onclick="window.__xss=1"/>' +
      '</svg>';
    const out = sanitizeSvgMarkup(hostile);
    // Non-empty: the drawable <rect> survived.
    expect(out).toContain('<rect');
    // The script element is gone.
    const doc = parse(out);
    expect(doc.getElementsByTagName('script')).toHaveLength(0);
    // No on* handler attribute survived on any element.
    const all = Array.from(doc.getElementsByTagName('*'));
    for (const el of all) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
      }
    }
  });

  it('removes <foreignObject> entirely (AC-5)', () => {
    const svg = '<svg ' + SVG_NS + '><foreignObject><div>hi</div></foreignObject><rect/></svg>';
    const out = sanitizeSvgMarkup(svg);
    expect(parse(out).getElementsByTagName('foreignObject')).toHaveLength(0);
    expect(out).toContain('<rect');
  });

  it('removes <image> and remote references, keeps local #fragment refs (AC-6)', () => {
    const svg =
      '<svg ' + SVG_NS + ' xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<image href="http://evil.example/x.png"/>' +
      '<linearGradient id="g"><stop offset="0"/></linearGradient>' +
      '<use xlink:href="#sym"/>' +
      '<rect fill="url(#g)"/>' +
      '<rect fill="url(http://evil.example/y)"/>' +
      '</svg>';
    const out = sanitizeSvgMarkup(svg);
    const doc = parse(out);
    expect(doc.getElementsByTagName('image')).toHaveLength(0);
    // Local gradient reference kept.
    expect(out).toContain('url(#g)');
    // Local use fragment kept.
    expect(out).toMatch(/#sym/);
    // Foreign url() dropped.
    expect(out).not.toContain('evil.example');
  });

  it('rejects a DOCTYPE / ENTITY payload (billion-laughs shape) → empty', () => {
    const bomb =
      '<?xml version="1.0"?>' +
      '<!DOCTYPE svg [<!ENTITY lol "lol">]>' +
      '<svg ' + SVG_NS + '><rect/></svg>';
    expect(sanitizeSvgMarkup(bomb)).toBe('');
  });

  it('returns "" for a fully-hostile payload with no drawable child', () => {
    const svg = '<svg ' + SVG_NS + '><script>1</script></svg>';
    expect(sanitizeSvgMarkup(svg)).toBe('');
  });

  it('returns "" for malformed XML', () => {
    expect(sanitizeSvgMarkup('<svg ' + SVG_NS + '><rect>')).toBe('');
  });
});

describe('VTID-05082: buildSvgDataUrl (base64, UTF-8 safe round-trip)', () => {
  const { sanitizeSvgMarkup, buildSvgDataUrl } = loadSvgHelpers();

  it('produces a data:image/svg+xml;base64, URL', () => {
    const sanitized = sanitizeSvgMarkup('<svg ' + SVG_NS + '><rect width="10" height="10"/></svg>');
    const url = buildSvgDataUrl(sanitized);
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });

  it('round-trips non-ASCII (emoji + €) through base64 (AC-16)', () => {
    const sanitized = sanitizeSvgMarkup(
      '<svg ' + SVG_NS + '><text>Share your longevity 🎉 €240</text></svg>',
    );
    const url = buildSvgDataUrl(sanitized);
    const b64 = url.slice('data:image/svg+xml;base64,'.length);
    const decoded = decodeURIComponent(escape(Buffer.from(b64, 'base64').toString('binary')));
    const doc = parse(decoded);
    expect(doc.documentElement.nodeName.toLowerCase()).toBe('svg');
    expect(decoded).toContain('🎉');
    expect(decoded).toContain('€');
  });
});
