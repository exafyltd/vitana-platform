/**
 * VTID-05074 — the public privacy, terms and support pages of the Vitanaland
 * Commerce plugin listing. Static English HTML a fetcher can read without
 * running JavaScript; always on; read-only; nothing from the request or the
 * environment reaches the page.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/commerce-plugin-legal').default;

const BASE = '/legal/vitanaland-commerce';

function app() {
  const a = express();
  a.use(express.json());
  a.use(BASE, router);
  return a;
}

const prev = { ...process.env };
afterEach(() => {
  process.env = { ...prev };
});

describe('plugin legal pages', () => {
  it.each([
    ['/privacy', 'Privacy for the Vitanaland plugin', ['nine tools', 'Partner Terms', 'delegated sign-in token']],
    ['/terms', 'Terms for the Vitanaland plugin', ['Partner Terms', 'confirmation']],
    ['/support', 'Support for the Vitanaland plugin', ['https://vitanaland.com/commerce']],
  ])('%s is static English HTML', async (p, heading, phrases) => {
    const res = await request(app()).get(`${BASE}${p}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.text.startsWith('<!doctype html>')).toBe(true);
    expect(res.text).toContain('<html lang="en">');
    expect(res.text).toContain(`<h1>${heading}</h1>`);
    for (const phrase of phrases) expect(res.text).toContain(phrase);
  });

  it('has no script, inline style, event handler or external resource', async () => {
    for (const p of ['/privacy', '/terms', '/support']) {
      const html = (await request(app()).get(`${BASE}${p}`)).text;
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/\sstyle=/i);
      expect(html).not.toMatch(/\son[a-z]+=/i);
      expect(html).not.toMatch(/<(link|img|iframe|style|embed|object|form)\b/i);
      expect(html).not.toMatch(/src=/i);
    }
  });

  it('never states the pages are about the Maxina app', async () => {
    for (const p of ['/privacy', '/terms', '/support']) {
      expect((await request(app()).get(`${BASE}${p}`)).text).not.toMatch(/maxina/i);
    }
  });

  it('is always on: the Commerce MCP switches do not apply', async () => {
    delete process.env.COMMERCE_MCP_ENABLED;
    delete process.env.COMMERCE_MCP_CHATGPT;
    expect((await request(app()).get(`${BASE}/privacy`)).status).toBe(200);
    process.env.COMMERCE_MCP_ENABLED = 'false';
    expect((await request(app()).get(`${BASE}/terms`)).status).toBe(200);
  });

  it('serves the same page whatever the request carries', async () => {
    const plain = (await request(app()).get(`${BASE}/privacy`)).text;
    const noisy = (await request(app()).get(`${BASE}/privacy?x=<script>alert(1)</script>`).set('Accept-Language', 'de').set('X-Forwarded-Host', 'evil.example')).text;
    expect(noisy).toBe(plain);
  });

  it('answers 404 to unknown paths and to anything but GET', async () => {
    expect((await request(app()).get(`${BASE}/unknown`)).status).toBe(404);
    expect((await request(app()).get(`${BASE}/privacy/extra`)).status).toBe(404);
    for (const p of ['/privacy', '/terms', '/support']) {
      expect((await request(app()).post(`${BASE}${p}`).send({})).status).toBe(404);
      expect((await request(app()).delete(`${BASE}${p}`)).status).toBe(404);
    }
  });
});

describe('wiring', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');

  it('is mounted in index.ts under /legal/vitanaland-commerce, next to the Commerce MCP mounts', () => {
    expect(src).toContain("require('./routes/commerce-plugin-legal').default");
    expect(src).toMatch(/mountRouterSync\(app, '\/legal\/vitanaland-commerce', commercePluginLegalRouter, \{ owner: 'commerce-plugin-legal' \}\)/);
  });

  it('leaves the existing Commerce MCP mounts in place', () => {
    expect(src).toMatch(/mountRouterSync\(app, '\/mcp', commerceMcpModule\.default/);
    expect(src).toMatch(/mountRouterSync\(app, '\/\.well-known', commerceMcpModule\.wellKnownRouter/);
  });
});
