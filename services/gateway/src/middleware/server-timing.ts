/**
 * Server-Timing middleware — Phase 1 W1 (VTID-03177 PROFILE).
 *
 * Adds `Server-Timing` headers on responses so RUM (vitana-v1) and the eval
 * harness can break down per-route latency without instrumenting each handler.
 *
 * Gated by `FEATURE_LATENCY_TELEMETRY_ENV` (off | staging-only | staging+prod).
 * When off, this middleware is a no-op — zero overhead, no header emitted.
 *
 * Usage on a route file:
 *   import { withServerTiming } from '../middleware/server-timing';
 *   router.use(withServerTiming());
 *
 * Per-handler marks (optional):
 *   res.locals.serverTimingMarks?.push({ name: 'db', dur: 42 });
 *   res.locals.serverTimingMarks?.push({ name: 'render', dur: 8 });
 *
 * The middleware always records `total` from request-in to response-finish.
 * Marks are emitted in insertion order before `total`. Names must match
 * /^[A-Za-z0-9_-]+$/ — any non-conforming mark is dropped to keep the header
 * valid (RFC 8941).
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { isFeatureLive } from '../services/feature-flags';

const FEATURE_NAME = 'LATENCY_TELEMETRY';
const NAME_RE = /^[A-Za-z0-9_-]+$/;

export interface ServerTimingMark {
  name: string;
  dur?: number;       // milliseconds
  desc?: string;      // RFC 8941 description (optional, must be ASCII-safe)
}

declare module 'express-serve-static-core' {
  interface Locals {
    serverTimingMarks?: ServerTimingMark[];
  }
}

function formatHeader(marks: ServerTimingMark[]): string {
  return marks
    .filter((m) => NAME_RE.test(m.name))
    .map((m) => {
      const parts: string[] = [m.name];
      if (typeof m.dur === 'number' && Number.isFinite(m.dur)) {
        parts.push(`dur=${m.dur.toFixed(1)}`);
      }
      if (m.desc && NAME_RE.test(m.desc)) {
        parts.push(`desc="${m.desc}"`);
      }
      return parts.join(';');
    })
    .join(', ');
}

export function withServerTiming(): RequestHandler {
  return function serverTimingMiddleware(_req: Request, res: Response, next: NextFunction) {
    if (!isFeatureLive(FEATURE_NAME)) {
      return next();
    }

    const start = process.hrtime.bigint();
    res.locals.serverTimingMarks = [];

    res.on('finish', () => {
      // Headers are already flushed by the time `finish` fires for streaming
      // responses; this is fine — we only attach when headers are still mutable.
    });

    const originalEnd = res.end.bind(res);
    res.end = function patchedEnd(this: Response, ...args: unknown[]) {
      try {
        if (!res.headersSent) {
          const totalMs = Number(process.hrtime.bigint() - start) / 1_000_000;
          const marks = (res.locals.serverTimingMarks ?? []).slice();
          marks.push({ name: 'total', dur: totalMs });
          const header = formatHeader(marks);
          if (header) {
            res.setHeader('Server-Timing', header);
          }
        }
      } catch {
        // Never let telemetry break a response.
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalEnd(...(args as [any, any?, any?]));
    };

    next();
  };
}
