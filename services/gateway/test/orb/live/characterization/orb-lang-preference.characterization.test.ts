/**
 * VTID-03668: `getStoredLanguagePreference()` (routes/orb-live.ts) used to read
 * ONLY memory_facts.preferred_language — an assistant-inferred fact, often
 * stale or never written. src/i18n/server-locale.ts's getUserLocale (used for
 * push notifications, per CLAUDE.md §13b) already documents the correct
 * priority order and calls out `user_preferences.stt_language` explicitly as
 * "the field the frontend Language picker actually writes... the live source
 * for most users today". ORB voice skipped that column entirely, so a
 * session/start call with no explicit client-requested lang (a reconnect, or
 * any session recreation that doesn't resend the user's UI selection) fell
 * through to whatever memory_facts happened to hold instead of the user's
 * actual current Voice Settings selection — reported live as ORB reverting
 * to German mid-session despite the user having selected English.
 *
 * `getStoredLanguagePreference` is a private, unexported function inside a
 * multi-thousand-line route file that cannot be imported directly in this
 * test environment (routes/orb-live.ts pulls in the optional
 * @aws-sdk/client-polly dependency at module load, which is not installed
 * here — see the many suites already skipped for exactly this reason). This
 * is a source-assertion test, the established pattern this codebase already
 * uses for other private logic in this same file (see the VTID-03609 block
 * in vertex-wake-opener-v2.characterization.test.ts): it pins the ORDERING
 * and SHAPE of the fix rather than executing it.
 */
import * as fs from 'fs';
import * as path from 'path';

const GATEWAY_SRC = path.resolve(__dirname, '../../../../src');
const orbLive = fs.readFileSync(path.join(GATEWAY_SRC, 'routes/orb-live.ts'), 'utf8');

function extractFunctionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  // Slice to the next top-level function declaration as a cheap body bound —
  // exact enough for substring/ordering assertions on this function.
  const nextFn = src.indexOf('\nasync function ', start + signature.length);
  const nextFn2 = src.indexOf('\nfunction ', start + signature.length);
  const candidates = [nextFn, nextFn2].filter((i) => i > -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : src.length;
  return src.slice(start, end);
}

describe('VTID-03668: getStoredLanguagePreference checks user_preferences.stt_language first', () => {
  const body = extractFunctionBody(orbLive, 'async function getStoredLanguagePreference(');

  it('queries user_preferences.stt_language', () => {
    expect(body).toMatch(/from\('user_preferences'\)/);
    expect(body).toMatch(/select\('stt_language'\)/);
  });

  it('the stt_language check happens BEFORE the memory_facts fallback', () => {
    const sttAt = body.indexOf("from('user_preferences')");
    const factsAt = body.indexOf('getCurrentFacts(');
    expect(sttAt).toBeGreaterThan(-1);
    expect(factsAt).toBeGreaterThan(-1);
    expect(sttAt).toBeLessThan(factsAt);
  });

  it('validates the stt_language value against SUPPORTED_LIVE_LANGUAGES rather than trusting it blindly', () => {
    const sttAt = body.indexOf("from('user_preferences')");
    const factsAt = body.indexOf('getCurrentFacts(');
    const sttSection = body.slice(sttAt, factsAt);
    expect(sttSection).toMatch(/SUPPORTED_LIVE_LANGUAGES\.includes\(code\)/);
  });

  it('the memory_facts fallback is UNCHANGED (still runs, still scoped to tenant + user)', () => {
    expect(body).toMatch(/getCurrentFacts\(\{\s*tenant_id:\s*tenantId,\s*user_id:\s*userId,\s*fact_keys:\s*\['preferred_language'\],?\s*\}\)/);
  });

  it('a Supabase read failure on the stt_language leg falls through to memory_facts rather than throwing', () => {
    // The stt_language block is wrapped in its own try/catch, separate from
    // the memory_facts block's — a failure on the first leg must not skip
    // the second.
    const sttAt = body.indexOf("from('user_preferences')");
    const tryBefore = body.lastIndexOf('try {', sttAt);
    const catchAfter = body.indexOf('catch', sttAt);
    const factsAt = body.indexOf('getCurrentFacts(');
    expect(tryBefore).toBeGreaterThan(-1);
    expect(catchAfter).toBeGreaterThan(-1);
    expect(catchAfter).toBeLessThan(factsAt);
  });
});
