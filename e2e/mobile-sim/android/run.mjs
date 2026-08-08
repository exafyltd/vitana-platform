#!/usr/bin/env node
/**
 * Entry point for Android device-level frontend testing — adb + uiautomator,
 * no sim-use, no macOS required anywhere. Runs the same on a local emulator/
 * device, a self-hosted Linux box, or (default CI path) an emulator booted
 * inside a GitHub Actions ubuntu-latest runner via
 * .github/workflows/ANDROID-DEVICE-E2E.yml.
 *
 *   node run.mjs [--device <serial>] [--url <app url>]
 *                [--flow smoke|observe] [--out <dir>]
 *
 * Examples:
 *   npm run test:device:android                          # default device, staging, smoke
 *   npm run test:device:android -- --device emulator-5554
 *   npm run test:device:android -- --flow observe
 */
import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UiAutomatorDriver } from './lib/uiautomator.mjs';
import { RunReport } from '../lib/report.mjs';
import { smokeFlow, observeFlow } from './flows/smoke.mjs';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

// Same portal-selector-vs-app distinction as the iOS default — see
// ../run.mjs for the full rationale (src/pages/Index.tsx vs. MaxinaPortal.tsx).
const DEFAULT_URL =
  (process.env.COMMUNITY_URL || 'https://preview.vitanaland.com').replace(/\/$/, '') + '/maxina';

const { values: args } = parseArgs({
  options: {
    device: { type: 'string' },
    url: { type: 'string', default: DEFAULT_URL },
    flow: { type: 'string', default: 'smoke' },
    out: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (args.help) {
  console.log('Usage: node run.mjs [--device SERIAL] [--url URL] [--flow smoke|observe] [--out DIR]');
  process.exit(0);
}

async function resolveSerial(preferred) {
  if (preferred) return preferred;
  const { stdout } = await execFileP('adb', ['devices'], { timeout: 15_000 });
  const serials = stdout
    .split('\n')
    .slice(1)
    .map(l => l.trim())
    .filter(l => l.endsWith('device'))
    .map(l => l.split(/\s+/)[0]);
  if (serials.length === 0) {
    throw new Error(
      'No Android devices/emulators connected (adb devices is empty). ' +
      'Start an emulator or plug in a device with USB debugging enabled.',
    );
  }
  return serials[0];
}

async function main() {
  const serial = await resolveSerial(args.device);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = args.out || join(HERE, '..', 'artifacts', `android-${stamp}`);
  const report = new RunReport(outDir);
  const verbose = (process.env.SIM_USE_VERBOSE ?? '') !== '';
  const driver = new UiAutomatorDriver({ serial, log: msg => verbose && console.error(msg) });

  console.error(`Device: ${serial} (android)  URL: ${args.url}  Flow: ${args.flow}\n`);

  // Recording is native `adb shell screenrecord` — no daemon, nothing to
  // race against. Still deferred to right after the first successful
  // observe, both for consistency with the iOS driver and because it's a
  // pointless recording if the device never responds at all.
  const recordingHandle = { instance: null };
  const beginRecording = () => {
    if (recordingHandle.instance) return;
    try {
      recordingHandle.instance = driver.startRecording(join(outDir, 'session.mp4'));
    } catch { /* recording unavailable — flow still runs */ }
  };

  const ctx = {
    driver,
    report,
    url: args.url,
    email: process.env.TEST_USER_EMAIL || 'e2e-test@vitana.dev',
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
        ok: true,
        detail: res.ok ? 'session.mp4' : `recording unavailable: ${res.detail}`,
      });
    } else {
      report.record({
        label: 'session video',
        ok: true,
        detail: 'recording never started — device warmup did not complete',
      });
    }
  }

  const summary = report.finish({ device: serial, platform: 'android', url: args.url });
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  if (err.command) console.error(`Command: ${err.command}`);
  if (err.stderr?.trim()) console.error(`Stderr: ${err.stderr.trim()}`);
  process.exit(1);
});
