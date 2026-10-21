/**
 * Thin Node wrapper around the `sim-use` CLI (https://github.com/lycorp-jp/sim-use).
 *
 * sim-use gives agents "eyes and hands" on iOS Simulators and Android
 * emulators/devices: `ui` reads the screen as a token-efficient accessibility
 * outline, `tap`/`type`/`swipe` act on it. This wrapper shells out to the CLI
 * and parses the `--json` envelopes, so flows can be written as plain
 * observe → act → verify JavaScript.
 *
 * Requires a macOS host with sim-use installed (`brew tap lycorp-jp/tap &&
 * brew install lycorp-jp/tap/sim-use`). Run `npm run sim:doctor` to verify.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
// `ui` on a just-booted simulator pays for the daemon's first FBSimulatorControl
// + accessibility-tree init, which can run well past 60s on a loaded/virtualized
// CI Mac (observed: cold `ui` timing out with no stderr — a bare SIGTERM kill,
// not a reported error). Give the observe path more headroom than fast act calls.
const OBSERVE_TIMEOUT_MS = 120_000;

export class SimUseError extends Error {
  constructor(message, { command, stdout, stderr, hint, timedOut } = {}) {
    super(message);
    this.name = 'SimUseError';
    this.command = command;
    this.stdout = stdout;
    this.stderr = stderr;
    this.hint = hint;
    this.timedOut = timedOut;
  }
}

export class SimUse {
  /**
   * @param {object} opts
   * @param {string} [opts.device]  UDID (iOS Simulator) or serial (Android).
   *                                Optional when exactly one simulator is booted.
   * @param {string} [opts.bin]     Path to the sim-use binary (default: "sim-use" on PATH).
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ device, bin = 'sim-use', log = () => {} } = {}) {
    this.device = device;
    this.bin = bin;
    this.log = log;
  }

  deviceArgs() {
    return this.device ? ['--device', this.device] : [];
  }

  /** Run a raw sim-use command. Returns { stdout, stderr }. */
  async raw(args, { timeoutMs = DEFAULT_TIMEOUT_MS, scoped = true } = {}) {
    const full = scoped ? [...args, ...this.deviceArgs()] : args;
    this.log(`$ ${this.bin} ${full.join(' ')}`);
    try {
      return await execFileP(this.bin, full, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new SimUseError('sim-use binary not found on PATH', {
          command: `${this.bin} ${full.join(' ')}`,
          hint: 'Install on macOS: brew tap lycorp-jp/tap && brew install lycorp-jp/tap/sim-use',
        });
      }
      const timedOut = err.killed === true && (err.signal === 'SIGTERM' || err.signal === 'SIGKILL');
      const detail = [err.stderr?.trim(), err.stdout?.trim()].filter(Boolean).join(' | ');
      throw new SimUseError(
        timedOut
          ? `sim-use command timed out after ${timeoutMs}ms with no output (daemon may still be initialising)`
          : `sim-use command failed: ${detail || err.message}`,
        {
          command: `${this.bin} ${full.join(' ')}`,
          stdout: err.stdout,
          stderr: err.stderr,
          timedOut,
          hint: timedOut ? 'Retry — first `ui` call on a cold simulator can be slow. Persistent timeouts may indicate the sim-use daemon needs a restart (`sim-use daemon stop --all`).' : undefined,
        },
      );
    }
  }

  /** Run a sim-use command with --json and return the parsed data payload. */
  async json(args, opts = {}) {
    const { stdout } = await this.raw([...args, '--json'], { timeoutMs: OBSERVE_TIMEOUT_MS, ...opts });
    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new SimUseError('sim-use returned non-JSON output', {
        command: `${this.bin} ${args.join(' ')} --json`,
        stdout,
      });
    }
    if (envelope.ok === false) {
      throw new SimUseError(envelope.error?.message || 'sim-use reported an error', {
        command: `${this.bin} ${args.join(' ')} --json`,
        hint: envelope.error?.hint,
      });
    }
    return envelope.data ?? envelope;
  }

  async version() {
    const { stdout } = await this.raw(['--version'], { scoped: false });
    return stdout.trim();
  }

  /** List devices sim-use can see (text output, one per line). */
  async devices() {
    const { stdout } = await this.raw(['devices'], { scoped: false });
    return stdout.trim();
  }

  /**
   * Observe: read the current screen.
   * Returns { outline, data } — the compact text outline (for logs/LLM) and
   * the structured JSON envelope data (entries with frames, aliases, lists).
   */
  async ui() {
    const data = await this.json(['ui']);
    const { stdout } = await this.raw(['ui'], { timeoutMs: OBSERVE_TIMEOUT_MS });
    return { outline: stdout.trim(), data };
  }

  /** Outline only — cheapest observe call. Slow on a cold daemon; see OBSERVE_TIMEOUT_MS. */
  async outline({ retries = 0, retryDelayMs = 5000, onRetry } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const { stdout } = await this.raw(['ui'], { timeoutMs: OBSERVE_TIMEOUT_MS });
        return stdout.trim();
      } catch (err) {
        if (attempt >= retries || !err.timedOut) throw err;
        onRetry?.(attempt + 1, err);
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  }

  /**
   * Act: tap an element.
   * @param {object} sel  One of: { alias: '@9' } | { id: 'loginButton' } |
   *                      { label: 'Anmelden' } | { labelContains: 'Sign' } |
   *                      { point: [x, y] }
   * @param {object} [opts] { waitTimeout, preDelay, postDelay, frame, elementType }
   */
  async tap(sel, opts = {}) {
    const args = ['tap'];
    if (sel.alias) args.push(sel.alias.startsWith('@') ? sel.alias : `@${sel.alias}`);
    else if (sel.id) args.push(`#${sel.id.replace(/^#/, '')}`);
    else if (sel.label) args.push('--label', sel.label);
    else if (sel.labelRegex) args.push('--label-regex', sel.labelRegex);
    else if (sel.labelContains) args.push('--label-contains', sel.labelContains);
    else if (sel.point) args.push('--point', `${sel.point[0]},${sel.point[1]}`);
    else throw new SimUseError('tap: no selector given');
    if (opts.waitTimeout) args.push('--wait-timeout', String(opts.waitTimeout));
    if (opts.preDelay) args.push('--pre-delay', String(opts.preDelay));
    if (opts.postDelay) args.push('--post-delay', String(opts.postDelay));
    if (opts.frame) args.push('--frame', opts.frame);
    if (opts.elementType) args.push('--element-type', opts.elementType);
    return this.raw(args);
  }

  /** Type ASCII text into the focused field. Use paste() for Unicode. */
  async type(text) {
    return this.raw(['type', text]);
  }

  /** IME-safe Unicode paste (German umlauts, emoji, …). */
  async paste(text, { replace = false, viaMenu = false, targetId } = {}) {
    const args = ['paste', text];
    if (replace) args.push('--replace');
    if (viaMenu) {
      args.push('--via-menu');
      if (targetId) args.push('--target-id', targetId);
    }
    return this.raw(args);
  }

  async swipe(from, to, { duration } = {}) {
    const args = ['swipe', '--from', `${from[0]},${from[1]}`, '--to', `${to[0]},${to[1]}`];
    if (duration) args.push('--duration', String(duration));
    return this.raw(args);
  }

  /** Gesture presets: scroll-up, scroll-down, swipe-from-left-edge, pinch-out, … */
  async gesture(preset, opts = {}) {
    const args = ['gesture', preset];
    if (opts.preDelay) args.push('--pre-delay', String(opts.preDelay));
    if (opts.postDelay) args.push('--post-delay', String(opts.postDelay));
    return this.raw(args);
  }

  /** Hardware button: home, lock, back (Android), siri, … */
  async button(name) {
    return this.raw(['button', name]);
  }

  /** Screenshot to a file path. Returns the output path. */
  async screenshot(outputPath) {
    const { stdout } = await this.raw(['screenshot', '--output', outputPath]);
    return stdout.trim() || outputPath;
  }

  /**
   * Start an MP4 recording of the device screen (cross-platform).
   * sim-use record-video runs until interrupted and finalises the file on
   * SIGINT, so this spawns it in the background and returns a handle:
   *   const rec = sim.startRecording('run.mp4');
   *   ... drive the device ...
   *   const { ok } = await rec.stop();   // SIGINT + wait for finalise
   * Best-effort by design — callers should treat a failed recording as a
   * warning, never as a failed test run.
   */
  startRecording(outputPath, { fps = 10 } = {}) {
    const args = ['record-video', '--fps', String(fps), '--output', outputPath, ...this.deviceArgs()];
    this.log(`$ ${this.bin} ${args.join(' ')} (background)`);
    const child = spawn(this.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', () => { /* surfaced via exitCode check in stop() */ });
    const exited = new Promise(resolve => child.on('close', code => resolve(code)));
    const killOnExit = () => child.kill('SIGKILL');
    process.once('exit', killOnExit);
    return {
      path: outputPath,
      async stop() {
        process.removeListener('exit', killOnExit);
        if (child.exitCode !== null) {
          return { ok: false, path: outputPath, detail: stderr.trim() || 'recorder exited early' };
        }
        child.kill('SIGINT'); // sim-use finalises the MP4 before exiting
        const code = await Promise.race([
          exited,
          new Promise(r => setTimeout(r, 20_000, 'timeout')),
        ]);
        if (code === 'timeout') {
          child.kill('SIGKILL');
          return { ok: false, path: outputPath, detail: 'finalise timed out after 20s' };
        }
        return { ok: code === 0, path: outputPath, detail: code === 0 ? '' : stderr.trim() };
      },
    };
  }

  /** `soft` | `hidden` — decides between paste default and --via-menu. */
  async keyboardState() {
    const { stdout } = await this.raw(['keyboard-state']);
    return stdout.trim();
  }

  /** App/process liveness. Without bundleId: list of running apps. */
  async appState(bundleId) {
    const args = ['app-state'];
    if (bundleId) args.push('--bundle-id', bundleId);
    const { stdout } = await this.raw(args);
    return stdout.trim();
  }
}

/**
 * Helpers over the `ui --json` envelope.
 * Frames are platform-native units: iOS points, Android pixels — key off
 * `data.platform` before mixing coordinates across platforms.
 */
export const outlineUtils = {
  /** All entries whose role matches (e.g. /TextField/, /Button/). */
  entriesByRole(data, roleRegex) {
    return (data.entries || []).filter(e => roleRegex.test(e.role || e.type || ''));
  },

  /** First entry whose label matches. */
  findByLabel(data, labelRegex) {
    return (data.entries || []).find(e => labelRegex.test(e.label || ''));
  },

  /** Entries in the bottom band of the screen (tab bars, bottom nav). */
  bottomBandEntries(data, band = 0.85) {
    const screenH = data.screen?.height || data.screen?.h;
    if (!screenH) return [];
    return (data.entries || []).filter(e => {
      const y = e.frame?.y ?? e.frame?.minY;
      return typeof y === 'number' && y >= screenH * band;
    });
  },
};
