/**
 * ORB-CONVERSATION-LATENCY — session-establishment latency instrumentation.
 *
 * The conversation-start critical path (click → first greeting audio) is
 * measured by a dedicated turn-0 LatencyTracker on session.establishLatency,
 * separate from the per-turn tracker (the greeting's audio-out has no preceding
 * user turn, so the per-turn tracker never fires for it). This is the
 * `time_to_first_audio_ms` metric the latency work is judged on — if it silently
 * stops being recorded, every before/after comparison goes blind. This file
 * locks the wiring.
 *
 * Contract (services/gateway/src/routes/orb-live.ts):
 *   - The tracker is created before connectToLiveAPI (turn: 0).
 *   - The four establishment phases are marked in path order:
 *       upstream_connected → context_awaited → setup_sent → greeting_sent.
 *   - The first audio-out chunk marks audio_out_first_chunk and finalizes,
 *     and a connect failure finalizes with 'error' (no dangling tracker).
 *   - The phase names exist in the LatencyPhase union.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROUTE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');
const TRACKER_PATH = path.resolve(__dirname, '../../../../src/orb/live/latency-tracker.ts');

let src: string;
let trackerSrc: string;

beforeAll(() => {
  src = fs.readFileSync(ROUTE_PATH, 'utf8');
  trackerSrc = fs.readFileSync(TRACKER_PATH, 'utf8');
});

describe('ORB-CONVERSATION-LATENCY: establishment latency instrumentation', () => {
  it('declares the four establishment phases in the LatencyPhase union', () => {
    for (const phase of ['upstream_connected', 'context_awaited', 'setup_sent', 'greeting_sent']) {
      expect(trackerSrc).toContain(`'${phase}'`);
    }
  });

  it('creates a turn-0 establishment tracker before opening the upstream', () => {
    const idxCreate = src.indexOf('session.establishLatency = new LatencyTracker({');
    const idxConnect = src.indexOf('const liveApiPromise = connectToLiveAPI(');
    expect(idxCreate).toBeGreaterThan(-1);
    expect(idxConnect).toBeGreaterThan(idxCreate);
    // turn: 0 distinguishes establishment from the 1-based per-turn trackers.
    const createBlock = src.slice(idxCreate, idxCreate + 300);
    expect(createBlock).toMatch(/turn:\s*0/);
  });

  it('marks the establishment phases in path order', () => {
    const idxUpstream = src.indexOf("establishLatency?.mark('upstream_connected')");
    const idxContext = src.indexOf("establishLatency?.mark('context_awaited'");
    const idxSetup = src.indexOf("establishLatency?.mark('setup_sent'");
    const idxGreeting = src.indexOf("establishLatency?.mark('greeting_sent'");
    expect(idxUpstream).toBeGreaterThan(-1);
    expect(idxContext).toBeGreaterThan(idxUpstream);
    expect(idxSetup).toBeGreaterThan(idxContext);
    // greeting_sent fires in the connect-resolution block; it lives after the
    // envelope builder (setup_sent) in the file as well.
    expect(idxGreeting).toBeGreaterThan(idxSetup);
  });

  it('finalizes on first audio-out chunk and clears the tracker', () => {
    const idxMark = src.indexOf("establishLatency.mark('audio_out_first_chunk'");
    expect(idxMark).toBeGreaterThan(-1);
    const block = src.slice(idxMark, idxMark + 200);
    expect(block).toMatch(/establishLatency\.finalize\('success'\)/);
    expect(block).toMatch(/session\.establishLatency = null;/);
  });

  it('finalizes with error on connect failure so no tracker dangles', () => {
    expect(src).toMatch(/establishLatency\.finalize\('error',\s*err\?\.message\)/);
  });
});
