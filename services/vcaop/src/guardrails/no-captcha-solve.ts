/**
 * No-CAPTCHA-solve guard (runbook Sec. 0.3 item 3, Sec. 3).
 *
 * CAPTCHAs are never solved, bypassed, or farmed out. A connector that encounters
 * one throws CaptchaEncountered (-> human task). This module also statically
 * refuses any dependency on a known CAPTCHA-solving service.
 */
import { CaptchaEncountered } from './errors';

/** Known CAPTCHA-solving vendors/packages — referencing any of these is forbidden. */
const CAPTCHA_SOLVER_DENYLIST = [
  '2captcha',
  'anti-captcha',
  'anticaptcha',
  'capmonster',
  'deathbycaptcha',
  'death-by-captcha',
  'capsolver',
  'rucaptcha',
  'bestcaptchasolver',
  'imagetyperz',
  'captcha.guru',
  'nopecha',
  'captcha-solver',
];

/**
 * Throw if any provided dependency / hostname references a CAPTCHA-solving service.
 * Wire this over package.json deps and any outbound-host allowlist in CI.
 */
export function assertNoCaptchaSolverDependency(names: Iterable<string>): void {
  for (const raw of names) {
    const name = (raw ?? '').toLowerCase();
    for (const banned of CAPTCHA_SOLVER_DENYLIST) {
      if (name.includes(banned)) {
        throw new CaptchaEncountered(
          `Forbidden dependency on CAPTCHA-solving service "${raw}" (Sec. 0.3 item 3) — never solve CAPTCHAs`,
        );
      }
    }
  }
}

/**
 * Base for browser connectors. A subclass that detects a CAPTCHA calls
 * `onCaptcha()` which ALWAYS throws — there is no solve path. The caller catches
 * CaptchaEncountered and routes to a human task.
 */
export abstract class CaptchaAwareConnectorBase {
  protected onCaptcha(context?: string): never {
    throw new CaptchaEncountered(
      `CAPTCHA encountered${context ? ` (${context})` : ''} — halting step, routing to human task`,
    );
  }
}
