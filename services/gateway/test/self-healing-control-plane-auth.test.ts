/**
 * Self-Healing control-plane hardening (audit P0-1 + P0-5).
 *
 * P0-1: the self-healing mutation routes shipped with NO route authentication,
 * so any caller reaching the gateway could flip autonomy to FULL_AUTO, disable
 * the kill switch, approve low-confidence repairs, or inject fake outages. These
 * tests pin the two canonical gates: `requireServiceOrAdmin` (for /report) and
 * `requireAdminOnly` (for every state-changing operator action).
 *
 * P0-5: the control-plane config helpers failed OPEN — a Supabase outage silently
 * defaulted autonomy to AUTO_FIX_SIMPLE (level 3). This test pins the fail-CLOSED
 * behaviour: when the control plane is unreachable, getAutonomyLevel() must return
 * the lowest, log-only OBSERVE_ONLY level.
 */

import type { Request, Response, NextFunction } from 'express';

// Mock the JWT middleware so the admin-JWT path is deterministic (no network,
// no JWKS). Each test sets `optionalAuthImpl` to simulate the identity outcome.
let optionalAuthImpl: (req: any, res: any, next: () => void) => void = (_req, _res, next) => next();
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (req: any, res: any, next: () => void) => optionalAuthImpl(req, res, next),
}));

import {
  requireServiceOrAdmin,
  requireAdminOnly,
} from '../src/middleware/require-service-or-admin';
import { getAutonomyLevel } from '../src/routes/self-healing';
import { AutonomyLevel } from '../src/types/self-healing';

// ---- lightweight express req/res doubles -----------------------------------

function mockReq(headers: Record<string, string> = {}): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: lower, // optionalAuth reads req.headers.authorization
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
}

function mockRes(): Response & { _status: number | null; _json: any } {
  const res: any = { _status: null, _json: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (body: any) => { res._json = body; return res; };
  return res as Response & { _status: number | null; _json: any };
}

describe('control-plane auth gates (P0-1)', () => {
  const ORIGINAL = process.env.GATEWAY_SERVICE_TOKEN;
  beforeEach(() => {
    optionalAuthImpl = (_req, _res, next) => next(); // default: no identity set
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GATEWAY_SERVICE_TOKEN;
    else process.env.GATEWAY_SERVICE_TOKEN = ORIGINAL;
  });

  describe('requireServiceOrAdmin', () => {
    it('rejects a request with no Authorization header (401)', () => {
      const res = mockRes();
      let next = false;
      requireServiceOrAdmin(mockReq(), res, (() => { next = true; }) as NextFunction);
      expect(next).toBe(false);
      expect(res._status).toBe(401);
    });

    it('rejects a non-bearer Authorization header (401)', () => {
      const res = mockRes();
      let next = false;
      requireServiceOrAdmin(mockReq({ Authorization: 'Basic abc' }), res, (() => { next = true; }) as NextFunction);
      expect(next).toBe(false);
      expect(res._status).toBe(401);
    });

    it('accepts a matching GATEWAY_SERVICE_TOKEN without touching JWT validation', () => {
      process.env.GATEWAY_SERVICE_TOKEN = 'secret-service-token';
      let jwtTouched = false;
      optionalAuthImpl = (_req, _res, next) => { jwtTouched = true; next(); };
      const res = mockRes();
      let next = false;
      requireServiceOrAdmin(
        mockReq({ Authorization: 'Bearer secret-service-token' }),
        res,
        (() => { next = true; }) as NextFunction,
      );
      expect(next).toBe(true);
      expect(res._status).toBeNull();
      expect(jwtTouched).toBe(false); // service path short-circuits before JWT
    });

    it('accepts a valid exafy_admin JWT when no service token matches', () => {
      delete process.env.GATEWAY_SERVICE_TOKEN;
      optionalAuthImpl = (req, _res, next) => { req.identity = { user_id: 'u1', exafy_admin: true }; next(); };
      const res = mockRes();
      let next = false;
      requireServiceOrAdmin(mockReq({ Authorization: 'Bearer some.jwt.token' }), res, (() => { next = true; }) as NextFunction);
      expect(next).toBe(true);
      expect(res._status).toBeNull();
    });

    it('rejects a valid but non-admin JWT (403)', () => {
      delete process.env.GATEWAY_SERVICE_TOKEN;
      optionalAuthImpl = (req, _res, next) => { req.identity = { user_id: 'u2', exafy_admin: false }; next(); };
      const res = mockRes();
      let next = false;
      requireServiceOrAdmin(mockReq({ Authorization: 'Bearer some.jwt.token' }), res, (() => { next = true; }) as NextFunction);
      expect(next).toBe(false);
      expect(res._status).toBe(403);
    });
  });

  describe('requireAdminOnly', () => {
    it('rejects a request with no Authorization header (401)', () => {
      const res = mockRes();
      let next = false;
      requireAdminOnly(mockReq(), res, (() => { next = true; }) as NextFunction);
      expect(next).toBe(false);
      expect(res._status).toBe(401);
    });

    it('does NOT accept the service token — admin actions require a human admin JWT (401)', () => {
      process.env.GATEWAY_SERVICE_TOKEN = 'secret-service-token';
      // optionalAuth runs for the token but yields no admin identity.
      optionalAuthImpl = (_req, _res, next) => next();
      const res = mockRes();
      let next = false;
      requireAdminOnly(
        mockReq({ Authorization: 'Bearer secret-service-token' }),
        res,
        (() => { next = true; }) as NextFunction,
      );
      expect(next).toBe(false);
      expect(res._status).toBe(401);
    });

    it('accepts a valid exafy_admin JWT', () => {
      optionalAuthImpl = (req, _res, next) => { req.identity = { user_id: 'admin1', exafy_admin: true }; next(); };
      const res = mockRes();
      let next = false;
      requireAdminOnly(mockReq({ Authorization: 'Bearer some.jwt.token' }), res, (() => { next = true; }) as NextFunction);
      expect(next).toBe(true);
      expect(res._status).toBeNull();
    });
  });
});

describe('getAutonomyLevel fail-closed default (P0-5)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('returns OBSERVE_ONLY (not AUTO_FIX_SIMPLE) when the control plane is unreachable', async () => {
    // Whether or not Supabase creds were captured at import, an unreachable
    // control plane must resolve to the lowest authority level.
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as any;
    const level = await getAutonomyLevel();
    expect(level).toBe(AutonomyLevel.OBSERVE_ONLY);
    expect(level).not.toBe(AutonomyLevel.AUTO_FIX_SIMPLE);
  });
});
