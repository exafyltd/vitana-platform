/**
 * VTID-04067: the dead BOOTSTRAP-CLOUDFLARE-CMDHUB-REDIRECT <head> script is
 * gone from the Command Hub's index.html.
 *
 * That synchronous <head> script hopped any visitor whose
 * `location.hostname` was the GCP Cloud Run host
 * `gateway-q74ibpv6ia-uc.a.run.app` over to `gateway.vitanaland.com`.
 * The GCP project was decommissioned and the Cloud Run gateway service was
 * deleted (VTID-03599/VTID-03649), so that Cloud Run hostname resolves to
 * nothing and no visitor can ever land on it again — the check (and the
 * redirect it guarded) is dead code that can never fire.
 *
 * A warning for reviewers, not part of this PR's scope: the same hostname is
 * still referenced elsewhere under services/gateway/src (a few
 * `process.env.GATEWAY_URL || '...'` fallbacks, the CORS allowlist, the ORB
 * widget's hardcoded fallback). Those are a separate follow-up — this task
 * only removes the index.html redirect.
 *
 * index.html is a static asset with no build step and no render harness, so
 * this is a source-text regression guard, matching this repo's established
 * pattern for the Command Hub's static files (see
 * test/command-hub/dead-code-workflows-removed.test.ts).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const INDEX_HTML_PATH = join(__dirname, '../../src/frontend/command-hub/index.html');

/** The permanently dead GCP Cloud Run host the removed redirect keyed on. */
const DEAD_CLOUD_RUN_HOST = 'gateway-q74ibpv6ia-uc.a.run.app';

/** Elements that never need a closing tag (and are valid without `/>`). */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Minimal well-formedness check: strip comments/doctype, then walk the tags
 * with a stack and require every non-void, non-self-closed element to close.
 * Deliberately tiny — it only needs to catch a mis-deleted tag, which is the
 * one realistic way this HTML-only edit could break the document.
 */
function unbalancedTags(html: string): string[] {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  const problems: string[] = [];
  const stack: string[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(stripped)) !== null) {
    const [, closing, rawName, , selfClosing] = match;
    const name = rawName.toLowerCase();

    if (closing === '/') {
      const open = stack.pop();
      if (open !== name) {
        problems.push(`</${name}> closes <${open ?? 'nothing'}>`);
      }
      continue;
    }

    if (selfClosing === '/' || VOID_ELEMENTS.has(name)) continue;
    stack.push(name);
  }

  for (const unclosed of stack) {
    problems.push(`<${unclosed}> is never closed`);
  }

  return problems;
}

describe('Command Hub — dead Cloudflare/Cloud Run redirect script removed (VTID-04067)', () => {
  let html: string;

  beforeAll(() => {
    html = readFileSync(INDEX_HTML_PATH, 'utf8');
  });

  it('no longer mentions the dead Cloud Run hostname anywhere in index.html', () => {
    expect(html).not.toContain(DEAD_CLOUD_RUN_HOST);
  });

  it('no longer carries the redirect block or its marker comment', () => {
    expect(html).not.toContain('BOOTSTRAP-CLOUDFLARE-CMDHUB-REDIRECT');
    expect(html).not.toMatch(/location\.replace\(\s*'https:\/\/gateway\.vitanaland\.com'/);
    expect(html).not.toContain('location.hostname');
  });

  it('no longer contains any <head> script at all', () => {
    const head = (html.match(/<head>([\s\S]*?)<\/head>/) || [])[1] || '';
    expect(head).toBeTruthy();
    expect(head).not.toContain('<script');
  });

  it('still parses as well-formed HTML', () => {
    expect(html.trimStart().startsWith('<!DOCTYPE html>')).toBe(true);
    expect(unbalancedTags(html)).toEqual([]);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('kept the <title>', () => {
    expect(html).toContain('<title>Vitana Command Hub</title>');
  });

  it('kept both meta tags', () => {
    expect(html).toContain('<meta charset="UTF-8" />');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0" />');
  });

  it('kept the stylesheet link', () => {
    expect(html).toMatch(/<link rel="stylesheet" href="\/command-hub\/styles\.css\?v=[^"]+" \/>/);
  });

  it('kept every other body script tag', () => {
    for (const src of [
      '/command-hub/orb-widget.js',
      '/command-hub/app.js',
      '/command-hub/intelligence-panels.js',
      '/command-hub/command-hub-staging.js',
    ]) {
      expect(html).toContain(`<script src="${src}?v=`);
    }
  });

  it('bumped the cache-bust on styles.css and app.js together (at or after VTID-04067)', () => {
    const stylesVersion = (html.match(/styles\.css\?v=([^"]+)"/) || [])[1] || '';
    const appVersion = (html.match(/app\.js\?v=([^"]+)"/) || [])[1] || '';
    expect(appVersion).toBe(stylesVersion);
    // Past the previous marker, so the browser cannot serve a stale copy. Asserted
    // "at or after" rather than pinned to this exact literal — a later sibling PR
    // (e.g. VTID-04074) legitimately re-bumps this marker further, and pinning an
    // exact string here would break every such PR (the VTID-04028/04031 pattern).
    expect(appVersion > '20260918-vtid-04061-dead-code-removed').toBe(true);
  });
});
