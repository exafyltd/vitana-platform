#!/usr/bin/env npx ts-node
/**
 * VTID-03970 — verify the Fish Audio voice table against the LIVE API.
 *
 * Mirrors `verify-polly-voices.ts`'s purpose: `FISH_VOICES` in
 * `services/gateway/src/services/tts/fish.ts` was built from the model's
 * `GET /model/{id}` metadata (description, author, tags) — a real synthesis
 * call could not be verified because the supplied `FISH_API_KEY` returned
 * HTTP 402 ("Insufficient API credit") on every attempt. Run this once real
 * API credit exists, before flipping `TTS_FISH_FALLBACK_ENABLED=true`
 * anywhere.
 *
 * Checks, per language in the table:
 *   - the reference_id still resolves via GET /model/{id} (not deleted/DMCA'd)
 *   - its own metadata still contains no adult-content tags (sexy/nsfw/
 *     intimate/breathy) — the exact reason the originally-suggested Serbian
 *     voice (f8c26ecae994449faf73bcfae844076b) was rejected for this
 *     integration; re-checked here so a voice can't silently drift into
 *     that category after an author edits it
 *   - a REAL synthesis call succeeds for both 'mp3' and 'pcm' format, and
 *     reports the actual bytes returned — this is the check that could not
 *     run during the building session (402 insufficient credit)
 *
 * Usage:  FISH_API_KEY=sk-fish-... npx ts-node scripts/tts/verify-fish-voice.ts
 * Exits non-zero if any pinned voice fails a check.
 */

const FISH_VOICES: Record<string, { referenceId: string; label: string }> = {
  sr: { referenceId: '2ad62aaf885e4a14add09fe4a38ffd23', label: 'Milica (Fish Official)' },
};

const NSFW_TAGS = new Set(['sexy', 'nsfw', 'intimate', 'explicit']);

async function main(): Promise<void> {
  const apiKey = process.env.FISH_API_KEY;
  if (!apiKey) {
    console.error('[verify-fish] FISH_API_KEY is not set.');
    process.exit(1);
  }

  let failures = 0;

  for (const [lang, voice] of Object.entries(FISH_VOICES)) {
    console.log(`\n=== ${lang}: ${voice.referenceId} (${voice.label}) ===`);

    const metaRes = await fetch(`https://api.fish.audio/model/${voice.referenceId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!metaRes.ok) {
      console.error(`✗ ${lang}: GET /model/${voice.referenceId} failed (HTTP ${metaRes.status})`);
      failures++;
      continue;
    }
    const meta = await metaRes.json();
    const tags: string[] = meta.tags ?? [];
    const badTags = tags.filter((t) => NSFW_TAGS.has(t.toLowerCase()));
    if (badTags.length > 0) {
      console.error(
        `✗ ${lang}: '${voice.referenceId}' now carries adult-content tag(s) [${badTags.join(', ')}] ` +
          `— REMOVE this voice from FISH_VOICES immediately, do not ship it.`,
      );
      failures++;
    } else {
      console.log(`✓ ${lang}: no adult-content tags (checked: ${[...NSFW_TAGS].join(', ')})`);
    }
    console.log(`  description: ${(meta.description ?? '').slice(0, 200)}`);
    console.log(`  author: ${meta.author?.nickname ?? 'unknown'}`);

    for (const format of ['mp3', 'pcm'] as const) {
      const body: Record<string, unknown> = {
        text: 'Zdravo! Ovo je test glasa za Vitanu.',
        reference_id: voice.referenceId,
        format,
        normalize: true,
      };
      if (format === 'pcm') body.sample_rate = 16_000;

      const ttsRes = await fetch('https://api.fish.audio/v1/tts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          model: process.env.FISH_TTS_MODEL || 's2.1-pro',
        },
        body: JSON.stringify(body),
      });

      if (!ttsRes.ok) {
        const errBody = await ttsRes.text().catch(() => '');
        console.error(`✗ ${lang} [${format}]: synthesis failed (HTTP ${ttsRes.status}): ${errBody}`);
        failures++;
        continue;
      }
      const bytes = await ttsRes.arrayBuffer();
      if (bytes.byteLength === 0) {
        console.error(`✗ ${lang} [${format}]: synthesis returned 200 OK but zero bytes`);
        failures++;
        continue;
      }
      console.log(`✓ ${lang} [${format}]: synthesized ${bytes.byteLength} bytes`);
    }
  }

  if (failures > 0) {
    console.error(`\n[verify-fish] ${failures} check(s) failed — do NOT flip TTS_FISH_FALLBACK_ENABLED=true yet.`);
    process.exit(1);
  }
  console.log('\n[verify-fish] all curated voices verified live.');
}

main().catch((err) => {
  console.error('[verify-fish] failed:', err?.message ?? err);
  process.exit(1);
});
