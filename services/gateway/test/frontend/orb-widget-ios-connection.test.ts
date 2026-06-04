import * as fs from 'fs';
import * as path from 'path';

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);

const V1_HOOK_PATH = path.resolve(
  __dirname,
  '../../../../temp_vitana_v1/src/hooks/useOrbWidget.ts',
);

const CURRENT_ORB_WIDGET_VERSION = '20260531-DEV-COMHU-0504-audio-ready-r3';

function extractFunctionBody(source: string, signature: string): string {
  const sigIdx = source.indexOf(signature);
  expect(sigIdx).toBeGreaterThanOrEqual(0);
  const openIdx = source.indexOf('{', sigIdx);
  expect(openIdx).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (depth === 0) return source.slice(openIdx + 1, i);
  }
  throw new Error(`unclosed function body: ${signature}`);
}

describe('orb-widget iOS connection recovery', () => {
  const widgetSource = fs.readFileSync(WIDGET_PATH, 'utf8');
  const hookSource = fs.readFileSync(V1_HOOK_PATH, 'utf8');

  it('vitana-v1 loads the current audio-ready widget build, not the stale April build', () => {
    expect(hookSource).toContain(`orb-widget.js?v=${CURRENT_ORB_WIDGET_VERSION}`);
    expect(hookSource).not.toContain('orb-widget.js?v=20260410');
  });

  it('arms an SSE ready watchdog so the UI cannot stay on Connecting indefinitely', () => {
    expect(widgetSource).toContain('function _startSseReadyWatchdog()');
    expect(widgetSource).toContain('function _stopSseReadyWatchdog()');

    const startBody = extractFunctionBody(widgetSource, 'function _startSseReadyWatchdog()');
    expect(startBody).toMatch(/_s\._sseReadyWatchdogTimer/);
    expect(startBody).toMatch(/_announceDisconnect\('connection'\)/);
    expect(startBody).toMatch(/_attemptReconnect\(\)/);

    const sessionStartBody = extractFunctionBody(widgetSource, 'async function _sessionStart()');
    expect(sessionStartBody).toMatch(/_startSseReadyWatchdog\(\)/);
  });

  it('clears the SSE ready watchdog once the ready frame arrives or the session stops', () => {
    const handleMessageBody = extractFunctionBody(widgetSource, 'function _handleMessage(msg)');
    expect(handleMessageBody).toMatch(/case 'ready':[\s\S]*_stopSseReadyWatchdog\(\)/);

    const stopBody = extractFunctionBody(widgetSource, 'async function _sessionStop()');
    expect(stopBody).toMatch(/_stopSseReadyWatchdog\(\)/);
  });
});
