/**
 * Tests for src/middleware/require-vtid.ts (VTID presence gate).
 *
 * Contract under test:
 *   - Accepts a VTID from the X-VTID header, the JSON body (`vtid`), or the
 *     query string (`?vtid=`), attaching it as req.vtid for downstream code.
 *   - Source precedence: header > body > query.
 *   - 400 { ok:false, error:"VTID required" } when none is provided.
 */

import request from 'supertest';
import express from 'express';

import { requireVtid } from '../../src/middleware/require-vtid';

const app = express();
app.use(express.json());
const echo = (req: any, res: any) => res.json({ ok: true, vtid: req.vtid });
app.get('/gate', requireVtid, echo);
app.post('/gate', requireVtid, echo);

describe('requireVtid middleware', () => {
  it('accepts a VTID from the X-VTID header and attaches req.vtid', async () => {
    const res = await request(app).get('/gate').set('X-VTID', 'VTID-01200');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, vtid: 'VTID-01200' });
  });

  it('accepts a VTID from the JSON body', async () => {
    const res = await request(app).post('/gate').send({ vtid: 'VTID-02222' });
    expect(res.status).toBe(200);
    expect(res.body.vtid).toBe('VTID-02222');
  });

  it('accepts a VTID from the query string', async () => {
    const res = await request(app).get('/gate?vtid=VTID-03333');
    expect(res.status).toBe(200);
    expect(res.body.vtid).toBe('VTID-03333');
  });

  it('prefers the header over body and query when several are supplied', async () => {
    const res = await request(app)
      .post('/gate?vtid=VTID-QUERY')
      .set('X-VTID', 'VTID-HEADER')
      .send({ vtid: 'VTID-BODY' });
    expect(res.status).toBe(200);
    expect(res.body.vtid).toBe('VTID-HEADER');
  });

  it('prefers the body over the query when no header is present', async () => {
    const res = await request(app).post('/gate?vtid=VTID-QUERY').send({ vtid: 'VTID-BODY' });
    expect(res.status).toBe(200);
    expect(res.body.vtid).toBe('VTID-BODY');
  });

  it('returns 400 "VTID required" when no VTID is provided anywhere', async () => {
    const res = await request(app).get('/gate');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: 'VTID required',
      message: 'Please provide VTID in header (X-VTID), body, or query param',
    });
  });

  it('returns 400 for an empty-string vtid in the body', async () => {
    const res = await request(app).post('/gate').send({ vtid: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VTID required');
  });
});
