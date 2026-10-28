/**
 * VTID-04036 — legacy Vertex sender: the function-call id is echoed in
 * tool_response.function_responses, but only when it is one the server
 * issued. The session layer fills a missing id with randomUUID(); that
 * placeholder must never be sent back to the Live API.
 */
import { isServerIssuedFunctionCallId } from '../../../src/routes/orb-live';
import * as fs from 'fs';
import * as path from 'path';

describe('VTID-04036 isServerIssuedFunctionCallId', () => {
  it('accepts the shapes the Live API actually issues', () => {
    expect(isServerIssuedFunctionCallId('function-call-7189462203371738542')).toBe(true);
    expect(isServerIssuedFunctionCallId('call-1')).toBe(true);
    expect(isServerIssuedFunctionCallId('1')).toBe(true);
  });

  it('rejects the randomUUID() placeholder and empty values', () => {
    expect(isServerIssuedFunctionCallId('3f2c1b7e-9d4a-4c8e-8f1a-2b3c4d5e6f70')).toBe(false);
    expect(isServerIssuedFunctionCallId('3F2C1B7E-9D4A-4C8E-8F1A-2B3C4D5E6F70')).toBe(false);
    expect(isServerIssuedFunctionCallId('')).toBe(false);
    expect(isServerIssuedFunctionCallId(undefined)).toBe(false);
    expect(isServerIssuedFunctionCallId(null)).toBe(false);
  });
});

describe('VTID-04036 source contract — every function_responses sender echoes the id', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../src', rel), 'utf8');

  it('legacy sendFunctionResponseToLiveAPI spreads the server-issued id into the envelope', () => {
    const src = read('routes/orb-live.ts');
    const start = src.indexOf('function sendFunctionResponseToLiveAPI(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 2500);
    expect(body).toContain('isServerIssuedFunctionCallId(functionCallId)');
    expect(body).toContain('...(echoId ? { id: echoId } : {})');
    expect(body).not.toContain("rejects unknown fields like 'id'");
  });

  it.each([
    'orb/live/upstream/vertex-live-client.ts',
    'orb/live/upstream/gemini-api-key-live-client.ts',
  ])('%s tracks server-issued ids and echoes them in sendToolResult', (rel) => {
    const src = read(rel);
    expect(src).toContain('serverIssuedCallIds.add(c.id)');
    expect(src).toContain('...(echoId ? { id: echoId } : {})');
  });
});
