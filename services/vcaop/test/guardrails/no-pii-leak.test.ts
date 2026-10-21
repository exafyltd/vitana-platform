import { redact, assertNoPii, scrubBrowserArtifact, REDACTION } from '../../src/guardrails/no-pii-leak';
import { PiiLeakError } from '../../src/guardrails/errors';

describe('no-pii-leak (Sec. 0.3 item 8, Sec. 9)', () => {
  test('redacts PII-named fields', () => {
    const out = redact({ email: 'a@b.com', officer_name: 'Jane Doe', provider_id: 'amazon' });
    expect(out.email).toBe(REDACTION);
    expect(out.officer_name).toBe(REDACTION);
    expect(out.provider_id).toBe('amazon'); // not PII
  });

  test('redacts PII-looking string values', () => {
    const out = redact({ note: 'reach me at john@x.com or +14155550123' });
    expect(out.note).not.toMatch(/john@x\.com/);
    expect(out.note).not.toMatch(/\+14155550123/);
  });

  test('allows *_ref pointers through', () => {
    expect(() => assertNoPii({ officer_name_ref: 'vault://officer/1' }, 'oasis_event')).not.toThrow();
  });

  test('assertNoPii throws when PII present in a sink', () => {
    expect(() => assertNoPii({ email: 'x@y.com' }, 'oasis_event')).toThrow(PiiLeakError);
    expect(() => assertNoPii({ note: 'card 4111 1111 1111 1111' }, 'log')).toThrow(PiiLeakError);
    expect(() => assertNoPii({ ok: 'no pii here' }, 'llm_prompt')).not.toThrow();
  });

  test('redacted payload passes assertNoPii', () => {
    const clean = redact({ email: 'a@b.com', body: 'hi' });
    expect(() => assertNoPii(clean, 'oasis_event')).not.toThrow();
  });

  test('scrubBrowserArtifact returns a clean artifact', () => {
    const scrubbed = scrubBrowserArtifact({ dom: 'user jane@x.com clicked', address: '1 Main St' });
    expect(() => assertNoPii(scrubbed, 'browser_artifact')).not.toThrow();
    expect(scrubbed.address).toBe(REDACTION);
  });
});
