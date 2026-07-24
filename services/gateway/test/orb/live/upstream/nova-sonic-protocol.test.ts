/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 3): exact-envelope protocol codec tests.
 */

import {
  buildAudioContentStart,
  buildAudioInput,
  buildContentEnd,
  buildPromptEnd,
  buildPromptStart,
  buildSessionEnd,
  buildSessionStart,
  buildTextContentStart,
  buildTextInput,
  buildToolResultEvents,
  convertToolsToNovaSpecs,
  NovaOutputNormalizer,
  NOVA_OUTPUT_MIME,
} from '../../../../src/orb/live/upstream/nova-sonic-protocol';

describe('input event builders — exact envelopes', () => {
  it('sessionStart carries inference + turn-detection configuration', () => {
    expect(buildSessionStart({ maxTokens: 2048, topP: 0.8, temperature: 0.5 })).toEqual({
      event: {
        sessionStart: {
          inferenceConfiguration: { maxTokens: 2048, topP: 0.8, temperature: 0.5 },
          turnDetectionConfiguration: { endpointingSensitivity: 'MEDIUM' },
        },
      },
    });
    expect(
      (buildSessionStart({ endpointingSensitivity: 'LOW' }).event.sessionStart as Record<string, any>)
        .turnDetectionConfiguration.endpointingSensitivity,
    ).toBe('LOW');
  });

  it('promptStart configures 24kHz LPCM output + tools', () => {
    const tools = convertToolsToNovaSpecs([
      { name: 'get_current_screen', description: 'Current screen', parameters: { type: 'object', properties: {} } },
    ]);
    const evt = buildPromptStart({ promptName: 'prompt-1', voiceId: 'tina', tools });
    expect(evt).toEqual({
      event: {
        promptStart: {
          promptName: 'prompt-1',
          textOutputConfiguration: { mediaType: 'text/plain' },
          audioOutputConfiguration: {
            mediaType: 'audio/lpcm',
            sampleRateHertz: 24000,
            sampleSizeBits: 16,
            channelCount: 1,
            voiceId: 'tina',
            encoding: 'base64',
            audioType: 'SPEECH',
          },
          toolUseOutputConfiguration: { mediaType: 'application/json' },
          toolConfiguration: { tools },
        },
      },
    });
  });

  it('system text block: contentStart → textInput → contentEnd', () => {
    expect(
      buildTextContentStart({ promptName: 'p', contentName: 'sys', role: 'SYSTEM' }),
    ).toEqual({
      event: {
        contentStart: {
          promptName: 'p',
          contentName: 'sys',
          type: 'TEXT',
          role: 'SYSTEM',
          interactive: true,
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      },
    });
    expect(buildTextInput({ promptName: 'p', contentName: 'sys', content: 'You are Vitana.' })).toEqual({
      event: { textInput: { promptName: 'p', contentName: 'sys', content: 'You are Vitana.' } },
    });
    expect(buildContentEnd({ promptName: 'p', contentName: 'sys' })).toEqual({
      event: { contentEnd: { promptName: 'p', contentName: 'sys' } },
    });
  });

  it('audio block: 16kHz LPCM contentStart + audioInput passthrough', () => {
    expect(buildAudioContentStart({ promptName: 'p', contentName: 'audio-1' })).toEqual({
      event: {
        contentStart: {
          promptName: 'p',
          contentName: 'audio-1',
          type: 'AUDIO',
          role: 'USER',
          interactive: true,
          audioInputConfiguration: {
            mediaType: 'audio/lpcm',
            sampleRateHertz: 16000,
            sampleSizeBits: 16,
            channelCount: 1,
            audioType: 'SPEECH',
            encoding: 'base64',
          },
        },
      },
    });
    expect(
      buildAudioInput({ promptName: 'prompt-1', contentName: 'audio-1', dataB64: 'AQID' }),
    ).toEqual({
      event: {
        audioInput: {
          promptName: 'prompt-1',
          contentName: 'audio-1',
          content: 'AQID',
        },
      },
    });
  });

  it('toolResult wraps in a TOOL block correlated by toolUseId', () => {
    const events = buildToolResultEvents({
      promptName: 'p',
      contentName: 'tool-c',
      toolUseId: 'use-1',
      content: '{"screen":"journey"}',
    });
    expect(events.map((e) => Object.keys(e.event)[0])).toEqual([
      'contentStart',
      'toolResult',
      'contentEnd',
    ]);
    expect((events[0].event.contentStart as any).toolResultInputConfiguration.toolUseId).toBe('use-1');
    expect((events[1].event.toolResult as any).content).toBe('{"screen":"journey"}');
  });

  it('promptEnd / sessionEnd', () => {
    expect(buildPromptEnd('p')).toEqual({ event: { promptEnd: { promptName: 'p' } } });
    expect(buildSessionEnd()).toEqual({ event: { sessionEnd: {} } });
  });
});

describe('convertToolsToNovaSpecs', () => {
  it('converts flat Gemini declarations to toolSpec with stringified schema', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } } };
    expect(
      convertToolsToNovaSpecs([{ name: 'search', description: 'Search', parameters: schema }]),
    ).toEqual([
      {
        toolSpec: {
          name: 'search',
          description: 'Search',
          inputSchema: { json: JSON.stringify(schema) },
        },
      },
    ]);
  });

  it('unwraps function_declarations wrappers', () => {
    const specs = convertToolsToNovaSpecs([
      { function_declarations: [{ name: 'a', description: '', parameters: { type: 'object' } }, { name: 'b', description: '', parameters: { type: 'object' } }] },
    ]);
    expect(specs.map((s) => s.toolSpec.name)).toEqual(['a', 'b']);
  });

  it('rejects duplicate tool names and malformed schemas BEFORE a paid stream', () => {
    expect(() =>
      convertToolsToNovaSpecs([
        { name: 'x', description: '', parameters: {} },
        { name: 'x', description: '', parameters: {} },
      ]),
    ).toThrow(/duplicate tool name/);
    expect(() => convertToolsToNovaSpecs([{ name: '', description: '' }])).toThrow(/missing name/);
    expect(() =>
      convertToolsToNovaSpecs([{ name: 'y', description: '', parameters: 'nope' }]),
    ).toThrow(/malformed schema/);
  });
});

