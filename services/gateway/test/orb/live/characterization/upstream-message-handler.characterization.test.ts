/**
 * Originally A8.3a.1 — structural characterization for the upstream Live
 * message-handler closure inside `routes/orb-live.ts`.
 * Updated 2026-05-13 (A8.3a.2 / VTID-02968): the named function body was
 * lifted into `orb/live/session/upstream-message-handler.ts` as a factory
 * (`createUpstreamLiveMessageHandler`). orb-live.ts now calls the factory
 * with a deps-bag + context-bag and registers the returned handler.
 *
 * Assertions now read from BOTH files:
 *   - The new module owns the function body — all upstream event paths
 *     and dispatch calls live there.
 *   - orb-live.ts is the consumer — its connectToLiveAPI body must call
 *     `createUpstreamLiveMessageHandler({...})` and register the returned
 *     handler via `ws.on('message', handleUpstreamLiveMessage)`.
 *
 * Runtime behavior is preserved (same body, same dispatches, same SSE
 * writes through `writeSseEvent`). Closure variables flow through
 * `ctx.onSetupComplete()` / `ctx.isSetupComplete()` instead of direct
 * mutation, but the orb-live.ts wiring calls these callbacks in the same
 * order the original closure mutated them.
 */

import * as fs from 'fs';
import * as path from 'path';

const ORB_LIVE_PATH = path.resolve(__dirname, '../../../../src/routes/orb-live.ts');
const HANDLER_PATH = path.resolve(
  __dirname,
  '../../../../src/orb/live/session/upstream-message-handler.ts',
);

let orbLiveSrc: string;
let handlerSrc: string;
let handlerBody: string;

beforeAll(() => {
  orbLiveSrc = fs.readFileSync(ORB_LIVE_PATH, 'utf8');
  handlerSrc = fs.readFileSync(HANDLER_PATH, 'utf8');

  // Slice from `function handleUpstreamLiveMessage` (the inner function
  // declared by the factory) to the factory's `return handleUpstreamLiveMessage;`.
  const fnStart = handlerSrc.indexOf('function handleUpstreamLiveMessage');
  expect(fnStart).toBeGreaterThan(0);
  const fnEnd = handlerSrc.indexOf(
    'return handleUpstreamLiveMessage;',
    fnStart,
  );
  expect(fnEnd).toBeGreaterThan(fnStart);
  handlerBody = handlerSrc.slice(fnStart, fnEnd);
});

