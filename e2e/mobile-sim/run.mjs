#!/usr/bin/env node
/**
 * Entry point for device-level frontend testing via sim-use.
 *
 *   node run.mjs [--platform ios|android] [--device <UDID|serial>]
 *                [--url <app url>] [--flow smoke|observe] [--out <dir>]
 *
 * Defaults: iOS Simulator (auto-boot), staging URL, smoke flow.
 * Credentials for the UI login: TEST_USER_EMAIL / TEST_USER_PASSWORD
 * (same envs as the Playwright fixtures). Without a password the run
 * continues unauthenticated and only covers public screens.
 *
 * Examples:
 *   npm run test:device                                  # iOS, staging, smoke
 *   npm run test:device -- --url https://vitanaland.com  # against prod
 *   npm run test:device:android -- --device emulator-5554
 *   npm run test:device -- --flow observe                # eyes only, no taps
 */
import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimUse } from './lib/simuse.mjs';
import { resolveDevice } from './lib/device.mjs';
import { RunReport } from './lib/report.mjs';
import { smokeFlow, observeFlow } from './flows/smoke.mjs';
import { doctor } from './doctor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// The bare root ("/") is the multi-tenant portal-selector grid (Maxina /
// AlKalma / Earthlinks / Exafy Admin cards) — no login form, no bottom nav.
// The actual community app + auth form lives at /maxina (src/pages/portals/
// MaxinaPortal.tsx). Default there so the smoke flow reaches a real login
// screen instead of the portal chooser.
const DEFAULT_URL =
  (process.env.COMMUNITY_URL || 'https://preview.vitanaland.com').replace(/\/$/, '') + '/maxina';

const { values: args } = parseArgs({
  options: {
    platform: { type: 'string', default: 'ios' },
    device: { type: 'string' },
    url: { type: 'string', default: DEFAULT_URL },
    flow: { type: 'string', default: 'smoke' },
    out: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (args.help) {
  console.log(
    'Usage: node run.mjs [--platform ios|android] [--device ID] ' +
    '[--url URL] [--flow smoke|observe] [--out DIR]',
  );
  process.exit(0);
}

async function main() {
  if (process.platform !== 'darwin') {
    // doctor() prints the full explanation + fallback options
    await doctor();
    process.exit(2);
  }

  const { device, platform } = await resolveDevice({
    platform: args.platform,
    device: args.device,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = args.out || join(HERE, 'artifacts', `${platform}-${stamp}`);
  const report = new RunReport(outDir);
  // optional debug flag — never required by any workflow or deploy config
  const verbose = (process.env.SIM_USE_VERBOSE ?? '') !== '';
  const sim = new SimUse({ device, log: msg => verbose && console.error(msg) });

  console.error(`Device: ${device} (${platform})  URL: ${args.url}  Flow: ${args.flow}\n`);

  // Record the whole session as MP4 (best-effort — a broken recorder must
  // never fail the test run). Lands in the artifacts dir as session.mp4.
  //
  // Started lazily by the flow itself, AFTER the first successful `ui` call
  // has warmed the per-UDID daemon — starting `record-video` concurrently
  // with the daemon's cold init raced and left the daemon socket completely
  // unreachable in CI (observed: "Timed out after 5.0s waiting for daemon
  // socket"). Sequencing costs the first few seconds of the video, which is
  // a fine trade against the run reliably working at all.
  const recordingHandle = { instance: null };
  const beginRecording = () => {
    if (recordingHandle.instance) return;
    try {
      recordingHandle.instance = sim.startRecording(join(outDir, 'session.mp4'));
    } catch { /* recording unavailable — flow still runs */ }
  };

  const ctx = {
    sim,
    report,
    device,
    platform,
    url: args.url,
    email: process.env.TEST_USER_EMAIL || 'e2e-test@vitana.dev',
    // Same fallback as e2e/fixtures/test-users.ts — shared e2e test account
    password: process.env.TEST_USER_PASSWORD || 'VitanaE2eTest2026!',
    beginRecording,
  };

  try {
    if (args.flow === 'observe') await observeFlow(ctx);
    else await smokeFlow(ctx);
  } finally {
    if (recordingHandle.instance) {
      const res = await recordingHandle.instance.stop();
      report.record({
        label: 'session video',
        ok: true, // informational — never fails the run
        detail: res.ok ? 'session.mp4' : `recording unavailable: ${res.detail}`,
      });
    } else {
      report.record({
        label: 'session video',
        ok: true,
        detail: 'recording never started — daemon warmup did not complete',
      });
    }
  }

  const summary = report.finish({ device, platform, url: args.url });
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  if (err.command) console.error(`Command: ${err.command}`);
  if (err.stderr?.trim()) console.error(`Stderr: ${err.stderr.trim()}`);
  if (err.hint) console.error(`Hint: ${err.hint}`);
  process.exit(1);
});
