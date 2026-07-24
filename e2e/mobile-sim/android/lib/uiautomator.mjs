/**
 * Native Android device driver — adb + uiautomator, no sim-use, no macOS.
 *
 * sim-use itself is a macOS-only Swift binary (Xcode/idb toolchain) —
 * that's true even for the platforms it drives *other* than iOS, so it
 * cannot run Android testing from a Mac-less host either. `adb` and
 * `uiautomator` are both first-class parts of the Android platform and
 * work identically on Linux, macOS, and Windows, which is what makes a
 * fully Mac-free device-testing path possible at all:
 *
 *  - `uiautomator dump` — serializes the on-screen accessibility tree to
 *    XML (this is Android's OS-level equivalent of what sim-use's `ui`
 *    walks via AX APIs on iOS — for a page rendered in Chrome, that
 *    includes the WebView's exposed accessibility nodes).
 *  - `input tap/text/keyevent` — synthesizes touch/keyboard events.
 *  - `screencap` / `screenrecord` — screenshot / video, built into the
 *    OS image, no extra process to race against anything.
 *
 * Every method here shells out to `adb -s <serial> ...`, so it works
 * against a GitHub Actions-hosted emulator (ubuntu-latest + KVM) exactly
 * as it would against a local emulator or a USB-attached device.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';

const execFileP = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;

export class AdbError extends Error {
  constructor(message, { command, stderr, hint } = {}) {
    super(message);
    this.name = 'AdbError';
    this.command = command;
    this.stderr = stderr;
    this.hint = hint;
  }
}

// uiautomator dumps the whole tree as a single line of XML. Every element —
// leaf or container — opens with `<node ...`, whether it then self-closes
// (`/>`) or wraps children (`>...</node>`). Attributes always sit on that
// same `<node` tag, so a single pass over `<node\b[^>]*>` occurrences,
// regardless of nesting, yields every element with its attributes intact.
// We don't need parent/child structure — only a flat list of elements with
// text/role/bounds to pick a tap target from.
const NODE_TAG_RE = /<node\b[^>]*>/g;
const ATTR_RE = /(\w[\w-]*)="((?:[^"\\]|\\.)*)"/g;
const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

function unescapeXml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Parse a uiautomator XML dump into a flat list of elements. */
export function parseDump(xml) {
  const entries = [];
  let m;
  NODE_TAG_RE.lastIndex = 0;
  while ((m = NODE_TAG_RE.exec(xml))) {
    const tag = m[0];
    const attrs = {};
    let a;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(tag))) attrs[a[1]] = unescapeXml(a[2]);

    const boundsMatch = BOUNDS_RE.exec(attrs.bounds || '');
    const bounds = boundsMatch
      ? {
          x1: Number(boundsMatch[1]), y1: Number(boundsMatch[2]),
          x2: Number(boundsMatch[3]), y2: Number(boundsMatch[4]),
        }
      : null;

    entries.push({
      text: attrs.text || '',
      contentDesc: attrs['content-desc'] || '',
      className: attrs.class || '',
      resourceId: attrs['resource-id'] || '',
      packageName: attrs.package || '',
      clickable: attrs.clickable === 'true',
      enabled: attrs.enabled === 'true',
      focusable: attrs.focusable === 'true',
      password: attrs.password === 'true',
      scrollable: attrs.scrollable === 'true',
      bounds,
      center: bounds
        ? [Math.round((bounds.x1 + bounds.x2) / 2), Math.round((bounds.y1 + bounds.y2) / 2)]
        : null,
    });
  }
  return entries;
}

/** Human-readable label for an entry — text wins, falls back to content-desc. */
export function label(entry) {
  return (entry.text || entry.contentDesc || '').trim();
}

export class UiAutomatorDriver {
  /**
   * @param {object} opts
   * @param {string} opts.serial   adb device serial (e.g. emulator-5554)
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ serial, log = () => {} }) {
    if (!serial) throw new AdbError('UiAutomatorDriver requires a device serial');
    this.serial = serial;
    this.log = log;
  }

  async adb(args, { timeoutMs = DEFAULT_TIMEOUT_MS, encoding = 'utf8' } = {}) {
    const full = ['-s', this.serial, ...args];
    this.log(`$ adb ${full.join(' ')}`);
    try {
      return await execFileP('adb', full, {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        encoding,
      });
    } catch (err) {
      throw new AdbError(`adb command failed: ${err.stderr?.toString().trim() || err.message}`, {
        command: `adb ${full.join(' ')}`,
        stderr: err.stderr?.toString(),
      });
    }
  }

  /** Dump the current screen's accessibility tree as a flat element list. */
  async dump() {
    await this.adb(['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml']);
    const { stdout } = await this.adb(['shell', 'cat', '/sdcard/window_dump.xml']);
    return parseDump(stdout);
  }