describe('A8.3a.2: upstream-message-handler module owns the function body', () => {
  it('exports the factory `createUpstreamLiveMessageHandler`', () => {
    expect(handlerSrc).toMatch(
      /export\s+function\s+createUpstreamLiveMessageHandler\s*\(/,
    );
  });

  it('declares the inner handler with the canonical name + signature', () => {
    expect(handlerBody).toMatch(
      /function\s+handleUpstreamLiveMessage\s*\(\s*data\s*:\s*WebSocket\.Data\s*\)/,
    );
  });

  it('still handles every event path (setup_complete, server_content, tool_call, interruption, turn_complete, transcripts)', () => {
    expect(handlerBody).toMatch(/setup_complete\b/);
    expect(handlerBody).toMatch(/server_content\b/);
    expect(handlerBody).toMatch(/tool_call\b/);
    expect(handlerBody).toMatch(/interrupted\b/);
    expect(handlerBody).toMatch(/turn_complete\b/);
    expect(handlerBody).toMatch(/input_transcription\b/);
    expect(handlerBody).toMatch(/output_transcription\b/);
  });

  it('invokes user callbacks via ctx.callbacks (audio, interrupted, turn-complete)', () => {
    expect(handlerBody).toMatch(/ctx\.callbacks\.onAudioResponse\s*\(/);
    expect(handlerBody).toMatch(/ctx\.callbacks\.onInterrupted\?\.\(/);
    expect(handlerBody).toMatch(/ctx\.callbacks\.onTurnComplete\?\.\(/);
  });

  it('uses ctx.onSetupComplete() on the setup_complete branch (replaces inline setupComplete / clearTimeout / resolve)', () => {
    expect(handlerBody).toMatch(/ctx\.onSetupComplete\s*\(\s*\)/);
    // Anti-regression: original closure-variable mutations must NOT
    // reappear inside the lifted body.
    expect(handlerBody).not.toMatch(/setupComplete\s*=\s*true/);
    expect(handlerBody).not.toMatch(/clearTimeout\s*\(\s*connectionTimeout\s*\)/);
  });

  it('uses writeSseEvent for SSE output (A9.2 wire helper)', () => {
    expect(handlerBody).not.toMatch(/session\.sseResponse\.write\s*\(/);
    expect(handlerBody).toMatch(/writeSseEvent\s*\(\s*session\.sseResponse\s*,/);
  });

  it('routes all orb-live.ts-local helpers through ctx.deps.*', () => {
    // Spot-check a handful of dep names — they must NOT appear unprefixed
    // inside the body (which would mean an unresolved module-level ref).
    const depsToCheck = [
      'clearResponseWatchdog',
      'emitDiag',
      'emitLiveSessionEvent',
      'sendAudioToLiveAPI',
      'startResponseWatchdog',
    ];
    for (const name of depsToCheck) {
      expect(handlerBody).toMatch(new RegExp(`ctx\\.deps\\.${name}\\s*\\(`));
    }
  });
});

describe('A8.3a.2: orb-live.ts is a thin consumer of the factory', () => {
  it('imports createUpstreamLiveMessageHandler from the new module', () => {
    expect(orbLiveSrc).toMatch(
      /from\s*['"`][^'"`]*\/orb\/live\/session\/upstream-message-handler['"`]/,
    );
    expect(orbLiveSrc).toMatch(/\bcreateUpstreamLiveMessageHandler\b/);
  });

  it('builds the handler via the factory with session, ws, callbacks, onSetupComplete, isSetupComplete, deps', () => {
    expect(orbLiveSrc).toMatch(
      /createUpstreamLiveMessageHandler\s*\(\s*\{[\s\S]*?session[\s\S]*?ws[\s\S]*?callbacks[\s\S]*?onSetupComplete[\s\S]*?isSetupComplete[\s\S]*?deps[\s\S]*?\}\s*\)/,
    );
  });

  it('still registers via ws.on("message", handleUpstreamLiveMessage)', () => {
    expect(orbLiveSrc).toMatch(
      /ws\.on\(\s*['"`]message['"`]\s*,\s*handleUpstreamLiveMessage\s*\)/,
    );
  });

  it('does NOT declare the message-handler body locally anymore', () => {
    // Anti-regression: the body must NOT live in orb-live.ts anymore.
    // We allow one declaration site of the *name* inside orb-live.ts
    // (the `const handleUpstreamLiveMessage = createUpstreamLiveMessageHandler(...)`
    // line), but not a function declaration with the body inline.
    expect(orbLiveSrc).not.toMatch(
      /function\s+handleUpstreamLiveMessage\s*\(/,
    );
  });

  it('preserves the connectToLiveAPI Promise-closure state semantics (setupComplete + clearTimeout + resolve)', () => {
    // A8.3a.2: the wiring originally mutated setupComplete + cleared
    // connectionTimeout + called resolve(ws) inside the `onSetupComplete`
    // callback passed to createUpstreamLiveMessageHandler.
    //
    // A8.3b.1: those three mutations move OUT of the `onSetupComplete`
    // callback (which is now a no-op for the Vertex path because
    // VertexLiveClient consumes setup_complete) and into the post-
    // `vertex.connect()` block. Observable behavior is unchanged: when
    // setup_complete arrives, setupComplete flips true, the timeout
    // clears, and the outer Promise resolves with ws.
    //
    // This test asserts the three mutations still exist SOMEWHERE in
    // connectToLiveAPI's body — the seam is preserved, just relocated.
    const fnStart = orbLiveSrc.indexOf('async function connectToLiveAPI');
    expect(fnStart).toBeGreaterThan(0);
    const fnEnd = orbLiveSrc.indexOf('\nasync function ', fnStart + 1);
    const fnBody = orbLiveSrc.slice(fnStart, fnEnd >= 0 ? fnEnd : undefined);
    expect(fnBody).toMatch(/setupComplete\s*=\s*true/);
    expect(fnBody).toMatch(/clearTimeout\s*\(\s*connectionTimeout\s*\)/);
    expect(fnBody).toMatch(/resolve\s*\(\s*ws\s*\)/);
    // A8.3b.1: VertexLiveClient is the active path.
    expect(fnBody).toMatch(/new\s+VertexLiveClient\s*\(\s*\)/);
    expect(fnBody).toMatch(/vertex\.connect\s*\(/);
    expect(fnBody).toMatch(/vertex\.getSocket\s*\(\s*\)/);
    expect(fnBody).toMatch(/customSetupMessage/);
  });

  it('does NOT inline `new WebSocket(wsUrl, { headers: ... })` anymore', () => {
    // Anti-regression: pre-A8.3b.1 connectToLiveAPI constructed the raw
    // WebSocket inline. After A8.3b.1, VertexLiveClient owns that path.
    const fnStart = orbLiveSrc.indexOf('async function connectToLiveAPI');
    const fnEnd = orbLiveSrc.indexOf('\nasync function ', fnStart + 1);
    const fnBody = orbLiveSrc.slice(fnStart, fnEnd >= 0 ? fnEnd : undefined);
    expect(fnBody).not.toMatch(/new\s+WebSocket\s*\(\s*wsUrl/);
  });

  it('A8.3b.2: legacy raw-WebSocket scaffolding is removed from connectToLiveAPI', () => {
    // A8.3b.2 (VTID-02972): with VertexLiveClient owning the entire
    // open-handshake (auth-token fetch, URL build, headers attach,
    // ws.on('open') envelope send, setup_complete gate), the outer
    // connectToLiveAPI body no longer needs to fetch the token or
    // construct the WSS URL itself. Those three artifacts must NOT
    // reappear inside the function body:
    //
    //   1. `const wsUrl = ...`  — URL is internal to VertexLiveClient.
    //   2. `const accessToken = await getAccessToken()` — VertexLiveClient
    //      invokes `options.getAccessToken()` itself.
    //   3. `async () => accessToken` closure — the function reference is
    //      passed directly instead.
    //
    // VertexLiveClient.connect() must still be called (sanity check), and
    // getAccessToken must still appear inside it (as the option's value).
    const fnStart = orbLiveSrc.indexOf('async function connectToLiveAPI');
    expect(fnStart).toBeGreaterThan(0);
    const fnEnd = orbLiveSrc.indexOf('\nasync function ', fnStart + 1);
    const fnBody = orbLiveSrc.slice(fnStart, fnEnd >= 0 ? fnEnd : undefined);
    expect(fnBody).not.toMatch(/const\s+wsUrl\s*=/);
    expect(fnBody).not.toMatch(/const\s+accessToken\s*=\s*await\s+getAccessToken\s*\(/);
    expect(fnBody).not.toMatch(/async\s*\(\s*\)\s*=>\s*accessToken\b/);
    // Sanity: the seam is still wired.
    expect(fnBody).toMatch(/vertex\.connect\s*\(/);
    expect(fnBody).toMatch(/getAccessToken\b/);
  });

  it('L1: connectToLiveAPI calls selectUpstreamProvider before constructing the upstream client', () => {
    // L1 (VTID-02976): the upstream provider must flow through the pure
    // selector, NOT be hard-coded to Vertex inline. The selector returns
    // a decision the consumer emits to OASIS via
    // `orb.upstream.provider.selected` and (when LiveKit was requested
    // and downgraded) `orb.upstream.provider.selection_error`.
    //
    // Anti-regression: assert the wiring exists inside connectToLiveAPI's
    // body. The selector itself is unit-tested by
    // test/orb/live/upstream/upstream-provider-selector.test.ts — this
    // test ONLY proves the consumer is wired through it.
    const fnStart = orbLiveSrc.indexOf('async function connectToLiveAPI');
    expect(fnStart).toBeGreaterThan(0);
    const fnEnd = orbLiveSrc.indexOf('\nasync function ', fnStart + 1);
    const fnBody = orbLiveSrc.slice(fnStart, fnEnd >= 0 ? fnEnd : undefined);
    expect(fnBody).toMatch(/selectUpstreamProvider\s*\(/);
    expect(fnBody).toMatch(/orb\.upstream\.provider\.selected/);
    expect(fnBody).toMatch(/orb\.upstream\.provider\.selection_error/);
    // The selector reads env override + system_config + LiveKit creds.
    expect(fnBody).toMatch(/envProviderOverride\s*:\s*process\.env\.ORB_LIVE_PROVIDER/);
    expect(fnBody).toMatch(/systemConfigActiveProvider\s*:/);
    expect(fnBody).toMatch(/livekitCredentials\s*:/);
  });

  it('L2.1: connectToLiveAPI passes canary config + identity to the selector and emits canary OASIS events', () => {
    // L2.1 (VTID-02980): the connect path must also read the LiveKit
    // canary config (env + system_config) and pass it — along with the
    // session identity — to the selector. When the selector returns
    // `provider='livekit'` via the canary path, two distinct OASIS
    // events fire:
    //   1. `orb.upstream.canary.selection_unlocked` — the decision happened.
    //   2. `orb.upstream.canary.consumer_pinned_vertex_l21` — L2.1's
    //      consumer is still pinned to Vertex (the LiveKit media client
    //      isn't wired yet; L2.2 lifts this pin and replaces this event
    //      with connect_started / succeeded / failed events).
    const fnStart = orbLiveSrc.indexOf('async function connectToLiveAPI');
    expect(fnStart).toBeGreaterThan(0);
    const fnEnd = orbLiveSrc.indexOf('\nasync function ', fnStart + 1);
    const fnBody = orbLiveSrc.slice(fnStart, fnEnd >= 0 ? fnEnd : undefined);
    // Reads the canary config.
    expect(fnBody).toMatch(/getLiveKitCanaryConfig\s*\(/);
    // Passes the canary + identity bags to the selector.
    expect(fnBody).toMatch(/canary\s*:\s*\{[\s\S]*?enabled\s*:[\s\S]*?allowedTenants[\s\S]*?allowedUsers/);
    expect(fnBody).toMatch(/identity\s*:\s*\{[\s\S]*?tenantId[\s\S]*?session\.identity\?\.tenant_id/);
    expect(fnBody).toMatch(/identity\s*:\s*\{[\s\S]*?userId[\s\S]*?session\.identity\?\.user_id/);
    // Emits both canary OASIS event types.
    expect(fnBody).toMatch(/orb\.upstream\.canary\.selection_unlocked/);
    expect(fnBody).toMatch(/orb\.upstream\.canary\.consumer_pinned_vertex_l21/);
    // Canary events fire ONLY when the decision is livekit AND canary=true.
    expect(fnBody).toMatch(
      /__upstreamDecision\.provider\s*===\s*['"]livekit['"]\s*&&\s*__upstreamDecision\.canary/,
    );
  });
});
