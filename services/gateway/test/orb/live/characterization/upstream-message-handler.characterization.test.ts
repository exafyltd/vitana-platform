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

  it('passes the connectToLiveAPI Promise-closure state through onSetupComplete (setupComplete + clearTimeout + resolve)', () => {
    // The wiring callback in orb-live.ts must still mutate setupComplete,
    // clear the connectionTimeout, and resolve(ws). The lifted body no
    // longer touches these directly — only the wiring does.
    const wiring = orbLiveSrc.slice(
      orbLiveSrc.indexOf('onSetupComplete:'),
      orbLiveSrc.indexOf('isSetupComplete:'),
    );
    expect(wiring).toMatch(/setupComplete\s*=\s*true/);
    expect(wiring).toMatch(/clearTimeout\s*\(\s*connectionTimeout\s*\)/);
    expect(wiring).toMatch(/resolve\s*\(\s*ws\s*\)/);
  });
});
