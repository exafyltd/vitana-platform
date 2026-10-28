/**
 * VTID-03497 — Amazon Titan Image Generator provider tests.
 *
 * Build 3 of the 4 provider replacements gating a GCP shutdown, and the one
 * capability Claude cannot cover at all (Vertex Imagen generates images; no
 * Anthropic model does).
 *
 * The interesting tests here are the size mapping and the mask polarity —
 * both are places where a wrong answer produces a VISUALLY broken image that
 * a "did bytes come back" assertion happily passes.
 */

import {
  getImageProvider,
  getTitanRegion,
  getTitanModelId,
  titanWhiteGenerates,
  nearestTitanSize,
  generateTitanImage,
  outpaintTitanImage,
  TITAN_SUPPORTED_SIZES,
} from '../../src/providers/titan-image';

describe('VTID-03497 provider gating', () => {
  const original = process.env.IMAGE_PROVIDER;
  afterEach(() => {
    if (original === undefined) delete process.env.IMAGE_PROVIDER;
    else process.env.IMAGE_PROVIDER = original;
  });

  it('defaults to vertex — deploying this code flips nothing', () => {
    delete process.env.IMAGE_PROVIDER;
    expect(getImageProvider()).toBe('vertex');
  });

  it('selects bedrock only on the exact opt-in value, case-insensitively', () => {
    process.env.IMAGE_PROVIDER = 'BEDROCK';
    expect(getImageProvider()).toBe('bedrock');
  });

  it('falls back to vertex on an unrecognised value rather than failing closed', () => {
    process.env.IMAGE_PROVIDER = 'dalle';
    expect(getImageProvider()).toBe('vertex');
  });
});

describe('VTID-03497 nearestTitanSize', () => {
  it('maps the 1600x900 cover canvas to 1280x720, not a square', () => {
    // The whole point: Titan does not accept 1600x900. Satisfying it with
    // 1024x1024 would letterbox or crop the subject — visually wrong, and
    // invisible to a test that only checks the call succeeded.
    expect(nearestTitanSize(1600, 900)).toEqual({ width: 1280, height: 720 });
  });

  it('always returns a size Titan actually accepts', () => {
    for (const [w, h] of [[1600, 900], [1080, 1920], [500, 500], [3000, 1000], [1, 4]]) {
      const out = nearestTitanSize(w, h);
      expect(TITAN_SUPPORTED_SIZES).toContainEqual(out);
    }
  });

  it('preserves orientation — a portrait request never maps to landscape', () => {
    const out = nearestTitanSize(1080, 1920);
    expect(out.height).toBeGreaterThan(out.width);
  });

  it('preserves orientation — a landscape request never maps to portrait', () => {
    const out = nearestTitanSize(1920, 1080);
    expect(out.width).toBeGreaterThan(out.height);
  });

  it('maps a square request to a square size', () => {
    const out = nearestTitanSize(900, 900);
    expect(out.width).toBe(out.height);
  });

  it('weights aspect above area — an extreme panorama keeps its shape', () => {
    const out = nearestTitanSize(3000, 700); // ~4.3:1
    expect(out.width / out.height).toBeGreaterThan(2);
  });
});

describe('VTID-03497 mask polarity', () => {
  const original = process.env.TITAN_OUTPAINT_MASK_POLARITY;
  afterEach(() => {
    if (original === undefined) delete process.env.TITAN_OUTPAINT_MASK_POLARITY;
    else process.env.TITAN_OUTPAINT_MASK_POLARITY = original;
  });

  it('defaults to black-generates (inverted vs Imagen)', () => {
    // Imagen: white = generate. Titan is documented the other way round, so
    // cover-image-outpaint.ts inverts its Imagen-convention mask by default.
    // Getting this backwards regenerates the SUBJECT and keeps the margins.
    delete process.env.TITAN_OUTPAINT_MASK_POLARITY;
    expect(titanWhiteGenerates()).toBe(false);
  });

  it('can be flipped by env without a code change or redeploy', () => {
    // This override exists because the polarity is UNVERIFIED against the
    // live API — no AWS credentials were available when it was written.
    process.env.TITAN_OUTPAINT_MASK_POLARITY = 'white-generates';
    expect(titanWhiteGenerates()).toBe(true);
  });
});

describe('VTID-03497 region and model resolution', () => {
  const originals = {
    titan: process.env.AWS_TITAN_IMAGE_REGION,
    bedrock: process.env.AWS_BEDROCK_REGION,
    aws: process.env.AWS_REGION,
    model: process.env.TITAN_IMAGE_MODEL_ID,
  };
  afterEach(() => {
    for (const [key, val] of [
      ['AWS_TITAN_IMAGE_REGION', originals.titan],
      ['AWS_BEDROCK_REGION', originals.bedrock],
      ['AWS_REGION', originals.aws],
      ['TITAN_IMAGE_MODEL_ID', originals.model],
    ] as const) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('has its OWN region var, because Titan is not offered in every region', () => {
    // Everything else in Vitana's AWS estate is eu-central-1; inheriting it
    // blindly would fail at call time with an opaque model-not-found.
    process.env.AWS_BEDROCK_REGION = 'eu-central-1';
    process.env.AWS_TITAN_IMAGE_REGION = 'us-east-1';
    expect(getTitanRegion()).toBe('us-east-1');
  });

  it('falls back bedrock region → AWS_REGION → us-east-1', () => {
    delete process.env.AWS_TITAN_IMAGE_REGION;
    process.env.AWS_BEDROCK_REGION = 'eu-west-1';
    expect(getTitanRegion()).toBe('eu-west-1');

    delete process.env.AWS_BEDROCK_REGION;
    process.env.AWS_REGION = 'ap-northeast-1';
    expect(getTitanRegion()).toBe('ap-northeast-1');

    delete process.env.AWS_REGION;
    expect(getTitanRegion()).toBe('us-east-1');
  });

  it('defaults to the Titan v2 model id and honours an override', () => {
    delete process.env.TITAN_IMAGE_MODEL_ID;
    expect(getTitanModelId()).toBe('amazon.titan-image-generator-v2:0');
    process.env.TITAN_IMAGE_MODEL_ID = 'amazon.titan-image-generator-v1';
    expect(getTitanModelId()).toBe('amazon.titan-image-generator-v1');
  });
});

describe('VTID-03497 configuration gate', () => {
  const original = process.env.BEDROCK_ROLE_ARN;
  afterEach(() => {
    if (original === undefined) delete process.env.BEDROCK_ROLE_ARN;
    else process.env.BEDROCK_ROLE_ARN = original;
  });

  it('generate reports not_configured without BEDROCK_ROLE_ARN', async () => {
    delete process.env.BEDROCK_ROLE_ARN;
    const res = await generateTitanImage({ prompt: 'a calm sunrise', width: 1600, height: 900 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not_configured');
  });

  it('outpaint reports not_configured without BEDROCK_ROLE_ARN', async () => {
    delete process.env.BEDROCK_ROLE_ARN;
    const res = await outpaintTitanImage({
      imagePng: Buffer.from('x'),
      maskPng: Buffer.from('y'),
      prompt: 'extend naturally',
      width: 1280,
      height: 720,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not_configured');
  });
});
