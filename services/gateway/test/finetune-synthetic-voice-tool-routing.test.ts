import { buildSyntheticVoiceToolRows } from '../scripts/finetune/bootstrap-synthetic-voice-tool-routing';

describe('buildSyntheticVoiceToolRows', () => {
  test('creates PII-free training rows with the expected payload contract', () => {
    const rows = buildSyntheticVoiceToolRows(
      [
        {
          name: 'search_knowledge',
          surface: 'Knowledge',
          category: 'knowledge',
          status: 'live',
          description: 'Search the Vitana knowledge base.',
        },
        {
          name: 'create_calendar_event',
          surface: 'Calendar',
          category: 'calendar',
          status: 'live',
          description: 'Create a calendar event.',
        },
      ],
      4,
      new Date('2026-05-31T19:00:00Z'),
    );

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      source_id: 'synthetic-voice-tool-routing-search_knowledge-0',
      source_at: '2026-05-31T19:00:00.000Z',
      payload: {
        tool_chosen: 'search_knowledge',
        tool_arguments: null,
        synthetic: true,
        training_only: true,
        generator: 'bootstrap-synthetic-voice-tool-routing',
      },
    });
    expect(rows.map((row) => row.payload.tool_chosen)).toEqual([
      'search_knowledge',
      'create_calendar_event',
      'search_knowledge',
      'create_calendar_event',
    ]);
    expect(rows.every((row) => row.payload.user_input.length > 0)).toBe(true);
  });

  test('ignores non-live tools', () => {
    const rows = buildSyntheticVoiceToolRows(
      [
        { name: 'draft_tool', status: 'draft' },
        { name: 'live_tool', status: 'live' },
      ],
      2,
    );

    expect(rows.every((row) => row.payload.tool_chosen === 'live_tool')).toBe(true);
  });
});
