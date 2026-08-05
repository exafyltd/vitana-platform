#!/usr/bin/env npx ts-node
/**
 * VTID-03497 — verify the Titan Image Generator assumptions against LIVE AWS.
 *
 * Three things in `providers/titan-image.ts` were derived from documentation
 * and NOT confirmed against the API, because the session that wrote them had
 * no AWS credentials. Run this before flipping `IMAGE_PROVIDER=bedrock`.
 *
 *   1. **Model availability in the chosen region.** Titan Image Generator is
 *      not offered everywhere, and Vitana's estate is eu-central-1.
 *   2. **The supported width/height table.** A wrong entry is a hard
 *      ValidationException, so this is self-announcing — but better here than
 *      on a user's cover upload.
 *   3. **Outpaint mask polarity** — the one that fails SILENTLY in the sense
 *      that bytes come back and look like a plausible image, just with the
 *      subject regenerated and the margins preserved. This script renders a
 *      deterministic probe: a red square on the left, mask covering the right
 *      margin. If polarity is correct the red square SURVIVES; if inverted,
 *      the red square is replaced and the margin is untouched.
 *
 * Usage:
 *   BEDROCK_ROLE_ARN=... AWS_TITAN_IMAGE_REGION=us-east-1 \
 *     npx ts-node scripts/images/verify-titan-image.ts
 *
 * Writes probe PNGs to /tmp/titan-verify-*.png for eyeballing. Exits non-zero
 * on any failure that can be detected without a human looking.
 */

import sharp from 'sharp';
import {
  getTitanRegion,
  getTitanModelId,
  titanWhiteGenerates,
  nearestTitanSize,
  generateTitanImage,
  outpaintTitanImage,
  TITAN_SUPPORTED_SIZES,
} from '../../services/gateway/src/providers/titan-image';

async function main(): Promise<void> {
  if (!process.env.BEDROCK_ROLE_ARN) {
    console.error('[verify-titan] BEDROCK_ROLE_ARN is unset — nothing to verify against.');
    process.exit(1);
  }
  console.log(`[verify-titan] region=${getTitanRegion()} model=${getTitanModelId()}`);
  console.log(`[verify-titan] mask polarity: white_generates=${titanWhiteGenerates()}`);

  let failures = 0;

  // ---- 1. Model reachable + text-to-image at the cover aspect -------------
  const size = nearestTitanSize(1600, 900);
  console.log(`\n[1] TEXT_IMAGE at ${size.width}x${size.height} (mapped from 1600x900)`);
  const gen = await generateTitanImage({
    prompt: 'A calm sunrise over still water, photorealistic, no text',
    width: 1600,
    height: 900,
  });
  if (!gen.ok) {
    console.error(`✗ TEXT_IMAGE failed: ${gen.error} — ${gen.message}`);
    if (gen.error === 'invoke_failed' && /model|not found|access/i.test(gen.message)) {
      console.error(
        '  → Likely the model is not available in this region, or model access is not enabled\n' +
          '    for the account. Check Bedrock → Model access, and try AWS_TITAN_IMAGE_REGION=us-east-1.',
      );
    }
    failures++;
  } else {
    const meta = await sharp(gen.pngBytes).metadata();
    console.log(`✓ TEXT_IMAGE ok — ${meta.width}x${meta.height}, ${gen.upstream_ms}ms`);
    if (meta.width !== size.width || meta.height !== size.height) {
      console.error(`✗ returned ${meta.width}x${meta.height}, expected ${size.width}x${size.height}`);
      failures++;
    }
    await sharp(gen.pngBytes).toFile('/tmp/titan-verify-text-image.png');
  }

  // ---- 2. Every entry in the size table is actually accepted --------------
  // Only spot-checked: a full sweep is 15 generations and real money. The
  // cover path only ever uses the 16:9 entry, so that one is the load-bearing
  // case and is covered by [1] above.
  console.log(`\n[2] size table has ${TITAN_SUPPORTED_SIZES.length} entries (spot-checked via [1])`);

  // ---- 3. Mask polarity probe -------------------------------------------
  console.log('\n[3] OUTPAINTING mask-polarity probe');
  const W = size.width;
  const H = size.height;
  const subjectW = Math.round(W * 0.5);

  // Canvas: solid red on the LEFT half (the "subject"), black on the right.
  const canvas = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: subjectW, height: H, channels: 3, background: { r: 255, g: 0, b: 0 } },
        })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();

  // Imagen-convention mask: WHITE where we want generation (right margin),
  // BLACK over the subject. Then apply the same inversion the production
  // path applies, so this probe tests the REAL code path's polarity.
  let mask = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      {
        input: await sharp({
          create: { width: subjectW, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } },
        })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
  if (!titanWhiteGenerates()) {
    mask = await sharp(mask).negate({ alpha: false }).png().toBuffer();
  }

  const out = await outpaintTitanImage({
    imagePng: canvas,
    maskPng: mask,
    prompt: 'Extend the scene naturally to the right. Photorealistic.',
    width: W,
    height: H,
  });

  if (!out.ok) {
    console.error(`✗ OUTPAINTING failed: ${out.error} — ${out.message}`);
    failures++;
  } else {
    await sharp(out.pngBytes).toFile('/tmp/titan-verify-outpaint.png');
    // Sample the centre of the left half: it should STILL be red if the
    // subject was preserved.
    const { data } = await sharp(out.pngBytes)
      .extract({ left: Math.round(subjectW / 2) - 4, top: Math.round(H / 2) - 4, width: 8, height: 8 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let r = 0, g = 0, b = 0;
    const px = data.length / 3;
    for (let i = 0; i < data.length; i += 3) {
      r += data[i]; g += data[i + 1]; b += data[i + 2];
    }
    r /= px; g /= px; b /= px;
    const subjectPreserved = r > 150 && g < 100 && b < 100;
    console.log(`  sampled subject region: rgb(${r.toFixed(0)}, ${g.toFixed(0)}, ${b.toFixed(0)})`);
    if (subjectPreserved) {
      console.log('✓ subject PRESERVED — mask polarity is correct as configured.');
    } else {
      console.error(
        '✗ subject was REGENERATED — mask polarity is INVERTED.\n' +
          `  → Set TITAN_OUTPAINT_MASK_POLARITY=${titanWhiteGenerates() ? 'black-generates' : 'white-generates'}\n` +
          '    and re-run. Inspect /tmp/titan-verify-outpaint.png to confirm.',
      );
      failures++;
    }
  }

  if (failures > 0) {
    console.error(`\n[verify-titan] ${failures} failure(s) — do NOT flip IMAGE_PROVIDER=bedrock yet.`);
    process.exit(1);
  }
  console.log('\n[verify-titan] all checks passed. Probe images in /tmp/titan-verify-*.png.');
}

main().catch((err) => {
  console.error('[verify-titan] failed:', err?.message ?? err);
  process.exit(1);
});
