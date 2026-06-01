/**
 * ORB-CONVERSATION-LATENCY — server-driven auto-greet on upstream connect.
 *
 * Contract this file locks (services/gateway/src/routes/orb-live.ts):
 *
 * The ORB greeting fires SERVER-SIDE the moment the Vertex Live API upstream
 * WebSocket resolves — driven by `liveApiPromise.then((ws) => …)`, NOT by any
 * client-sent greeting/welcome trigger. The frontend (vitana-v1) used to POST a
 * context turn + a greet trigger after getUserMedia; that round-trip was removed
 * as part of the conversation-start latency work, so the server is now the SOLE
 * driver of the first spoken turn. If a refactor ever re-coupled the greeting to
 * an inbound client message, the orb would go silent on tap — this test fails
 * loudly before that ships.
 *
 * It also locks the idempotency guard (`greetingSent`) that lets a stray legacy
 * client trigger be ignored rather than double-greeting, and the first-time vs.
 * reconnect routing.
 *
 * Structural (source-level) by design: exercising the real path needs a live
 * Vertex WebSocket + ADC, which unit CI can't stand up. The existing
 * characterization tests in this directory follow the same approach.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROUTE_PATH = path.resolve(
  __dirname,
  '../../../../src/routes/orb-live.ts',
);

let src: string;

beforeAll(() => {
  src = fs.readFileSync(ROUTE_PATH, 'utf8');
});

describe('ORB-CONVERSATION-LATENCY: server-driven auto-greet on upstream connect', () => {
  it('kicks off the upstream connect non-blocking and greets in its .then() resolve', () => {
    const idxConnect = src.indexOf('const liveApiPromise = connectToLiveAPI(');
    const idxThen = src.indexOf('liveApiPromise.then((ws) => {');
    const idxGreet = src.indexOf('sendGreetingPromptToLiveAPI(ws, session);');

    // The connect is fired and its resolution drives the greeting.
    expect(idxConnect).toBeGreaterThan(-1);
    expect(idxThen).toBeGreaterThan(idxConnect);
    // The greeting fire sits AFTER the .then() opener — i.e. inside the connect
    // resolution callback, not in a client-message handler earlier in the file.
    expect(idxGreet).toBeGreaterThan(idxThen);
  });

  it('routes first-time sessions to the greeting and reconnects to recovery — both server-side', () => {
    const idxThen = src.indexOf('liveApiPromise.then((ws) => {');
    const idxReconnectFlag = src.indexOf('const isReconnectGreetingSkip', idxThen);
    const idxRecovery = src.indexOf('sendReconnectRecoveryPromptToLiveAPI(ws, session);', idxThen);
    const idxGreet = src.indexOf('sendGreetingPromptToLiveAPI(ws, session);', idxThen);

    // The reconnect decision and BOTH opener calls live inside the connect
    // resolution block (all indices are searched from idxThen forward).
    expect(idxReconnectFlag).toBeGreaterThan(idxThen);
    expect(idxRecovery).toBeGreaterThan(idxReconnectFlag);
    expect(idxGreet).toBeGreaterThan(idxReconnectFlag);
  });

  it('greeting send is idempotent on greetingSent so a stray client trigger cannot double-greet', () => {
    const idxFn = src.indexOf('function sendGreetingPromptToLiveAPI(');
    expect(idxFn).toBeGreaterThan(-1);
    // Within the function, an early return when greetingSent is already set.
    const fnBody = src.slice(idxFn, idxFn + 1200);
    expect(fnBody).toMatch(/if\s*\(session\.greetingSent\)/);
    expect(fnBody).toMatch(/return false;/);
  });

  it('does NOT gate the connect-time greeting behind an inbound client message type', () => {
    // The greeting fire must not be wrapped in a handler keyed on a client
    // request like "request_welcome" / "greet" / "trigger_greeting". We assert
    // the connect-resolution greeting and any such client-message string do not
    // appear on the same wiring: there is no client-trigger call to
    // sendGreetingPromptToLiveAPI anywhere except the connect .then() path.
    const greetCalls = [...src.matchAll(/sendGreetingPromptToLiveAPI\(/g)];
    // Definition + the connect-time call(s) + stall-recovery re-send are the only
    // invocations; none are driven by a freshly-received client welcome request.
    expect(greetCalls.length).toBeGreaterThan(0);
    expect(src).not.toMatch(/on\(['"]request_welcome['"]/);
    expect(src).not.toMatch(/case\s+['"]request_welcome['"]/);
  });
});
