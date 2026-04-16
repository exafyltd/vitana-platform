/**
 * Tests for Developer Autopilot Synthesis service — fingerprint + scoring
 * helpers. Ingest itself requires Supabase; covered by integration tests.
 */

import {
  fingerprintSignal,
  scoreSignal,
  titleForSignal,
  domainForPath,
  TYPE_RISK_CLASS,
  DevAutopilotSignal,
} from '../src/services/dev-autopilot-synthesis';

const signal = (overrides: Partial<DevAutopilotSignal> = {}): DevAutopilotSignal => ({
  type: 'dead_code',
  severity: 'medium',
  file_path: 'services/gateway/src/routes/foo.ts',
  line_number: 42,
  message: 'Unused export `foo`',
  suggested_action: 'Remove export',
  scanner: 'knip',
  ...overrides,
});

describe('fingerprintSignal', () => {
  it('produces stable 16-char hex fingerprints', () => {
    const fp = fingerprintSignal(signal());
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });

  it('is stable for identical inputs', () => {
    expect(fingerprintSignal(signal())).toBe(fingerprintSignal(signal()));
  });

  it('changes when any keying field changes', () => {
    const base = fingerprintSignal(signal());
    expect(fingerprintSignal(signal({ type: 'todo' }))).not.toBe(base);
    expect(fingerprintSignal(signal({ file_path: 'other.ts' }))).not.toBe(base);
    expect(fingerprintSignal(signal({ line_number: 43 }))).not.toBe(base);
  });

  it('treats missing line_number as 0 consistently', () => {
    const a = fingerprintSignal(signal({ line_number: undefined }));
    const b = fingerprintSignal(signal({ line_number: 0 }));
    expect(a).toBe(b);
  });
});

describe('scoreSignal', () => {
  it('scales impact with severity', () => {
    expect(scoreSignal(signal({ severity: 'low' })).impact_score).toBeLessThan(
      scoreSignal(signal({ severity: 'medium' })).impact_score,
    );
    expect(scoreSignal(signal({ severity: 'medium' })).impact_score).toBeLessThan(
      scoreSignal(signal({ severity: 'high' })).impact_score,
    );
  });

  it('marks dead_code as low risk + auto-exec eligible', () => {
    const s = scoreSignal(signal({ type: 'dead_code' }));
    expect(s.risk_class).toBe('low');
    expect(s.auto_exec_eligible).toBe(true);
  });

  it('marks large_file as high risk + auto-exec ineligible', () => {
    const s = scoreSignal(signal({ type: 'large_file' }));
    expect(s.risk_class).toBe('high');
    expect(s.auto_exec_eligible).toBe(false);
  });

  it('marks medium-risk types eligible for auto-exec', () => {
    const s = scoreSignal(signal({ type: 'missing_tests' }));
    expect(s.risk_class).toBe('medium');
    expect(s.auto_exec_eligible).toBe(true);
  });
});

describe('titleForSignal', () => {
  it('uses the basename of the file', () => {
    expect(titleForSignal(signal({ file_path: 'a/b/foo.ts' }))).toContain('foo.ts');
  });

  it('varies title by signal type', () => {
    const a = titleForSignal(signal({ type: 'dead_code' }));
    const b = titleForSignal(signal({ type: 'missing_tests' }));
    expect(a).not.toBe(b);
  });
});

describe('domainForPath', () => {
  it('buckets known prefixes', () => {
    expect(domainForPath('services/gateway/src/routes/auth.ts')).toBe('routes');
    expect(domainForPath('services/gateway/src/services/foo.ts')).toBe('services');
    expect(domainForPath('services/gateway/src/frontend/command-hub/app.js')).toBe('frontend');
    expect(domainForPath('services/agents/cognee-extractor/main.py')).toBe('agents');
    expect(domainForPath('supabase/migrations/x.sql')).toBe('database');
  });

  it('falls back to general', () => {
    expect(domainForPath('random/path.md')).toBe('general');
  });
});

describe('TYPE_RISK_CLASS invariant', () => {
  it('covers every SignalType with a risk_class', () => {
    const types: Array<keyof typeof TYPE_RISK_CLASS> = [
      'dead_code', 'unused_dep', 'missing_docs', 'todo', 'missing_tests',
      'circular_dep', 'duplication', 'cognitive_complexity', 'large_file',
    ];
    for (const t of types) {
      expect(TYPE_RISK_CLASS[t]).toMatch(/^(low|medium|high)$/);
    }
  });
});
