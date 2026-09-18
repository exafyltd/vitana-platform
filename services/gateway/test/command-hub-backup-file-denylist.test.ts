/**
 * Tests for src/middleware/command-hub-backup-denylist.ts (VTID-04056).
 *
 * Contract under test:
 *   - `isDeniedCommandHubStaticPath()` denies any `.backup*` path (covers
 *     `.backup`, `.backup2` and `.backup-<timestamp>`), the exact path
 *     `/debug.html`, and percent-encoded variants of both.
 *   - `denyCommandHubBackupFiles` answers 404 with the standard
 *     `{ ok:false, error:'NOT_FOUND' }` envelope and NEVER calls `next()`
 *     for those paths.
 *   - Live assets (`app.js`, `index.html`, nested paths, query strings) call
 *     `next()` once and are never 404ed, so the following `express.static`
 *     mount keeps serving the Command Hub normally.
 *   - Mounted before the real `express.static` root, the stale files are
 *     unreachable while live assets still serve (the regression the VTID
 *     fixes: the static mount sits before the auth-gated router).
 */

import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';

import {
  denyCommandHubBackupFiles,
  isDeniedCommandHubStaticPath,
  COMMAND_HUB_DENIED_STATIC_EXACT_PATHS,
} from '../src/middleware/command-hub-backup-denylist';

/** Paths that must be denied: the real leftovers present in the repo. */
const DENIED_PATHS = [
  '/app.js.backup',
  '/app.js.backup2',
  '/index.html.backup',
  '/index.html.backup-20251108-223919',
  '/debug.html',
];

/** Paths which must keep working (referenced by the live page). */
const ALLOWED_PATHS = ['/app.js', '/index.html'];

// ---------------------------------------------------------------------------
// Direct unit tests of the predicate + middleware
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number | null;
  body: unknown;
  res: express.Response;
}

function makeRes(): FakeResponse {
  const state: FakeResponse = {
    statusCode: null,
    body: undefined,
    res: {} as express.Response,
  };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      state.body = payload;
      return res;
    },
  };
  state.res = res as unknown as express.Response;
  return state;
}

describe('isDeniedCommandHubStaticPath', () => {
  it.each(DENIED_PATHS)('denies %s', (requestPath) => {
    expect(isDeniedCommandHubStaticPath(requestPath)).toBe(true);
  });

  it.each(ALLOWED_PATHS)('allows %s', (requestPath) => {
    expect(isDeniedCommandHubStaticPath(requestPath)).toBe(false);
  });

  it('denies percent-encoded variants of a backup path', () => {
    // express.static decodes the path, so the denylist must decode too.
    expect(isDeniedCommandHubStaticPath('/app.js%2Ebackup')).toBe(true);
    expect(isDeniedCommandHubStaticPath('/index.html.backup%2D20251108-223919')).toBe(true);
  });

  it('denies /debug.html case-insensitively but not other html files', () => {
    expect(isDeniedCommandHubStaticPath('/DEBUG.HTML')).toBe(true);
    expect(isDeniedCommandHubStaticPath('/watcher.html')).toBe(false);
  });

  it('does not deny paths that merely mention debug in another form', () => {
    expect(isDeniedCommandHubStaticPath('/debug')).toBe(false);
    expect(isDeniedCommandHubStaticPath('/debug.js')).toBe(false);
  });

  it('exposes /debug.html in the documented exact-path denylist', () => {
    expect(COMMAND_HUB_DENIED_STATIC_EXACT_PATHS).toContain('/debug.html');
  });
});

describe('denyCommandHubBackupFiles (middleware)', () => {
  it.each(DENIED_PATHS)('404s %s and never calls next()', (requestPath) => {
    const next = jest.fn();
    const fake = makeRes();

    denyCommandHubBackupFiles({ path: requestPath } as express.Request, fake.res, next);

    expect(fake.statusCode).toBe(404);
    expect(fake.body).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(next).not.toHaveBeenCalled();
  });

  it.each(ALLOWED_PATHS)('passes %s through to next() without a 404', (requestPath) => {
    const next = jest.fn();
    const fake = makeRes();

    denyCommandHubBackupFiles({ path: requestPath } as express.Request, fake.res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(fake.statusCode).toBeNull();
    expect(fake.body).toBeUndefined();
  });

  it('passes nested directory paths and query-string-only paths through', () => {
    // req.path never carries the query string, so a query like
    // `?v=.backup` cannot smuggle the file past the denylist either.
    const next = jest.fn();
    const fake = makeRes();

    denyCommandHubBackupFiles(
      { path: '/vendor/styles.css', query: { v: '.backup' } } as unknown as express.Request,
      fake.res,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(fake.statusCode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mount-order regression: middleware before the real express.static root
// ---------------------------------------------------------------------------

describe('mount order — deny middleware ahead of express.static', () => {
  const staticRoot = path.join(__dirname, '../src/frontend/command-hub');

  const app = express();
  app.use('/command-hub', denyCommandHubBackupFiles);
  app.use(
    '/command-hub',
    express.static(staticRoot, {
      etag: false,
      lastModified: false,
    }),
  );

  it.each(DENIED_PATHS)('returns 404 for the stale file %s', async (requestPath) => {
    const res = await request(app).get(`/command-hub${requestPath}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('still serves the live app.js and index.html', async () => {
    const jsRes = await request(app).get('/command-hub/app.js');
    expect(jsRes.status).toBe(200);
    expect(jsRes.text.length).toBeGreaterThan(0);

    const htmlRes = await request(app).get('/command-hub/index.html');
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.text).toContain('<!DOCTYPE html');
  });

  it('would have served the stale files without the denylist (regression baseline)', async () => {
    // The files must still exist on disk (BUILD.md forbids deleting them) and,
    // with express.static alone, would be served with 200 — which is exactly
    // the leak this middleware closes.
    const bare = express();
    bare.use('/command-hub', express.static(staticRoot, { etag: false, lastModified: false }));

    for (const deniedPath of DENIED_PATHS) {
      expect(fs.existsSync(path.join(staticRoot, deniedPath))).toBe(true);
      const res = await request(bare).get(`/command-hub${deniedPath}`);
      expect(res.status).toBe(200);
    }
  });

  it('is mounted in src/index.ts ahead of the /command-hub express.static mount', () => {
    const indexSource = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    const denyMountAt = indexSource.indexOf("app.use('/command-hub', denyCommandHubBackupFiles)");
    const staticMountAt = indexSource.indexOf("app.use('/command-hub', express.static(staticPath");

    expect(denyMountAt).toBeGreaterThan(-1);
    expect(staticMountAt).toBeGreaterThan(-1);
    expect(denyMountAt).toBeLessThan(staticMountAt);
  });
});
