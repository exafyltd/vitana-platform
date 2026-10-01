/**
 * VTID-04750: a stored fact wins over an old conversation note. Production
 * live-092945f7 (2026-09-29): the wife's birthday is stored as 4 November
 * 1999 (1997 was replaced on 09-25); Vitana said 1997.
 */
import { formatContextPackForLLM } from '../../../src/services/context-pack-builder';

describe('VTID-04750: memory block says facts win over older notes', () => {
  it('labels conversation excerpts as possibly out of date', () => {
    const pack: any = {
      memory_hits: [
        { category_key: 'fact:disclosed', content: 'spouse_birthday: 4. November 1999' },
        { category_key: 'conversation', content: 'Meine Frau hat am 4. November 1997 Geburtstag' },
      ],
      knowledge_hits: [], web_hits: [], relationship_context: [], active_vtids: [], tenant_policies: [], tool_health: [], ui_context: {}, diary_entries: [], network: [],
      identity: { user_id: 'u1', display_name: 'Dragan', role: 'community' },
      session_state: { turn_number: 1, channel: 'orb' },
    };
    const out = formatContextPackForLLM(pack);
    expect(out).toContain('spouse_birthday: 4. November 1999');
    expect(out).toMatch(/can be out of date: when one disagrees with a structured fact above, the structured fact is correct/);
  });
});
