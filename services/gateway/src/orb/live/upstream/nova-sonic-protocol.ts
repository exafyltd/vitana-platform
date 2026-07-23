/**
 * BOOTSTRAP-NOVA-SONIC-VOICE (Task 3): pure Nova 2 Sonic protocol codecs.
 *
 * Input-event builders, tool-schema conversion, and the output-event
 * normalizer for Bedrock `InvokeModelWithBidirectionalStream`. Everything
 * here is PURE — no SDK, no network, no logging of payload content — so the
 * exact wire envelopes are unit-testable and the live client (Task 4) stays
 * a thin lifecycle wrapper.
 *
 * Wire shapes follow the Nova 2 Sonic user guide (events wrapped in
 * `{ event: { <name>: {...} } }`):
 *   sessionStart → promptStart → [system contentStart/textInput/contentEnd]
 *   → audio contentStart → audioInput* → … → promptEnd → sessionEnd.
 * Audio in is 16 kHz LPCM base64; audio out is configured at 24 kHz so the
 * existing browser `audio_out` path plays it without resampling.
 */

/** Fixed audio contracts — must match the browser widget's PCM format. */
export const NOVA_INPUT_SAMPLE_RATE_HZ = 16_000;
export const NOVA_OUTPUT_SAMPLE_RATE_HZ = 24_000;
export const NOVA_OUTPUT_MIME = `audio/pcm;rate=${NOVA_OUTPUT_SAMPLE_RATE_HZ}`;

export type NovaInputEvent = { event: Record<string, unknown> };

export interface NovaSessionStartOptions {
  maxTokens?: number;
  topP?: number;
  temperature?: number;
}

export function buildSessionStart(options: NovaSessionStartOptions = {}): NovaInputEvent {
  return {
    event: {
      sessionStart: {
        inferenceConfiguration: {
          maxTokens: options.maxTokens ?? 1024,
          topP: options.topP ?? 0.9,
          temperature: options.temperature ?? 0.7,
        },
      },
    },
  };
}

/** Nova tool declaration (`toolSpec`) shape. */
export interface NovaToolSpec {
  toolSpec: {
    name: string;
    description: string;
    inputSchema: { json: string };
  };
}

export interface NovaPromptStartOptions {
  promptName: string;
  voiceId: string;
  tools?: ReadonlyArray<NovaToolSpec>;
}

export function buildPromptStart(options: NovaPromptStartOptions): NovaInputEvent {
  const promptStart: Record<string, unknown> = {
    promptName: options.promptName,
    textOutputConfiguration: { mediaType: 'text/plain' },
    audioOutputConfiguration: {
      mediaType: 'audio/lpcm',
      sampleRateHertz: NOVA_OUTPUT_SAMPLE_RATE_HZ,
      sampleSizeBits: 16,
      channelCount: 1,
      voiceId: options.voiceId,
      encoding: 'base64',
      audioType: 'SPEECH',
    },
  };
  if (options.tools && options.tools.length > 0) {
    promptStart.toolUseOutputConfiguration = { mediaType: 'application/json' };
    promptStart.toolConfiguration = { tools: options.tools };
  }
  return { event: { promptStart } };
}

export interface NovaTextContentOptions {
  promptName: string;
  contentName: string;
  role: 'SYSTEM' | 'USER' | 'ASSISTANT';
  interactive?: boolean;
}

export function buildTextContentStart(options: NovaTextContentOptions): NovaInputEvent {
  return {
    event: {
      contentStart: {
        promptName: options.promptName,
        contentName: options.contentName,
        type: 'TEXT',
        role: options.role,
        interactive: options.interactive ?? true,
        textInputConfiguration: { mediaType: 'text/plain' },
      },
    },
  };
}

export function buildTextInput(options: {
  promptName: string;
  contentName: string;
  content: string;
}): NovaInputEvent {
  return {
    event: {
      textInput: {
        promptName: options.promptName,
        contentName: options.contentName,
        content: options.content,
      },
    },
  };
}

export function buildContentEnd(options: {
  promptName: string;
  contentName: string;
}): NovaInputEvent {
  return {
    event: {
      contentEnd: {
        promptName: options.promptName,
        contentName: options.contentName,
      },
    },
  };
}

export function buildAudioContentStart(options: {
  promptName: string;
  contentName: string;
}): NovaInputEvent {
  return {
    event: {
      contentStart: {
        promptName: options.promptName,
        contentName: options.contentName,
        type: 'AUDIO',
        role: 'USER',
        interactive: true,
        audioInputConfiguration: {
          mediaType: 'audio/lpcm',
          sampleRateHertz: NOVA_INPUT_SAMPLE_RATE_HZ,
          sampleSizeBits: 16,
          channelCount: 1,
          audioType: 'SPEECH',
          encoding: 'base64',
        },
      },
    },
  };
}

