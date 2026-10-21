// VTID-03182 — D39 PR 5d vertical proof.
//
// PR 5d migrates ONLY `scoreSimplicityAlignment` to read through
// `getCompatibilityResolver().getCompatibilityScore('simplicity', …)`.
// All other 8 D39 scoring functions still use their inline scoreMap
// literals; PR 5e sweeps them next.
//
// This test locks the vertical-proof contract:
//   - `scoreSimplicityAlignment` no longer carries an inline numeric
//     matrix / scoreMap literal in its body.
//   - The service imports `getCompatibilityResolver` from the
//     decision-contract barrel.
//   - The other 8 scoring functions STILL carry their inline
//     scoreMap / compatibilityMap literals (proves PR 5e hasn't
//     drifted in by accident).
//   - The early-return `if (!actionComplexity) return 0.5;` short-
//     circuit is preserved at the call-site (so we don't push
//     `undefined` through the resolver's typed string-key API).
//
// Behavioural parity is locked by the existing 52-test
// `test/d39-taste-alignment.test.ts` suite — those tests exercise
// every simplicity combination via the public `calculateAlignmentScore`
// / `scoreActions` entry-points and stay green after this refactor.

import { readFileSync } from 'fs';
import { join } from 'path';

const D39_SERVICE_PATH = join(
  __dirname,
  '../../../src/services/d39-taste-alignment-service.ts',
);

/** Extract a top-level `function NAME(...): ReturnType { ... }` body
 *  from the source. After the parameter list closes, the very next
 *  `{` at brace-depth 0 is the body opener — TS scoring functions
 *  here all use simple primitive return types (`number`) so we don't
 *  need to defend against return-type object literals. */
function extractFunctionBody(src: string, name: string): string {
  const sigRegex = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`,
  );
  const sigMatch = sigRegex.exec(src);
  if (!sigMatch) throw new Error(`function ${name} not found in source`);
  // Step 1: walk parens to skip the parameter list.
  let i = sigMatch.index + sigMatch[0].length - 1;
  let parens = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '(') parens++;
    else if (c === ')') {
      parens--;
      if (parens === 0) { i++; break; }
    }
    i++;
  }
  // Step 2: skip forward to the next `{` — that's the body brace.
  while (i < src.length && src[i] !== '{') i++;
  if (i === src.length) {
    throw new Error(`body brace not found for ${name}`);
  }
  const bodyStart = i + 1;
  // Step 3: walk braces to find the matching `}`.
  let braceDepth = 1;
  i = bodyStart;
  while (i < src.length && braceDepth > 0) {
    const c = src[i];
    if (c === '{') braceDepth++;
    else if (c === '}') braceDepth--;
    i++;
  }
  return src.slice(bodyStart, i - 1);
}

describe('VTID-03182 D39 PR 5d — simplicity vertical proof', () => {
  let src: string;
  let simplicityBody: string;
  beforeAll(() => {
    src = readFileSync(D39_SERVICE_PATH, 'utf8');
    simplicityBody = extractFunctionBody(src, 'scoreSimplicityAlignment');
  });

  describe('positive contract — simplicity now reads through the resolver', () => {
    it('imports getCompatibilityResolver from the decision-contract barrel', () => {
      expect(src).toMatch(
        /from\s+['"]\.\/decision-contract['"]/,
      );
      expect(src).toMatch(/getCompatibilityResolver/);
    });

    it('scoreSimplicityAlignment body calls getCompatibilityScore with the simplicity dimension', () => {
      // Allow either single-line or multi-line argument lists for
      // resilience against formatter changes.
      expect(simplicityBody).toMatch(
        /getCompatibilityResolver\s*\(\)\s*\.\s*getCompatibilityScore\s*\(\s*['"]simplicity['"]/s,
      );
    });

    it('scoreSimplicityAlignment forwards userPref + actionComplexity (in that order)', () => {
      expect(simplicityBody).toMatch(
        /getCompatibilityScore\s*\(\s*['"]simplicity['"]\s*,\s*userPref\s*,\s*actionComplexity/s,
      );
    });

    it("preserves the early-return short-circuit on undefined actionComplexity", () => {
      // Without this, undefined would flow into the resolver's typed
      // string-key API. The behaviour (0.5 neutral for unknown
      // complexity) must be preserved at the call-site.
      expect(simplicityBody).toMatch(
        /if\s*\(\s*!\s*actionComplexity\s*\)\s*return\s+0\.5/,
      );
    });
  });

  describe('negative contract — no inline simplicity scoreMap in the function body', () => {
    it("scoreSimplicityAlignment body does NOT declare a `scoreMap: Record<…>` literal", () => {
      // The whole point of the vertical proof: the body must not
      // carry the inline matrix anymore.
      expect(simplicityBody).not.toMatch(/scoreMap\s*:\s*Record</);
      // Defensive: also catches a plain `const scoreMap = { … }`
      expect(simplicityBody).not.toMatch(/const\s+scoreMap/);
    });

    it('does NOT carry any of the simplicity cell values inline anymore', () => {
      // Pre-PR-5d this function literally contained `simple: 1.0`,
      // `moderate: 0.6`, `complex: 0.2`, etc. After PR 5d, all the
      // numeric matrix data lives in the resolver / table.
      for (const lit of ['simple:', 'moderate:', 'complex:']) {
        expect(simplicityBody).not.toContain(lit);
      }
    });
  });

  describe('scope discipline — only simplicity migrated', () => {
    // Each tuple: [scoring-function-name, profile-type the inline
    // literal is keyed on]. The vertical proof asserts each of the
    // 8 untouched scoring functions still owns its inline literal
    // and does NOT yet call the resolver.
    const OTHER_FUNCTIONS: Array<[string, string]> = [
      ['scorePremiumAlignment',     'PremiumOrientation'],
      ['scoreAestheticAlignment',   'AestheticStyle'],
      ['scoreToneAlignment',        'ToneAffinity'],
      ['scoreRoutineAlignment',     'RoutineStyle'],
      ['scoreSocialAlignment',      'SocialOrientation'],
      ['scoreConvenienceAlignment', 'ConvenienceBias'],
      ['scoreExperienceAlignment',  'ExperienceType'],
      ['scoreNoveltyAlignment',     'NoveltyTolerance'],
    ];

    function escapeRegex(s: string): string {
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    for (const [fnName, profileType] of OTHER_FUNCTIONS) {
      it(`${fnName} STILL carries its inline scoreMap / compatibilityMap literal (PR 5e territory)`, () => {
        const body = extractFunctionBody(src, fnName);
        // The function should still own its inline literal — PR 5e
        // hasn't shipped yet. We look for either `scoreMap:
        // Record<<profile-type>` or `compatibilityMap:
        // Record<<profile-type>` (aesthetic + tone use the latter).
        const pattern = new RegExp(
          '(scoreMap|compatibilityMap)\\s*:\\s*Record<\\s*' +
            escapeRegex(profileType),
        );
        expect(body).toMatch(pattern);
      });

      it(`${fnName} does NOT call getCompatibilityScore (proves PR 5e hasn't drifted in)`, () => {
        const body = extractFunctionBody(src, fnName);
        expect(body).not.toMatch(/getCompatibilityScore\s*\(/);
      });
    }
  });
});
