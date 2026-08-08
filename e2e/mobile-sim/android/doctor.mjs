#!/usr/bin/env node
/**
 * Preflight for the Android device-testing layer. Run with:
 *   npm run sim:doctor:android        (from e2e/)
 *
 * Unlike the iOS/sim-use layer, this one needs no macOS host — adb and
 * uiautomator are cross-platform, so this runs the same on Linux, macOS,
 * or an Android emulator booted inside a GitHub Actions ubuntu-latest
 * runner (see .github/workflows/ANDROID-DEVICE-E2E.yml).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ok = m => console.log(`  ✓ ${m}`);
const warn = m => console.log(`  ! ${m}`);
const fail = m => console.log(`  ✗ ${m}`);

async function has(bin, args = ['--version']) {
  try {
    const { stdout } = await execFileP(bin, args, { timeout: 15_000 });
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

export async function doctor() {
  console.log('Android device-testing preflight\n');
  let usable = true;

  const adbVersion = await has('adb', ['version']);
  if (adbVersion) {
    ok(adbVersion);
  } else {
    fail('adb not found on PATH');
    console.log(
      '    Install: Android SDK platform-tools ' +
      '(https://developer.android.com/tools/releases/platform-tools)\n' +
      '    On GitHub Actions ubuntu-latest, use reactivecircus/android-emulator-runner ' +
      '(installs adb + boots an emulator with KVM).',
    );
    usable = false;
  }

  if (adbVersion) {
    try {
      const { stdout } = await execFileP('adb', ['devices'], { timeout: 15_000 });
      const devices = stdout
        .split('\n')
        .slice(1)
        .map(l => l.trim())
        .filter(l => l.endsWith('device'))
        .map(l => l.split(/\s+/)[0]);
      if (devices.length > 0) {
        ok(`${devices.length} device(s)/emulator(s) connected: ${devices.join(', ')}`);
      } else {
        fail('no devices/emulators connected (adb devices is empty)');
        console.log(
          '    Start an emulator (e.g. `emulator -avd <name>`) or plug in a device ' +
          'with USB debugging enabled.',
        );
        usable = false;
      }
    } catch (err) {
      warn(`adb devices failed: ${err.message}`);
      usable = false;
    }
  }

  console.log(usable
    ? '\nReady. Run: npm run test:device:android -- --url https://preview.vitanaland.com/maxina'
    : '\nFix the ✗ items above, then re-run: npm run sim:doctor:android');
  return usable;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  doctor().then(u => process.exit(u ? 0 : 1));
}
