import * as fs from 'fs';
import * as path from 'path';

const WIDGET_PATH = path.resolve(
  __dirname,
  '../../src/frontend/command-hub/orb-widget.js',
);

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

describe('orb-widget audio playback queue', () => {
  it('removes the actual ended AudioBufferSource from scheduledSources', () => {
    const source = fs.readFileSync(WIDGET_PATH, 'utf8');
    const processQueueBody = extractFunctionBody(source, 'function _processQueue()');

    expect(processQueueBody).toMatch(
      /\(function\s*\(\s*endedSrc\s*\)\s*\{[\s\S]*src\.onended\s*=\s*function\s*\(\s*\)\s*\{[\s\S]*indexOf\(endedSrc\)[\s\S]*\}\s*;[\s\S]*\}\)\(src\);/,
    );
    expect(processQueueBody).toMatch(/indexOf\(endedSrc\)/);
    expect(processQueueBody).not.toMatch(/indexOf\(src\)/);
    expect(processQueueBody).not.toMatch(/var\s+endedSrc\s*=\s*src;/);
  });
});
