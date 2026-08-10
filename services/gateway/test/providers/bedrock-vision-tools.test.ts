/**
 * VTID-03496 — Bedrock adapter: vision + forced tool-calling.
 *
 * Build 2 of the 4 provider replacements gating a GCP shutdown. The concrete
 * feature this unblocks is `anthropic-vision-client.ts` (Shorts auto-metadata),
 * which needs images AND a forced `emit_short_metadata` tool call — the exact
 * combination the Bedrock adapter used to reject outright.
 *
 * Two of these tests cover latent bugs found while building, not new code:
 *   - `tools` was declared on BedrockInvokeRequest but never serialized, so a
 *     caller passing tools silently got a plain completion and no tool call.
 *   - response text was read from `content[0].text` only, which is EMPTY when
 *     a forced `tool_use` block comes first.
 */

import {
  parseBedrockContent,
  invokeBedrock,
  type BedrockContentBlock,
} from '../../src/providers/bedrock';

describe('VTID-03496 parseBedrockContent', () => {
  it('extracts a tool_use block into a typed toolCall', () => {
    const out = parseBedrockContent({
      content: [
        { type: 'tool_use', name: 'emit_short_metadata', input: { title: 'Morning stretch' } },
      ],
    });
    expect(out.toolCall).toEqual({
      name: 'emit_short_metadata',
      arguments: { title: 'Morning stretch' },
    });
  });

  it('returns text even when a tool_use block comes FIRST', () => {
    // The old `content[0]?.text` read returned '' here, because content[0] is
    // the tool_use block and has no .text — the exact shape a forced tool call
    // produces, i.e. the failure would have hit every single vision call.
    const out = parseBedrockContent({
      content: [
        { type: 'tool_use', name: 'emit_short_metadata', input: { title: 'x' } },
        { type: 'text', text: 'trailing commentary' },
      ],
    });
    expect(out.text).toBe('trailing commentary');
    expect(out.toolCall?.name).toBe('emit_short_metadata');
  });

  it('joins multiple text blocks instead of truncating to the first', () => {
    const out = parseBedrockContent({
      content: [
        { type: 'text', text: 'part one ' },
        { type: 'text', text: 'part two' },
      ],
    });
    expect(out.text).toBe('part one part two');
  });

  it('returns no toolCall for a plain text response', () => {
    const out = parseBedrockContent({ content: [{ type: 'text', text: 'hello' }] });
    expect(out.text).toBe('hello');
    expect(out.toolCall).toBeUndefined();
  });

  it('returns EVERY tool_use block, in order, with its id (VTID-03579)', () => {
    // An agentic caller executes this list and must send back one result per
    // entry. Parsing only the first executed one tool, returned results for
    // one, and then left the model waiting on calls it had already made — a
    // hang, not an error, and invisible to any test asserting "a tool call came
    // back". The ids matter as much as the names: the tool_result round-trip is
    // paired by id, and Anthropic 400s on a mismatch.
    const parsed = parseBedrockContent({
      content: [
        { type: 'text', text: 'Working on it. ' },
        { type: 'tool_use', id: 'tu_a', name: 'list_vtids', input: { status: 'open' } },
        { type: 'tool_use', id: 'tu_b', name: 'get_health', input: {} },
        { type: 'tool_use', id: 'tu_c', name: 'run_code', input: { code: '1+1' } },
      ],
    });

    expect(parsed.toolCalls).toHaveLength(3);
    expect(parsed.toolCalls.map((t) => t.name)).toEqual(['list_vtids', 'get_health', 'run_code']);
    expect(parsed.toolCalls.map((t) => t.id)).toEqual(['tu_a', 'tu_b', 'tu_c']);
    expect(parsed.toolCalls[2].arguments).toEqual({ code: '1+1' });

    // Text still accumulates across blocks, and `toolCall` remains the first
    // entry so existing single-tool callers are unaffected.
    expect(parsed.text).toBe('Working on it. ');
    expect(parsed.toolCall!.name).toBe('list_vtids');
  });

  it('tolerates a missing/!array content field rather than throwing', () => {
    // VTID-03579: `toolCalls` (plural) is now always present — an empty array
    // when nothing was requested. Asserted explicitly rather than loosened to
    // toMatchObject: a caller that iterates the list must never get `undefined`
    // back on the no-tools path, which is precisely the case this test covers.
    expect(parseBedrockContent({})).toEqual({ text: '', toolCall: undefined, toolCalls: [] });
    expect(parseBedrockContent({ content: undefined })).toEqual({
      text: '',
      toolCall: undefined,
      toolCalls: [],
    });
  });

  it('ignores a malformed tool_use block with no name or input', () => {
    const out = parseBedrockContent({ content: [{ type: 'tool_use' }] });
    expect(out.toolCall).toBeUndefined();
  });
});

describe('VTID-03496 configuration gate', () => {
  const original = process.env.BEDROCK_ROLE_ARN;
  afterEach(() => {
    if (original === undefined) delete process.env.BEDROCK_ROLE_ARN;
    else process.env.BEDROCK_ROLE_ARN = original;
  });

  it('reports not_configured when BEDROCK_ROLE_ARN is unset', async () => {
    delete process.env.BEDROCK_ROLE_ARN;
    const res = await invokeBedrock({
      model: 'eu.anthropic.claude-sonnet-4-6-v1:0',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not_configured');
  });

  it('reads the env var at CALL time, not module-load time', async () => {
    // Previously captured at import, so a task def that set the var after
    // process start could never activate Bedrock without a restart — and this
    // test could not exist at all.
    delete process.env.BEDROCK_ROLE_ARN;
    const before = await invokeBedrock({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(before.ok).toBe(false);

    process.env.BEDROCK_ROLE_ARN = 'arn:aws:iam::472838866351:role/test';
    const after = await invokeBedrock({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Now it gets PAST the config gate and fails on the real call instead
    // (no credentials in test) — the distinction that matters is not_configured
    // vs invoke_failed.
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error).toBe('invoke_failed');
  }, 30_000);
});

describe('VTID-03496 content block typing', () => {
  it('accepts an image + text block array as message content', () => {
    // Compile-time contract as much as runtime: this shape is what carries
    // keyframes for Shorts auto-metadata.
    const content: BedrockContentBlock[] = [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'text', text: 'Analyze these keyframes.' },
    ];
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('image');
    expect(content[1].type).toBe('text');
  });
});
