/**
 * VTID-04729 — staging 2ae96e0, "wie heißt meine Frau" with no spouse fact
 * stored. The model's own first reply refused, in the words of two prompt
 * blocks that were written for something else:
 *   - "Solche Daten können nur in deinem Profil … Möchtest du, dass ich dich
 *     zu deinen Profileinstellungen bringe?" — the identity guardrail's
 *     sanctioned refusal, meant for the user's OWN profile fields;
 *   - "ich kann keine persönlichen Informationen über andere Personen
 *     preisgeben" — the social context's "never reveal message contents of
 *     other people", meant for other community members.
 * Both now say whom they cover, and rule 6b makes "not stored yet, tell me"
 * the whole answer.
 */
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'service-role-test';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({})) }));
jest.mock('../../src/services/identity-guardrail-block-repository', () => ({
  fetchProfileIdentityRow: jest.fn(),
  fetchAppUserIdentityRow: jest.fn(),
}));

import * as repo from '../../src/services/identity-guardrail-block-repository';
import { buildIdentityGuardrailBlock } from '../../src/services/identity-guardrail-block';
import { buildAssistantSystemHints } from '../../src/services/social-memory/social-memory-prompts';
import { wrapLegacyMemoryPreamble } from '../../src/services/memory-orchestrator';

describe('VTID-04729 the user\'s own people are never a privacy refusal', () => {
  it('the identity guardrail covers only the user\'s own fields and says where their people go', async () => {
    (repo.fetchProfileIdentityRow as jest.Mock).mockResolvedValue({
      data: { first_name: 'E2E', date_of_birth: '1980-01-01' },
      error: null,
    });
    (repo.fetchAppUserIdentityRow as jest.Mock).mockResolvedValue({ data: null, error: null });
    const block = await buildIdentityGuardrailBlock({ user_id: 'u1' });
    expect(block).toContain("NEVER state the user's OWN age, birthday");
    expect(block).toContain('fields of their own');
    expect(block).toMatch(/SCOPE: this block covers only the user's OWN profile fields/);
    expect(block).toMatch(/partner, family and friends .* are not profile fields/);
    expect(block).toMatch(/never answered with the refusal above or sent to the Profile/);
    expect(block).toMatch(/when nothing about them is stored, say you do not know it yet and ask/);
    // the guardrail itself is unchanged for the user's own fields
    expect(block).toContain('respond with the sanctioned refusal');
    expect(block).toContain('The Profile is the only source of truth.');
  });

  it('the social privacy hint protects other members, not the user\'s own people', () => {
    const hints = buildAssistantSystemHints({ person_context: null, matches: [] } as any).join('\n');
    expect(hints).not.toContain('never reveal message contents of other people');
    expect(hints).toMatch(/never reveal what other community members wrote in their messages/);
    expect(hints).toMatch(/This is about other members only: what the user told you about their own partner, family and friends is theirs to hear back/);
    expect(hints).toContain('treat privacy-limited profiles as name-only');
  });

  it('rule 6b: "not stored yet, tell me" is the whole answer, with no profile or settings detour', () => {
    const text = wrapLegacyMemoryPreamble('spouse_name: Anna');
    expect(text).toMatch(/say you don't have it\s+yet and ask for it, so you can remember it: that is the whole\s+answer/);
    expect(text).toMatch(/never send them to their profile or settings/);
    // VTID-04618 / 04645 / 04683 guarantees stay
    expect(text).toMatch(/never cite privacy or data\s+protection/);
    expect(text).toMatch(/Match the person\s+exactly/);
    expect(text).toMatch(/ask about it in any form/);
    expect(text).toContain('ANOTHER MEMBER');
  });
});
