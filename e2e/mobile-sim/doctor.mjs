#!/usr/bin/env node
/**
 * Preflight for the sim-use device-testing layer. Run with:
 *   npm run sim:doctor        (from e2e/)
 *
 * Checks, in order: host OS → sim-use binary → iOS toolchain → Android
 * toolchain → reachable devices. Prints actionable fixes instead of stack
 * traces, and exits 0 with guidance when the host simply can't run the
 * device layer (e.g. the Linux cloud container — use the Playwright mobile
 * projects there instead).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileP = promisify(execFile);
const ok = m => console.log(`  ✓ ${m}`);
const warn = m => console.log(`  ! ${m}`);
const fail = m => console.log(`  ✗ ${m}`);

// Generous timeout: on a cold CI runner (simulator mid-boot, Gatekeeper
// assessing fresh binaries) first invocations can take 15-30s — a tight
// timeout here misreports installed tools as missing (seen on macos-15).
async function has(bin, args = ['--version']) {
  try {
    const { stdout } = await execFileP(bin, args, { timeout: 60_000 });
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

export async function doctor() {
  console.log('sim-use device-testing preflight\n');
  let usable = true;

  // 1. Host OS
  if (process.platform === 'darwin') {
    ok(`macOS ${os.release()} — device layer supported`);
  } else {
    fail(`Host is ${process.platform} — sim-use requires a macOS 14+ host.`);
    console.log(`
  This host cannot run the iOS Simulator or the sim-use CLI.
  Options:
    • Run this suite on a Mac:            cd e2e && npm run test:device
    • Run it in CI (macOS runner):        gh workflow run MOBILE-DEVICE-E2E.yml
    • Viewport-emulation fallback here:   cd e2e && npm run test:mobile
      (Playwright iPhone-14 emulation — same routes, no real device layer)
`);
    return false;
  }

  // 2. sim-use binary
  const simUseVersion = await has('sim-use');
  if (simUseVersion) {
    ok(`sim-use ${simUseVersion}`);
  } else {
    fail('sim-use not found on PATH');
    console.log('    Install: brew tap lycorp-jp/tap && brew install lycorp-jp/tap/sim-use');
    console.log('    (Homebrew 6.0.5+: run `brew trust lycorp-jp/tap` first if the tap is untrusted)');
    usable = false;
  }

  // 3. iOS toolchain
  const xcrun = await has('xcrun', ['simctl', 'help']);
  if (xcrun !== null) {
    ok('xcrun simctl available');
    try {
      const { stdout } = await execFileP('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
      const parsed = JSON.parse(stdout);
      const sims = Object.values(parsed.devices || {}).flat();
      const booted = sims.filter(d => d.state === 'Booted');
      ok(`${sims.length} simulator(s) available, ${booted.length} booted`);
      if (sims.length === 0) warn('Install an iOS runtime via Xcode > Settings > Platforms');
    } catch (err) {
      warn(`could not list simulators: ${err.message}`);
    }
  } else {
    warn('xcrun not available — install Xcode for iOS Simulator support');
  }

  // 4. Android toolchain (optional)
  const adb = await has('adb', ['version']);
  if (adb) {
    ok(adb);
    try {
      const { stdout } = await execFileP('adb', ['devices']);
      const devices = stdout.split('\n').slice(1).filter(l => l.trim().endsWith('device'));
      if (devices.length > 0) {
        ok(`${devices.length} Android device(s) connected`);
        console.log('    First-time setup per device: sim-use android init --device <serial>');
      } else {
        warn('no Android devices/emulators connected (iOS-only is fine)');
      }
    } catch { /* adb server issues — non-fatal */ }
  } else {
    warn('adb not found — Android testing unavailable (iOS-only is fine)');
  }

  // 5. sim-use device view
  if (simUseVersion) {
    try {
      const { stdout } = await execFileP('sim-use', ['devices'], { timeout: 30_000 });
      console.log('\nsim-use devices:');
      console.log(stdout.trim().split('\n').map(l => `  ${l}`).join('\n'));
    } catch (err) {
      warn(`sim-use devices failed: ${err.message}`);
    }
  }

  console.log(usable
    ? '\nReady. Run: npm run test:device -- --url https://preview.vitanaland.com'
    : '\nFix the ✗ items above, then re-run: npm run sim:doctor');
  return usable;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  doctor().then(u => process.exit(u ? 0 : 1));
}