  /** Tappable/text elements with a non-empty label — the practical outline. */
  async visibleEntries() {
    return (await this.dump()).filter(e => label(e).length > 0 || e.className.includes('EditText'));
  }

  async tapPoint(x, y) {
    await this.adb(['shell', 'input', 'tap', String(x), String(y)]);
  }

  async tapEntry(entry) {
    if (!entry.center) throw new AdbError('tapEntry: element has no bounds to tap');
    await this.tapPoint(...entry.center);
  }

  /**
   * Tap the first entry whose label matches (case-insensitive substring by
   * default, or a RegExp for exact/anchored matching).
   */
  async tapLabel(matcher, { optional = false } = {}) {
    const entries = await this.visibleEntries();
    const test = matcher instanceof RegExp
      ? e => matcher.test(label(e))
      : e => label(e).toLowerCase().includes(String(matcher).toLowerCase());
    const found = entries.find(e => e.clickable && test(e)) || entries.find(test);
    if (!found) {
      if (optional) return false;
      throw new AdbError(`tapLabel: no element matching ${matcher} found on screen`);
    }
    await this.tapEntry(found);
    return true;
  }

  /** ASCII text input. `adb shell input text` cannot express arbitrary Unicode. */
  async typeText(text) {
    // %s = space; input text splits on unescaped spaces otherwise.
    const escaped = text.replace(/\s/g, '%s').replace(/(['"$`\\])/g, '\\$1');
    await this.adb(['shell', 'input', 'text', escaped]);
  }

  async pressBack() {
    await this.adb(['shell', 'input', 'keyevent', '4']); // KEYCODE_BACK
  }

  async pressKeyevent(code) {
    await this.adb(['shell', 'input', 'keyevent', String(code)]);
  }

  /** Open a URL in Chrome specifically (avoids the app-chooser dialog). */
  async openUrl(url) {
    await this.adb([
      'shell', 'am', 'start',
      '-a', 'android.intent.action.VIEW',
      '-d', url,
      '-p', 'com.android.chrome',
    ]);
  }

  async screenshot(outputPath) {
    const { stdout } = await this.adb(['exec-out', 'screencap', '-p'], { encoding: 'buffer' });
    writeFileSync(outputPath, stdout);
    return outputPath;
  }

  /** { width, height } in pixels, via `wm size`. Used for bottom-band nav detection. */
  async screenSize() {
    const { stdout } = await this.adb(['shell', 'wm', 'size']);
    const m = /(\d+)x(\d+)/.exec(stdout);
    if (!m) throw new AdbError(`wm size: unparseable output: ${stdout.trim()}`);
    return { width: Number(m[1]), height: Number(m[2]) };
  }

  /** Foreground package name, via the focused-window dump — crude crash/liveness check. */
  async foregroundPackage() {
    const { stdout } = await this.adb(['shell', 'dumpsys', 'window', 'windows']);
    const m = /mCurrentFocus=Window\{[^ ]+ [^ ]+ ([\w.]+)\//.exec(stdout)
      || /mFocusedApp=.*?\s([\w.]+)\/[\w.]+/.exec(stdout);
    return m ? m[1] : null;
  }

  /**
   * Start `adb shell screenrecord` in the background. Android caps a single
   * invocation's length (commonly ~180s) — good enough to capture app-load
   * + login without the multi-file-concat complexity of chaining segments.
   */
  startRecording(outputLocalPath, { timeLimitSec = 170 } = {}) {
    const serial = this.serial;
    const remote = '/sdcard/session.mp4';
    const args = [
      '-s', serial, 'shell', 'screenrecord',
      '--time-limit', String(timeLimitSec),
      remote,
    ];
    this.log(`$ adb ${args.join(' ')} (background)`);
    const child = spawn('adb', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    const exited = new Promise(resolve => child.on('close', code => resolve(code)));
    const killOnExit = () => child.kill('SIGKILL');
    process.once('exit', killOnExit);
    return {
      async stop() {
        process.removeListener('exit', killOnExit);
        if (child.exitCode !== null) {
          return { ok: false, detail: stderr.trim() || 'recorder exited early' };
        }
        child.kill('SIGINT'); // screenrecord finalises the mp4 on SIGINT
        const code = await Promise.race([
          exited,
          new Promise(r => setTimeout(r, 15_000, 'timeout')),
        ]);
        if (code === 'timeout') return { ok: false, detail: 'finalise timed out after 15s' };
        try {
          await execFileP('adb', ['-s', serial, 'pull', remote, outputLocalPath], { timeout: 30_000 });
          return { ok: true, path: outputLocalPath };
        } catch (err) {
          return { ok: false, detail: `pull failed: ${err.message}` };
        }
      },
    };
  }
}
