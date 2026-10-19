/**
 * VTID-05082 / DEV-COMHU-0205 — Command Hub operator inline SVG rendering.
 *
 * The Operator chat transcript detects SVG inside an assistant reply and
 * renders it as a sanitized <img src="data:image/svg+xml;base64,…">. SVG is
 * untrusted: it is allowlist-sanitized before any data URI is built, and shown
 * only through an <img> (never inline in the live DOM).
 *
 * The helpers live in operator-svg-render.js, a plain browser IIFE module that
 * publishes window.OperatorSvgRender (no build step). Matching this repo's
 * pattern for Command Hub scripts, the shipped file is read from source and
 * evaluated against a jsdom window that supplies the browser globals it uses
 * (DOMParser, XMLSerializer, btoa, document, window, console). The assertions
 * then exercise the real shipped code.
 *
 * Decision B (VTID-05073 freeze): renderOperatorChat in operator-console.js is
 * never edited. app.js's _renderAppCore calls enhanceOperatorChat on the built
 * DOM, which post-processes the transcript; that hook is covered below too.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { JSDOM } from 'jsdom';

const COMMAND_HUB_DIR = join(__dirname, '../../src/frontend/command-hub');
const MODULE_PATH = join(COMMAND_HUB_DIR, 'operator-svg-render.js');
const MODULE_JS = readFileSync(MODULE_PATH, 'utf8');
const APP_JS = readFileSync(join(COMMAND_HUB_DIR, 'app.js'), 'utf8');
const OPERATOR_CONSOLE_JS = readFileSync(join(COMMAND_HUB_DIR, 'operator-console.js'), 'utf8');

interface SvgHelpers {
  extractSvgPayloads: (content: unknown) => string[];
  sanitizeSvgMarkup: (raw: unknown) => string;
  toUtf8Base64Safe: (s: unknown) => string;
  buildSvgDataUrl: (markup: string) => string;
  enhanceOperatorChat: (root: unknown, chatMessages: unknown) => number;
  document: Document;
}

/**
 * Evaluates operator-svg-render.js in a scope wired to a fresh jsdom window and
 * returns what it published on window.OperatorSvgRender (plus that document).
 */
function loadSvgHelpers(): SvgHelpers {
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const w = dom.window as unknown as Record<string, any>;
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'window', 'document', 'DOMParser', 'XMLSerializer', 'btoa', 'unescape', 'encodeURIComponent', 'console', 'Blob', 'URL',
    MODULE_JS + '\nreturn window.OperatorSvgRender;',
  );
  const api = factory(
    w,
    w.document,
    w.DOMParser,
    w.XMLSerializer,
    (globalThis as any).btoa,
    (globalThis as any).unescape,
    (globalThis as any).encodeURIComponent,
    console,
    w.Blob,
    w.URL,
  );
  return { ...api, document: w.document } as SvgHelpers;
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

describe('VTID-05082: enhanceOperatorChat (post-render hook, decision B)', () => {
  const SVG_REPLY = 'mockup:\n```svg\n<svg ' + SVG_NS + '><rect width="10" height="10"/></svg>\n```';

  /** Builds a transcript shaped like renderOperatorChat's output for `msgs`. */
  function transcript(doc: Document, msgs: { type: string }[]): { root: HTMLElement; messages: HTMLElement } {
    const root = doc.createElement('div');
    const container = doc.createElement('div');
    container.className = 'chat-container';
    const messages = doc.createElement('div');
    messages.className = 'chat-messages';
    for (const m of msgs) {
      const sent = m.type === 'user' || m.type === 'sent';
      const bubble = doc.createElement('div');
      bubble.className = 'message-bubble ' + (sent ? 'message-sent' : 'message-reply');
      messages.appendChild(bubble);
      const meta = doc.createElement('div');
      meta.className = 'message-meta';
      messages.appendChild(meta);
    }
    container.appendChild(messages);
    root.appendChild(container);
    return { root, messages };
  }

  it('inserts a sanitized <img> preview right after the reply bubble', () => {
    const h = loadSvgHelpers();
    const msgs = [{ type: 'user', content: 'draw it' }, { type: 'reply', content: SVG_REPLY }];
    const { root, messages } = transcript(h.document, msgs);
    expect(h.enhanceOperatorChat(root, msgs)).toBe(1);
    const replyBubble = messages.querySelectorAll('.message-bubble')[1];
    const preview = replyBubble.nextElementSibling as HTMLElement;
    expect(preview.className).toBe('chat-svg-preview');
    const img = preview.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')!.startsWith('data:image/svg+xml;base64,')).toBe(true);
    // Never inline SVG markup in the live DOM, never an inline style attribute.
    expect(preview.querySelector('svg rect')).toBeNull();
    expect(preview.querySelector('[style]')).toBeNull();
  });

  it('never scans a user-authored (sent) message', () => {
    const h = loadSvgHelpers();
    const msgs = [{ type: 'user', content: SVG_REPLY }];
    const { root, messages } = transcript(h.document, msgs);
    expect(h.enhanceOperatorChat(root, msgs)).toBe(0);
    expect(messages.querySelector('.chat-svg-preview')).toBeNull();
  });

  it('fails closed when the bubbles do not line up with the messages', () => {
    const h = loadSvgHelpers();
    const msgs = [{ type: 'user', content: 'x' }, { type: 'reply', content: SVG_REPLY }];
    const { root, messages } = transcript(h.document, [{ type: 'reply' }, { type: 'user' }]);
    expect(h.enhanceOperatorChat(root, msgs)).toBe(0);
    expect(messages.querySelector('.chat-svg-preview')).toBeNull();
  });

  it('is idempotent across repeated passes over the same DOM', () => {
    const h = loadSvgHelpers();
    const msgs = [{ type: 'reply', content: SVG_REPLY }];
    const { root, messages } = transcript(h.document, msgs);
    h.enhanceOperatorChat(root, msgs);
    h.enhanceOperatorChat(root, msgs);
    expect(messages.querySelectorAll('.chat-svg-preview')).toHaveLength(1);
  });

  it('is wired from app.js _renderAppCore and leaves operator-console.js untouched', () => {
    expect(APP_JS).toContain('window.OperatorSvgRender.enhanceOperatorChat(root, state.chatMessages)');
    expect(OPERATOR_CONSOLE_JS).not.toContain('OperatorSvgRender');
    expect(OPERATOR_CONSOLE_JS).not.toContain('extractSvgPayloads');
  });
});
