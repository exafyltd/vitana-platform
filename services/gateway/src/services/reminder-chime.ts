/**
 * VTID-02601 — Reminder chime PCM generator.
 *
 * 24kHz mono 16-bit PCM, 400ms two-tone bell (C5 → E5), pre-generated once
 * at module load and cached. The same shape used by the ORB activation chime
 * in orb-live.ts (we duplicate to avoid coupling reminder delivery to that
 * module's lifecycle — refactor opportunity later).
 */

let cached: string | null = null;

export function getReminderChimePcmB64(): string {
  if (cached) return cached;

  const sampleRate = 24000;
  const duration = 0.40;
  const totalSamples = Math.floor(sampleRate * duration);
  const buffer = Buffer.alloc(totalSamples * 2);

  const tone1Freq = 523.25; // C5
  const tone2Freq = 659.25; // E5
  const tone1End = 0.15;
  const tone2Start = 0.15;
  const amplitude = 4000;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;

    if (t < tone1End) {
      let env = 1.0;
      if (t < 0.02) env = t / 0.02;
      else if (t > 0.08) env = (tone1End - t) / (tone1End - 0.08);
      sample = Math.sin(2 * Math.PI * tone1Freq * t) * amplitude * env;
    } else if (t >= tone2Start) {
      const t2 = t - tone2Start;
      const tone2Duration = duration - tone2Start;
      let env = 1.0;
      if (t2 < 0.02) env = t2 / 0.02;
      else if (t2 > 0.10) env = (tone2Duration - t2) / (tone2Duration - 0.10);
      sample = Math.sin(2 * Math.PI * tone2Freq * t) * amplitude * env;
    }

    const clamped = Math.max(-32768, Math.min(32767, Math.round(sample)));
    buffer.writeInt16LE(clamped, i * 2);
  }

  cached = buffer.toString('base64');
  console.log(`[reminder-chime] PCM generated: ${totalSamples} samples, ${buffer.length} bytes, ${cached.length} b64 chars`);
  return cached;
}

// Pre-generate at module load
getReminderChimePcmB64();