export function buildAudioInput(options: {
  promptName: string;
  contentName: string;
  dataB64: string;
}): NovaInputEvent {
  return {
    event: {
      audioInput: {
        promptName: options.promptName,
        contentName: options.contentName,
        content: options.dataB64,
      },
    },
  };
}

/**
 * Tool result — Nova requires a `toolResult` for EVERY `toolUse`, wrapped
 * in its own TOOL content block correlated by `toolUseId`.
 */
export function buildToolResultEvents(options: {
  promptName: string;
  contentName: string;
  toolUseId: string;
  /** Serialized result content (JSON text) for the model. */
  content: string;
}): NovaInputEvent[] {
  return [
    {
      event: {
        contentStart: {
          promptName: options.promptName,
          contentName: options.contentName,
          type: 'TOOL',
          role: 'TOOL',
          interactive: false,
          toolResultInputConfiguration: {
            toolUseId: options.toolUseId,
            type: 'TEXT',
            textInputConfiguration: { mediaType: 'text/plain' },
          },
        },
      },
    },
    {
      event: {
        toolResult: {
          promptName: options.promptName,
          contentName: options.contentName,
          content: options.content,
        },
      },
    },
    buildContentEnd({ promptName: options.promptName, contentName: options.contentName }),
  ];
}

export function buildPromptEnd(promptName: string): NovaInputEvent {
  return { event: { promptEnd: { promptName } } };
}

export function buildSessionEnd(): NovaInputEvent {
  return { event: { sessionEnd: {} } };
}

// ---------------------------------------------------------------------------
// Tool-schema conversion
// ---------------------------------------------------------------------------

/**
 * Convert the gateway's Gemini-shaped tool declarations into Nova
 * `toolSpec`s. Accepts either a flat `{name, description, parameters}` list
 * or the Vertex `{function_declarations: [...]}` wrapper. Throws on
 * duplicate tool names or malformed entries — a broken catalog must fail
 * BEFORE a paid stream opens, not stall mid-session.
 */
export function convertToolsToNovaSpecs(
  tools: ReadonlyArray<Record<string, unknown>>,
): NovaToolSpec[] {
  const flat: Array<Record<string, unknown>> = [];
  for (const entry of tools) {
    const fnDecls = (entry as { function_declarations?: unknown }).function_declarations
      ?? (entry as { functionDeclarations?: unknown }).functionDeclarations;
    if (Array.isArray(fnDecls)) {
      flat.push(...(fnDecls as Array<Record<string, unknown>>));
    } else {
      flat.push(entry);
    }
  }

  const seen = new Set<string>();
  const specs: NovaToolSpec[] = [];
  for (const decl of flat) {
    const name = decl.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('nova_tool_schema_invalid: tool declaration missing name');
    }
    if (seen.has(name)) {
      throw new Error(`nova_tool_schema_invalid: duplicate tool name '${name}'`);
    }
    seen.add(name);
    const description = typeof decl.description === 'string' ? decl.description : '';
    const parameters = decl.parameters ?? { type: 'object', properties: {} };
    if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
      throw new Error(`nova_tool_schema_invalid: tool '${name}' has a malformed schema`);
    }
    specs.push({
      toolSpec: {
        name,
        description,
        inputSchema: { json: JSON.stringify(parameters) },
      },
    });
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Output normalization
// ---------------------------------------------------------------------------

export type NovaNormalizedEvent =
  | {
      kind: 'transcript';
      direction: 'input' | 'output';
      text: string;
      isFinal: boolean;
      generationStage?: 'SPECULATIVE' | 'FINAL';
    }
  | { kind: 'audio'; dataB64: string; mimeType: string }
  | { kind: 'toolCall'; callId: string; name: string; args: Record<string, unknown> }
  | { kind: 'interrupted' }
  | { kind: 'turnComplete' }
  | { kind: 'usage'; usage: {
      inputSpeechTokens?: number;
      inputTextTokens?: number;
      outputSpeechTokens?: number;
      outputTextTokens?: number;
      totalInputTokens?: number;
      totalOutputTokens?: number;
    } }
  | { kind: 'ignored'; eventName: string };

interface NovaContentMeta {
  type?: string;
  role?: string;
  generationStage?: 'SPECULATIVE' | 'FINAL';
}

/**
 * Stateful normalizer for Nova's decoded output events. Tracks per-content
 * metadata from `contentStart` (role, type, generationStage) and
 * accumulates `toolUse` until its TOOL `contentEnd` closes the block.
 * Feed it each decoded JSON event; it returns zero-or-more normalized
 * events. Payload content is never logged here.
 */
export class NovaOutputNormalizer {
  private contentMeta = new Map<string, NovaContentMeta>();
  private pendingToolUse: {
    callId: string;
    name: string;
    argsJson: string;
  } | null = null;

