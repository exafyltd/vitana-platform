// VTID-03125 — Phase D.2 of the decision-contract refactor.
//
// Locks the wire-up that migrates `connectionIssueMessages` from an
// inline 8-language Record export to a `policy_render_block`-backed
// accessor. The literal Record stays in code as the cache-cold safety
// net; production source of truth is the seeded DB rows.

import { getConnectionIssueMessage } from '../../../src/orb/upstream/constants';
import {
  configurePolicyResolverForTests,
  __resetPolicyResolverForTests,
} from '../../../src/services/decision-contract/policy-resolver';

const NOW_ISO = new Date().toISOString();

function seedBlock(language: string, content: string) {
  configurePolicyResolverForTests({
    policyRenderBlock: [
      {
        block_key: 'voice.connection_issue',
        language,
        tenant_id: null,
        version: 1,
        content,
        effective_from: NOW_ISO,
        effective_until: null,
      },
    ],
  });
}

describe('VTID-03125 Phase D.2 connection-issue accessor', () => {
  afterEach(() => {
    __resetPolicyResolverForTests();
  });

  describe('cold-cache fallback path (byte-identical to pre-D.2 Record)', () => {
    beforeEach(() => {
      __resetPolicyResolverForTests();
    });

    it('en falls back to the literal English string', () => {
      expect(getConnectionIssueMessage('en')).toBe(
        "I'm sorry, I seem to be having connection issues right now. Please try starting a new conversation.",
      );
    });

    it('de falls back to the literal German string', () => {
      expect(getConnectionIssueMessage('de')).toBe(
        'Es tut mir leid, ich habe gerade Verbindungsprobleme. Bitte versuchen Sie, ein neues Gespräch zu starten.',
      );
    });

    it('fr falls back to the literal French string', () => {
      expect(getConnectionIssueMessage('fr')).toBe(
        "Je suis désolé, j'ai des problèmes de connexion. Veuillez réessayer une nouvelle conversation.",
      );
    });

    it('es / ar / zh / ru / sr all have non-empty literal fallbacks', () => {
      // Spot-check: each must return a non-empty, non-English string
      // (Latin / non-Latin scripts both supported).
      for (const lang of ['es', 'ar', 'zh', 'ru', 'sr']) {
        const out = getConnectionIssueMessage(lang);
        expect(out.length).toBeGreaterThan(0);
        // Spot-check by alphabet — none of these should be the English text.
        expect(out).not.toContain('connection issues right now');
      }
    });

    it('unknown language falls back to the English string (not empty)', () => {
      expect(getConnectionIssueMessage('jp')).toBe(
        "I'm sorry, I seem to be having connection issues right now. Please try starting a new conversation.",
      );
    });
  });

  describe('resolver-seeded path — DB row wins over fallback', () => {
    it('returns the seeded value when language matches', () => {
      seedBlock('de', 'Verbindungsfehler — bitte erneut versuchen.');
      expect(getConnectionIssueMessage('de')).toBe(
        'Verbindungsfehler — bitte erneut versuchen.',
      );
    });

    it('seeded English row is returned for en', () => {
      seedBlock('en', 'Connection trouble — please restart.');
      expect(getConnectionIssueMessage('en')).toBe(
        'Connection trouble — please restart.',
      );
    });

    it('resolver English-fallback path: requested fr, only en seeded → returns seeded en', () => {
      seedBlock('en', 'Reseeded English.');
      // No 'fr' row seeded — resolver falls back to 'en' before the
      // hard-coded literal.
      expect(getConnectionIssueMessage('fr')).toBe('Reseeded English.');
    });

    it('multiple languages seeded — each returns its own row', () => {
      configurePolicyResolverForTests({
        policyRenderBlock: [
          {
            block_key: 'voice.connection_issue',
            language: 'en',
            tenant_id: null,
            version: 1,
            content: 'EN seed',
            effective_from: NOW_ISO,
            effective_until: null,
          },
          {
            block_key: 'voice.connection_issue',
            language: 'de',
            tenant_id: null,
            version: 1,
            content: 'DE seed',
            effective_from: NOW_ISO,
            effective_until: null,
          },
        ],
      });
      expect(getConnectionIssueMessage('en')).toBe('EN seed');
      expect(getConnectionIssueMessage('de')).toBe('DE seed');
    });
  });

  describe('expired rows do not override the fallback', () => {
    it('expired German row → falls back to literal German', () => {
      configurePolicyResolverForTests({
        policyRenderBlock: [
          {
            block_key: 'voice.connection_issue',
            language: 'de',
            tenant_id: null,
            version: 1,
            content: 'EXPIRED CONTENT',
            effective_from: '2020-01-01T00:00:00.000Z',
            effective_until: '2020-12-31T23:59:59.000Z',
          },
        ],
      });
      expect(getConnectionIssueMessage('de')).toBe(
        'Es tut mir leid, ich habe gerade Verbindungsprobleme. Bitte versuchen Sie, ein neues Gespräch zu starten.',
      );
    });
  });
});
