/**
 * Nova item 6 — disconnect reasons must be readable.
 *
 * 72h of production showed 42 of 46 Nova sessions labelled only 'local_close',
 * which made the disconnect cause unreadable: a user tapping stop, a mobile
 * transport dropping, a rotation swap, and a session being superseded all
 * collapsed into one bucket.
 *
 * Two guards here:
 *  1. The client normalizes a reason-less close to an explicitly *unnamed*
 *     label, so a close path added without a reason is visible in telemetry
 *     rather than blending into the historical catch-all.
 *  2. A source invariant: no `upstreamWs.close()` call site may omit its
 *     reason. This is what actually regresses — the reason is supplied by the
 *     caller, so the guard has to live at the call sites, not in the client.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../../src');

describe('Nova item 6: close-reason taxonomy', () => {
  it('normalizes a reason-less close to an explicitly unnamed label, not the old catch-all', () => {
    const client = readFileSync(
      join(SRC, 'orb/live/upstream/nova-sonic-live-client.ts'),
      'utf8',
    );
    // The fallback must not be the historical 'local_close' bucket.
    expect(client).toContain("this.localCloseReason = reason ?? 'local_close_unspecified'");
    expect(client).not.toMatch(/localCloseReason = reason \?\? 'local_close'/);
  });

  it('reports the same label on both close paths (no race-dependent reason)', () => {
    const client = readFileSync(
      join(SRC, 'orb/live/upstream/nova-sonic-live-client.ts'),
      'utf8',
    );
    // close() must finalize with the NORMALIZED reason. Passing the raw arg
    // makes a bare close() surface as `undefined` on one path and
    // 'local_close_unspecified' on the other, depending on which wins.
    expect(client).toContain(
      'this.finalizeClose({ initiatedLocally: true, reason: this.localCloseReason })',
    );
  });

  it('emits a structured close line carrying the fields the incident needed', () => {
    const client = readFileSync(
      join(SRC, 'orb/live/upstream/nova-sonic-live-client.ts'),
      'utf8',
    );
    for (const field of [
      'nova_close reason=',
      'initiated_locally=',
      'rotation_fired=',
      'ms_since_last_input=',
      'commit=',
    ]) {
      expect(client).toContain(field);
    }
  });

  it('has no upstreamWs.close() call site that omits its reason', () => {
    // grep -r over the gateway source; an empty result is the passing state.
    let hits = '';
    try {
      hits = execSync(
        `grep -rn "upstreamWs\\.close()" ${SRC} --include=*.ts || true`,
        { encoding: 'utf8' },
      ).trim();
    } catch {
      hits = '';
    }
    expect(hits).toBe('');
  });

  it('names each distinct disconnect cause at its call site', () => {
    const controller = readFileSync(
      join(SRC, 'orb/live/session/live-session-controller.ts'),
      'utf8',
    );
    const orbLive = readFileSync(join(SRC, 'routes/orb-live.ts'), 'utf8');
    const handler = readFileSync(
      join(SRC, 'orb/live/session/upstream-message-handler.ts'),
      'utf8',
    );

    expect(controller).toContain("'ws_session_cleanup'");
    expect(controller).toContain("'user_stop'");
    // VTID-03510: the zombie sweep used to have exactly one cause
    // ('zombie_sweep_max_age' — 30-minute age). It now distinguishes three,
    // and the upstream close code carries whichever fired via
    // `zombie_sweep_${closeReason}`. The taxonomy this test guards therefore
    // got FINER, not coarser, so assert all three by name rather than
    // loosening the check to a prefix match.
    expect(orbLive).toContain('`zombie_sweep_${closeReason}`');
    expect(orbLive).toContain("'expired_ttl'");
    expect(orbLive).toContain("'idle_no_engagement'");
    expect(orbLive).toContain("'idle_timeout'");
    expect(orbLive).toContain("'superseded_by_new_session'");
    expect(orbLive).toContain("'client_disconnect'");
    expect(orbLive).toContain("'user_stop'");
    expect(handler).toContain("'persona_drift_reanchor'");
  });
});