describe('NovaOutputNormalizer', () => {
  it('USER FINAL textOutput → input transcript', () => {
    const n = new NovaOutputNormalizer();
    const events = n.normalize({
      event: { textOutput: { contentId: 'c1', role: 'USER', content: 'hallo vitana' } },
    });
    expect(events).toEqual([
      { kind: 'transcript', direction: 'input', text: 'hallo vitana', isFinal: true },
    ]);
  });

  it('ASSISTANT speculative → not final; FINAL stage → final', () => {
    const n = new NovaOutputNormalizer();
    n.normalize({
      event: {
        contentStart: {
          contentId: 'spec',
          type: 'TEXT',
          role: 'ASSISTANT',
          additionalModelFields: JSON.stringify({ generationStage: 'SPECULATIVE' }),
        },
      },
    });
    expect(
      n.normalize({ event: { textOutput: { contentId: 'spec', role: 'ASSISTANT', content: 'Ich ' } } }),
    ).toEqual([
      { kind: 'transcript', direction: 'output', text: 'Ich ', isFinal: false, generationStage: 'SPECULATIVE' },
    ]);
    n.normalize({
      event: {
        contentStart: {
          contentId: 'fin',
          type: 'TEXT',
          role: 'ASSISTANT',
          additionalModelFields: JSON.stringify({ generationStage: 'FINAL' }),
        },
      },
    });
    expect(
      n.normalize({ event: { textOutput: { contentId: 'fin', role: 'ASSISTANT', content: 'Ich helfe gern.' } } }),
    ).toEqual([
      { kind: 'transcript', direction: 'output', text: 'Ich helfe gern.', isFinal: true, generationStage: 'FINAL' },
    ]);
  });

  it('audioOutput → audio event with 24kHz PCM mime', () => {
    const n = new NovaOutputNormalizer();
    expect(n.normalize({ event: { audioOutput: { content: 'QUJD' } } })).toEqual([
      { kind: 'audio', dataB64: 'QUJD', mimeType: NOVA_OUTPUT_MIME },
    ]);
    expect(NOVA_OUTPUT_MIME).toBe('audio/pcm;rate=24000');
  });

  it('toolUse + TOOL contentEnd → exactly one toolCall', () => {
    const n = new NovaOutputNormalizer();
    n.normalize({
      event: { toolUse: { toolUseId: 'use-9', toolName: 'get_current_screen', content: '{"a":1}' } },
    });
    const events = n.normalize({ event: { contentEnd: { type: 'TOOL', stopReason: 'TOOL_USE' } } });
    expect(events).toEqual([
      { kind: 'toolCall', callId: 'use-9', name: 'get_current_screen', args: { a: 1 } },
    ]);
    // A second TOOL contentEnd without a new toolUse emits nothing more.
    expect(n.normalize({ event: { contentEnd: { type: 'TOOL' } } })).toEqual([
      { kind: 'ignored', eventName: 'contentEnd' },
    ]);
  });

  it('INTERRUPTED contentEnd → interrupted; END_TURN completionEnd → turnComplete', () => {
    const n = new NovaOutputNormalizer();
    expect(n.normalize({ event: { contentEnd: { type: 'AUDIO', stopReason: 'INTERRUPTED' } } })).toEqual([
      { kind: 'interrupted' },
    ]);
    expect(n.normalize({ event: { completionEnd: { stopReason: 'END_TURN' } } })).toEqual([
      { kind: 'turnComplete' },
    ]);
  });

  it('usageEvent.details.total → usage totals', () => {
    const n = new NovaOutputNormalizer();
    expect(
      n.normalize({
        event: {
          usageEvent: {
            totalInputTokens: 120,
            totalOutputTokens: 340,
            details: {
              total: {
                input: { speechTokens: 100, textTokens: 20 },
                output: { speechTokens: 300, textTokens: 40 },
              },
            },
          },
        },
      }),
    ).toEqual([
      {
        kind: 'usage',
        usage: {
          inputSpeechTokens: 100,
          inputTextTokens: 20,
          outputSpeechTokens: 300,
          outputTextTokens: 40,
          totalInputTokens: 120,
          totalOutputTokens: 340,
        },
      },
    ]);
  });

  it('unknown/malformed events are ignored, never thrown', () => {
    const n = new NovaOutputNormalizer();
    expect(n.normalize({ event: { completionStart: {} } })).toEqual([
      { kind: 'ignored', eventName: 'completionStart' },
    ]);
    expect(n.normalize(null)).toEqual([{ kind: 'ignored', eventName: 'malformed' }]);
    expect(n.normalize({})).toEqual([{ kind: 'ignored', eventName: 'malformed' }]);
  });
});
