import { CoverGenError } from '../src/services/intent-cover-service';

describe('AI intent cover backfill', () => {
  it('requires an explicit staging-only apply confirmation', async () => {
    const { assertBackfillSafety } = await import(
      '../src/scripts/regenerate-ai-intent-covers'
    );

    expect(() => assertBackfillSafety('production', 'replace-all-ai-covers', true)).toThrow(
      /staging/i,
    );
    expect(() => assertBackfillSafety('staging', '', true)).toThrow(/confirmation/i);
    expect(() => assertBackfillSafety('staging', 'replace-all-ai-covers', false)).toThrow(
      /--apply/i,
    );
    expect(() =>
      assertBackfillSafety('staging', 'replace-all-ai-covers', true),
    ).not.toThrow();
  });

  it('replaces legacy AI covers and skips already-versioned covers', async () => {
    const { runAiCoverBackfill } = await import(
      '../src/scripts/regenerate-ai-intent-covers'
    );
    const replace = jest.fn(async (row: { intent_id: string }) => ({
      cover_url: `https://files.example/ai/v2-german-groups/${row.intent_id}/new.png`,
    }));
    const rows = [
      {
        intent_id: 'legacy-1',
        requester_user_id: 'user-1',
        category: 'dance.salsa',
        cover_url: 'https://files.example/ai/legacy-1.png',
      },
      {
        intent_id: 'current-1',
        requester_user_id: 'user-2',
        category: 'sport.tennis',
        cover_url:
          'https://files.example/ai/v2-german-groups/current-1/already-new.png',
      },
    ];

    const summary = await runAiCoverBackfill(rows, replace);

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(rows[0]);
    expect(summary).toMatchObject({
      scanned: 2,
      selected: 1,
      replaced: 1,
      skipped_current: 1,
      failed: 0,
    });
  });

  it('retries provider failures once but does not retry optimistic conflicts', async () => {
    const { runAiCoverBackfill } = await import(
      '../src/scripts/regenerate-ai-intent-covers'
    );
    const attempts = new Map<string, number>();
    const replace = jest.fn(async (row: { intent_id: string }) => {
      const count = (attempts.get(row.intent_id) ?? 0) + 1;
      attempts.set(row.intent_id, count);
      if (row.intent_id === 'transient' && count === 1) {
        throw new CoverGenError('provider_failed', 'temporary Vertex failure');
      }
      if (row.intent_id === 'conflict') {
        throw new CoverGenError('conflict', 'cover changed');
      }
      return { cover_url: `https://files.example/new/${row.intent_id}.png` };
    });
    const rows = ['transient', 'conflict'].map((intent_id) => ({
      intent_id,
      requester_user_id: 'user-1',
      category: null,
      cover_url: `https://files.example/ai/${intent_id}.png`,
    }));

    const summary = await runAiCoverBackfill(rows, replace);

    expect(attempts.get('transient')).toBe(2);
    expect(attempts.get('conflict')).toBe(1);
    expect(summary.replaced).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failures).toEqual([
      expect.objectContaining({ intent_id: 'conflict', code: 'conflict' }),
    ]);
  });
});
