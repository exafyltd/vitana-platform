/**
 * Device discovery, boot, and URL-opening for the two backends sim-use drives:
 *  - iOS Simulator  → `xcrun simctl` (UDID-shaped device IDs)
 *  - Android        → `adb` (serial-shaped device IDs, e.g. emulator-5554)
 *
 * The Vitana frontend is a web app, so "opening the app" means opening
 * COMMUNITY_URL in the device browser (Safari / Chrome). From there sim-use
 * drives the real rendered UI through the platform accessibility tree —
 * including the WebView content, which sim-use walks without skipping.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const IOS_UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export function platformForDevice(deviceId) {
  return IOS_UDID_RE.test(deviceId) ? 'ios' : 'android';
}

// ── iOS Simulator ────────────────────────────────────────────────────────────

export async function listIosSimulators() {
  const { stdout } = await execFileP('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
  const parsed = JSON.parse(stdout);
  const devices = [];
  for (const [runtime, list] of Object.entries(parsed.devices || {})) {
    for (const d of list) {
      devices.push({ udid: d.udid, name: d.name, state: d.state, runtime });
    }
  }
  return devices;
}

/** Find a booted iPhone, or boot one (preferring `preferName`). Returns UDID. */
export async function ensureIosSimulator({ preferName = 'iPhone', log = console.error } = {}) {
  const devices = await listIosSimulators();
  const iphones = devices.filter(d => d.name.includes('iPhone'));
  if (iphones.length === 0) {
    throw new Error('No available iPhone simulators. Install an iOS runtime via Xcode.');
  }
  const booted = iphones.find(d => d.state === 'Booted');
  if (booted) {
    log(`Using booted simulator: ${booted.name} (${booted.udid})`);
    return booted.udid;
  }
  const pick =
    iphones.find(d => d.name === preferName) ||
    iphones.find(d => d.name.includes(preferName)) ||
    iphones[iphones.length - 1]; // newest runtime tends to sort last
  log(`Booting simulator: ${pick.name} (${pick.udid})`);
  await execFileP('xcrun', ['simctl', 'boot', pick.udid]).catch(err => {
    if (!/current state: Booted/.test(String(err.stderr))) throw err;
  });
  await execFileP('xcrun', ['simctl', 'bootstatus', pick.udid, '-b'], { timeout: 180_000 });
  return pick.udid;
}

export async function openUrlIos(udid, url) {
  await execFileP('xcrun', ['simctl', 'openurl', udid, url]);
}

// ── Android emulator / device ────────────────────────────────────────────────

export async function listAndroidDevices() {
  const { stdout } = await execFileP('adb', ['devices']);
  return stdout
    .split('\n')
    .slice(1)
    .map(l => l.trim())
    .filter(l => l.endsWith('device'))
    .map(l => l.split(/\s+/)[0]);
}

export async function openUrlAndroid(serial, url) {
  await execFileP('adb', [
    '-s', serial,
    'shell', 'am', 'start',
    '-a', 'android.intent.action.VIEW',
    '-d', url,
  ]);
}

// ── Unified ──────────────────────────────────────────────────────────────────

/**
 * Resolve a target device for the requested platform.
 * Returns { device, platform }.
 */
export async function resolveDevice({ platform, device, log = console.error }) {
  if (device) return { device, platform: platform || platformForDevice(device) };

  if (platform === 'android') {
    const serials = await listAndroidDevices();
    if (serials.length === 0) {
      throw new Error(
        'No Android devices/emulators connected (adb devices is empty). ' +
        'Start an emulator or plug in a device with USB debugging, then run ' +
        '`sim-use android init --device <serial>` once to install the bridge APK.',
      );
    }
    log(`Using Android device: ${serials[0]}`);
    return { device: serials[0], platform: 'android' };
  }

  // default: iOS Simulator
  const udid = await ensureIosSimulator({ log });
  return { device: udid, platform: 'ios' };
}

export async function openUrl({ device, platform, url }) {
  if (platform === 'ios') return openUrlIos(device, url);
  return openUrlAndroid(device, url);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
