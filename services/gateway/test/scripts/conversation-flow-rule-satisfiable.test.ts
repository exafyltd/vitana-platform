/**
 * VTID-03721 — the conversation-flow gate must be satisfiable by a real test
 * of the file it flags.
 *
 * `conversation-flow-change-needs-test` lists `routes/orb-live.ts` and
 * `routes/orb-livekit.ts` as flow SOURCE, but its FLOW_TEST_RE matched none of
 * the keywords in `test/routes/orb-live.test.ts` / `test/routes/orb-livekit.test.ts`
 * — those routes' own canonical test files, where they are already tested.
 *
 * Measured: extending `test/routes/orb-livekit.test.ts` with four supertest
 * cases pinning new endpoint behaviour still reported the blocker.
 *
 * An unsatisfiable gate does not get satisfied honestly. It gets satisfied by
 * renaming a file until it hits a keyword, or by claiming the behaviour-free
 * exemption for a change that is not behaviour-free — both launder a guess into
 * a green check, which VTID-03696 already established is worse than no gate.
 *
 * This test reads the rule's OWN regex out of its source, so it cannot drift
 * from what CI actually runs.
 */

import * as fs from 'fs';
import * as path from 'path';

const RULE = path.resolve(
  __dirname,
  '../../../../scripts/ci/impact-rules/conversation-flow-change-needs-test.mjs',
);

const src = fs.readFileSync(RULE, 'utf8');

/** Lift FLOW_TEST_RE out of the rule rather than restating it here. */
function flowTestRe(): RegExp {
  const m = /const FLOW_TEST_RE =\s*(\/\^services[\s\S]*?\/i);/.exec(src);
  if (!m) throw new Error('FLOW_TEST_RE not found in the rule source');
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]};`)() as RegExp;
}

/** Lift the flow-source patterns so both halves are checked against reality. */
function flowSourcePatterns(): string[] {
  const block = src.slice(
    src.indexOf('const FLOW_SOURCE_RE = ['),
    src.indexOf('];', src.indexOf('const FLOW_SOURCE_RE = [')),
  );
  return block.match(/\/\^services[^/]*(?:\\.[^/]*)*\$\//g) ?? [];
}

describe('VTID-03721: conversation-flow gate is satisfiable', () => {
  const re = flowTestRe();

  it.each([
    'services/gateway/test/routes/orb-livekit.test.ts',
    'services/gateway/test/routes/orb-live.test.ts',
  ])('accepts %s — the canonical test for a file the rule flags', (p) => {
    expect(re.test(p)).toBe(true);
  });

  it('still accepts the flow suites it was written for', () => {
    expect(re.test('services/gateway/test/orb/conversation-flow.contract.test.ts')).toBe(true);
    expect(
      re.test('services/gateway/test/orb/live/instruction/greeting-pools.test.ts'),
    ).toBe(true);
  });

  it('has not become a rubber stamp for any changed test file', () => {
    // The value of the gate is that an UNRELATED test does not satisfy it.
    expect(re.test('services/gateway/test/routes/wallet.test.ts')).toBe(false);
    expect(re.test('services/gateway/test/routes/health.test.ts')).toBe(false);
  });

  it('does not match non-test files', () => {
    expect(re.test('services/gateway/test/routes/orb-livekit.ts')).toBe(false);
    expect(re.test('services/gateway/src/routes/orb-livekit.ts')).toBe(false);
  });

  it('every transport file the rule flags has an accepted test path', () => {
    // The invariant, stated directly: for each flow-source file under
    // src/routes/, the mirrored test path must satisfy FLOW_TEST_RE. This is
    // what was false before, and it is what would silently break again if a
    // future transport file is added to FLOW_SOURCE_RE without a keyword.
    const routeSources = flowSourcePatterns().filter((p) => p.includes('routes'));
    expect(routeSources.length).toBeGreaterThan(0);

    for (const pattern of routeSources) {
      const file = /routes\\\/([a-z-]+)\\\.ts/.exec(pattern)?.[1];
      expect(file).toBeTruthy();
      const mirrored = `services/gateway/test/routes/${file}.test.ts`;
      expect({ pattern, mirrored, accepted: re.test(mirrored) }).toEqual({
        pattern,
        mirrored,
        accepted: true,
      });
    }
  });
});
