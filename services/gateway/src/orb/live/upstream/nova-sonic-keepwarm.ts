/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (latency): Bedrock connection keep-warm loop.
 *
 * Why: NodeHttp2Handler pools the HTTP/2 session to the Bedrock endpoint but
 * drops it after 8 idle minutes (sessionTimeout 480s), and STS/task-role
 * credentials also age out of cache. In low-traffic periods that means the
 * NEXT real voice session pays DNS + TCP + TLS + HTTP/2 setup (~100-300ms
 * from eu-central-1 to eu-north-1) before Nova hears any audio. This loop
 * re-fires the zero-cost warm request (see warmNovaSonicConnection — a
 * signed request Bedrock rejects with a fast 4xx before inference) every
 * `keepWarmMs` so the path stays permanently hot.
 *
 * Telemetry discipline: this is a keep-alive, NOT progress — it must never
 * emit OASIS events (CLAUDE.md: "Never mark polling or heartbeats as OASIS
 * events"). One console line per ping, typed outcomes only, no AWS text.
 */

import type { NovaSonicConfig } from './nova-sonic-config';
import { warmNovaSonicConnection } from './nova-sonic-live-client';

export interface NovaKeepWarmDeps {
  /** Injectable warm fn for tests; defaults to warmNovaSonicConnection. */
  warm?: (config: NovaSonicConfig) => Promise<number | null>;
  /** Injectable logger for tests; defaults to console. */
  log?: (line: string) => void;
}

let keepWarmTimer: NodeJS.Timeout | null = null;

export function isNovaKeepWarmRunning(): boolean {
  return keepWarmTimer !== null;
}

/**
 * Start the keep-warm loop. Idempotent — a second start is a no-op while a
 * loop is running. Returns true when a loop is (now) running, false when
 * disabled (keepWarmMs === 0). The timer is unref'd: it never keeps the
 * process alive, and each tick is fully awaited before the next is armed so
 * pings can never pile up behind a slow endpoint.
 */
export function startNovaSonicKeepWarm(config: NovaSonicConfig, deps: NovaKeepWarmDeps = {}): boolean {
  if (keepWarmTimer) return true;
  if (config.keepWarmMs <= 0) return false;
  const warm = deps.warm ?? warmNovaSonicConnection;
  const log = deps.log ?? ((line: string) => console.log(line));

  const arm = () => {
    keepWarmTimer = setTimeout(async () => {
      try {
        const ms = await warm(config);
        if (ms === null) {
          log('[BOOTSTRAP-NOVA-SONIC-VOICE] bedrock keep-warm transport failure (will retry next interval)');
        } else {
          log(`[BOOTSTRAP-NOVA-SONIC-VOICE] bedrock keep-warm ok ms=${ms}`);
        }
      } catch {
        /* warm() never throws by contract; belt-and-braces only */
      }
      // Re-arm only if not stopped while the ping was in flight.
      if (keepWarmTimer) {
        keepWarmTimer = null;
        arm();
      }
    }, config.keepWarmMs);
    keepWarmTimer.unref?.();
  };

  arm();
  return true;
}

export function stopNovaSonicKeepWarm(): void {
  if (keepWarmTimer) {
    clearTimeout(keepWarmTimer);
    keepWarmTimer = null;
  }
}