  normalize(raw: unknown): NovaNormalizedEvent[] {
    const eventObj = (raw as { event?: Record<string, unknown> })?.event;
    if (!eventObj || typeof eventObj !== 'object') {
      return [{ kind: 'ignored', eventName: 'malformed' }];
    }

    const out: NovaNormalizedEvent[] = [];

    const contentStart = eventObj.contentStart as Record<string, unknown> | undefined;
    if (contentStart) {
      const contentId =
        (contentStart.contentId as string) ?? (contentStart.contentName as string) ?? '';
      const meta: NovaContentMeta = {
        type: contentStart.type as string | undefined,
        role: contentStart.role as string | undefined,
      };
      const additional = contentStart.additionalModelFields;
      if (typeof additional === 'string') {
        try {
          const parsed = JSON.parse(additional) as { generationStage?: string };
          if (parsed.generationStage === 'SPECULATIVE' || parsed.generationStage === 'FINAL') {
            meta.generationStage = parsed.generationStage;
          }
        } catch {
          /* additionalModelFields is best-effort metadata */
        }
      }
      if (contentId) this.contentMeta.set(contentId, meta);
      out.push({ kind: 'ignored', eventName: 'contentStart' });
    }

    const textOutput = eventObj.textOutput as Record<string, unknown> | undefined;
    if (textOutput) {
      const contentId =
        (textOutput.contentId as string) ?? (textOutput.contentName as string) ?? '';
      const meta = this.contentMeta.get(contentId) ?? {};
      const role = (textOutput.role as string) ?? meta.role ?? '';
      const text = (textOutput.content as string) ?? '';
      if (role === 'USER') {
        out.push({ kind: 'transcript', direction: 'input', text, isFinal: true });
      } else if (role === 'ASSISTANT') {
        const stage = meta.generationStage ?? 'SPECULATIVE';
        out.push({
          kind: 'transcript',
          direction: 'output',
          text,
          isFinal: stage === 'FINAL',
          generationStage: stage,
        });
      } else {
        out.push({ kind: 'ignored', eventName: 'textOutput' });
      }
    }

    const audioOutput = eventObj.audioOutput as Record<string, unknown> | undefined;
    if (audioOutput && typeof audioOutput.content === 'string') {
      out.push({ kind: 'audio', dataB64: audioOutput.content, mimeType: NOVA_OUTPUT_MIME });
    }

    const toolUse = eventObj.toolUse as Record<string, unknown> | undefined;
    if (toolUse) {
      this.pendingToolUse = {
        callId: (toolUse.toolUseId as string) ?? '',
        name: (toolUse.toolName as string) ?? '',
        argsJson: (toolUse.content as string) ?? '{}',
      };
      out.push({ kind: 'ignored', eventName: 'toolUse' });
    }

    const contentEnd = eventObj.contentEnd as Record<string, unknown> | undefined;
    if (contentEnd) {
      const stopReason = contentEnd.stopReason as string | undefined;
      const type = contentEnd.type as string | undefined;
      if (type === 'TOOL' && this.pendingToolUse) {
        let args: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(this.pendingToolUse.argsJson);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          /* non-JSON args → empty object; the dispatcher validates anyway */
        }
        out.push({
          kind: 'toolCall',
          callId: this.pendingToolUse.callId,
          name: this.pendingToolUse.name,
          args,
        });
        this.pendingToolUse = null;
      } else if (stopReason === 'INTERRUPTED') {
        out.push({ kind: 'interrupted' });
      } else {
        out.push({ kind: 'ignored', eventName: 'contentEnd' });
      }
    }

    const completionEnd = eventObj.completionEnd as Record<string, unknown> | undefined;
    if (completionEnd) {
      const stopReason = completionEnd.stopReason as string | undefined;
      if (!stopReason || stopReason === 'END_TURN') {
        out.push({ kind: 'turnComplete' });
      } else {
        out.push({ kind: 'ignored', eventName: 'completionEnd' });
      }
    }

    const usageEvent = eventObj.usageEvent as Record<string, unknown> | undefined;
    if (usageEvent) {
      const details = usageEvent.details as Record<string, unknown> | undefined;
      const total = details?.total as Record<string, unknown> | undefined;
      const input = total?.input as Record<string, unknown> | undefined;
      const output = total?.output as Record<string, unknown> | undefined;
      const num = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      out.push({
        kind: 'usage',
        usage: {
          inputSpeechTokens: num(input?.speechTokens),
          inputTextTokens: num(input?.textTokens),
          outputSpeechTokens: num(output?.speechTokens),
          outputTextTokens: num(output?.textTokens),
          totalInputTokens: num(usageEvent.totalInputTokens) ?? num(total?.inputTokens),
          totalOutputTokens: num(usageEvent.totalOutputTokens) ?? num(total?.outputTokens),
        },
      });
    }

    if (out.length === 0) {
      const [name] = Object.keys(eventObj);
      out.push({ kind: 'ignored', eventName: name ?? 'unknown' });
    }
    return out;
  }
}
