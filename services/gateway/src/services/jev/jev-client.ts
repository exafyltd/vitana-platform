/**
 * VTID-04473: Jev (TypeSafe System One) HTTP client.
 *
 * Plain fetch, no SDK dependency. Never throws: every outcome is a typed
 * result so the decision service can fall back explicitly (never silently).
 *
 * Activation gate (same convention as BEDROCK_ROLE_ARN / FISH_API_KEY):
 *   JEV_DECISIONS_ENABLED === 'true'  AND  TYPESAFE_API_KEY set
 * Either missing → `not_configured`, and every caller keeps its current path.
 *
 * Env:
 *   TYPESAFE_API_KEY      bearer token (AWS Secrets Manager
 *                         vitana/gateway/<env>/typesafe-api-key)
 *   JEV_API_BASE_URL      default https://api.typesafe.ai
 *   JEV_MODEL             pinned model, default jev-1.13.0 (never -latest in prod)
 */

import { assertValidQuestions, validateAnswers, JevQuestions, JevResponse } from './jev-types';

export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const JEV_DEFAULT_MODEL = 'jev-1.13.0';
export const JEV_DEFAULT_TIMEOUT_MS = 1500;
const RETRY_STATUSES = new Set([429, 529]);

export type JevCallResult =
  | {
      ok: true;
      model: string;
      answers: JevResponse['answers'];
      usage: JevResponse['usage'];
      latency_ms: number;
      attempts: number;
    }
  | {
      ok: false;
      error: string;
      reason: 'not_configured' | 'invalid_request' | 'http_error' | 'timeout' | 'network' | 'malformed_response';
      status?: number;
      latency_ms: number;
      attempts: number;
    };

export function isJevConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JEV_DECISIONS_ENABLED === 'true' && Boolean((env.TYPESAFE_API_KEY || '').trim());
}

export function jevModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env.JEV_MODEL || '').trim() || JEV_DEFAULT_MODEL;
}

export interface JevCallArgs {
  state: unknown;
  questions: JevQuestions;
  timeoutMs?: number;
  /** Retries on 429/529 only. Default 1. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function callJev(args: JevCallArgs): Promise<JevCallResult> {
  const env = args.env ?? process.env;
  const started = Date.now();
  if (!isJevConfigured(env)) {
    return {
      ok: false,
      reason: 'not_configured',
      error: 'Jev not configured (JEV_DECISIONS_ENABLED!=="true" or TYPESAFE_API_KEY unset)',
      latency_ms: 0,
      attempts: 0,
    };
  }
  try {
    assertValidQuestions(args.questions);
  } catch (err: any) {
    return { ok: false, reason: 'invalid_request', error: String(err?.message || err), latency_ms: 0, attempts: 0 };
  }

  const doFetch = args.fetchImpl ?? fetch;
  const sleep = args.sleep ?? defaultSleep;
  const base = ((env.JEV_API_BASE_URL || '').trim() || JEV_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${base}/v1/systemone`;
  const timeoutMs = args.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, args.maxRetries ?? 1);
  const body = JSON.stringify({ model: jevModel(env), state: args.state, questions: args.questions });

  let attempts = 0;
  let last: JevCallResult | null = null;
  while (attempts <= maxRetries) {
    attempts++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${String(env.TYPESAFE_API_KEY).trim()}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 300);
        } catch {
          /* body unreadable — status alone is enough */
        }
        last = {
          ok: false,
          reason: 'http_error',
          status: res.status,
          error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
          latency_ms: Date.now() - started,
          attempts,
        };
        if (RETRY_STATUSES.has(res.status) && attempts <= maxRetries) {
          await sleep(250 * attempts);
          continue;
        }
        return last;
      }
      let json: any;
      try {
        json = await res.json();
      } catch {
        return { ok: false, reason: 'malformed_response', error: 'response is not JSON', latency_ms: Date.now() - started, attempts };
      }
      const problems = validateAnswers(args.questions, json?.answers);
      if (problems.length > 0) {
        return {
          ok: false,
          reason: 'malformed_response',
          error: `answers failed validation: ${problems.slice(0, 5).join('; ')}`,
          latency_ms: Date.now() - started,
          attempts,
        };
      }
      return {
        ok: true,
        model: typeof json.model === 'string' ? json.model : jevModel(env),
        answers: json.answers,
        usage: {
          input_tokens: Number(json?.usage?.input_tokens) || 0,
          output_tokens: Number(json?.usage?.output_tokens) || 0,
        },
        latency_ms: Date.now() - started,
        attempts,
      };
    } catch (err: any) {
      const aborted = err?.name === 'AbortError' || controller.signal.aborted;
      return {
        ok: false,
        reason: aborted ? 'timeout' : 'network',
        error: aborted ? `timed out after ${timeoutMs}ms` : String(err?.message || err),
        latency_ms: Date.now() - started,
        attempts,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return last as JevCallResult;
}
