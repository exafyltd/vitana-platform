/**
 * VTID-0151: Assistant Core v2 - Multimodal Backend Foundations
 *
 * This service handles the backend capabilities for the global ORB assistant
 * to support multimodal input (audio, video frames, screen frames).
 *
 * Key capabilities:
 * - Live session initialization for Gemini Live API
 * - Frame processing (camera/screen) with vision API
 * - Audio chunk processing with transcription
 *
 * IMPORTANT:
 * - This is READ-ONLY. No destructive tools or deployments.
 * - Does NOT modify Operator Chat endpoints.
 * - All operations logged to OASIS.
 */

import { randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import { callViaRouter } from './llm-router'; // VTID-03579: provider from llm_routing_policy, never hardcoded

// Environment config
const GOOGLE_GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;

// ==================== Types ====================

/**
 * Live Session Init Request
 */
export interface LiveSessionInitRequest {
  sessionId?: string;
  role: string;
  tenant: string;
  route: string;
  selectedId: string;
}

/**
 * Live Session Configuration Response
 */
export interface LiveSessionConfig {
  sessionId: string;
  model: string;
  modes: string[];
  systemPrompt: string;
  apiKeyReference: string;
  createdAt: string;
}

/**
 * Live Session Init Response
 */
export interface LiveSessionInitResponse {
  ok: boolean;
  sessionId: string;
  config?: LiveSessionConfig;
  error?: string;
}

/**
 * Frame Processing Request
 */
export interface FrameProcessRequest {
  sessionId: string;
  frame: string; // base64-encoded image
  source: 'camera' | 'screen';
  route: string;
  selectedId: string;
}

/**
 * Frame Processing Response
 */
export interface FrameProcessResponse {
  ok: boolean;
  sessionId: string;
  frameId: string;
  source: 'camera' | 'screen';
  analysis?: string;
  meta: {
    received_at: string;
    frame_size_bytes: number;
    model_used?: string;
  };
  error?: string;
}

/**
 * Audio Processing Request
 */
export interface AudioProcessRequest {
  sessionId: string;
  audio: string; // base64 pcm16 or wav
  route: string;
  selectedId: string;
}

/**
 * Audio Processing Response
 */
export interface AudioProcessResponse {
  ok: boolean;
  sessionId: string;
  transcript?: string;
  meta: {
    chunk_received_ms: number;
    audio_size_bytes: number;
    model_used?: string;
  };
  error?: string;
}

// ==================== Session Store ====================

/**
 * In-memory session store for live sessions
 * In production, this would use Redis or similar
 */
const sessionStore = new Map<string, {
  config: LiveSessionConfig;
  frameCount: number;
  audioChunkCount: number;
  lastActivity: string;
}>();

// ==================== OASIS Event Logging ====================

/**
 * Log live session started event
 */
async function logLiveSessionStarted(params: {
  sessionId: string;
  role: string;
  tenant: string;
  route: string;
  selectedId: string;
  model: string;
}): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0151',
    type: 'assistant.live.started' as any,
    source: 'assistant-core',
    status: 'info',
    message: `Live session started: ${params.sessionId}`,
    payload: {
      sessionId: params.sessionId,
      role: params.role,
      tenant: params.tenant,
      route: params.route,
      selectedId: params.selectedId,
      model: params.model,
      timestamp: new Date().toISOString()
    }
  }).catch(err => console.warn('[VTID-0151] Failed to log session started:', err.message));
}

/**
 * Log frame received event
 */
async function logFrameReceived(params: {
  sessionId: string;
  frameId: string;
  source: 'camera' | 'screen';
  route: string;
  selectedId: string;
  sizeBytes: number;
  model?: string;
}): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0151',
    type: 'assistant.live.frame' as any,
    source: 'assistant-core',
    status: 'info',
    message: `Frame received from ${params.source}: ${params.frameId}`,
    payload: {
      sessionId: params.sessionId,
      frameId: params.frameId,
      source: params.source,
      route: params.route,
      selectedId: params.selectedId,
      sizeBytes: params.sizeBytes,
      model: params.model || 'none',
      timestamp: new Date().toISOString()
    }
  }).catch(err => console.warn('[VTID-0151] Failed to log frame received:', err.message));
}

/**
 * Log audio chunk received event
 */
async function logAudioReceived(params: {
  sessionId: string;
  chunkId: string;
  route: string;
  selectedId: string;
  sizeBytes: number;
  model?: string;
  hasTranscript: boolean;
}): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0151',
    type: 'assistant.live.audio' as any,
    source: 'assistant-core',
    status: 'info',
    message: `Audio chunk received: ${params.chunkId}`,
    payload: {
      sessionId: params.sessionId,
      chunkId: params.chunkId,
      route: params.route,
      selectedId: params.selectedId,
      sizeBytes: params.sizeBytes,
      model: params.model || 'none',
      hasTranscript: params.hasTranscript,
      timestamp: new Date().toISOString()
    }
  }).catch(err => console.warn('[VTID-0151] Failed to log audio received:', err.message));
}

// ==================== Core Functions ====================

/**
 * Initialize a live session for multimodal input
 *
 * Creates a session configuration that the frontend can use to
 * connect directly to Gemini Live WebSocket in VTID-0152.
 */
export async function initLiveSession(request: LiveSessionInitRequest): Promise<LiveSessionInitResponse> {
  const sessionId = request.sessionId || randomUUID();
  const createdAt = new Date().toISOString();

  console.log(`[VTID-0151] Initializing live session: ${sessionId}`);

  // Compose system prompt with context
  const systemPrompt = composeSystemPrompt({
    role: request.role,
    tenant: request.tenant,
    route: request.route,
    selectedId: request.selectedId
  });

  // Select model based on availability
  const model = GOOGLE_GEMINI_API_KEY ? 'gemini-2.0-flash-exp' : 'gemini-2.0-flash-exp';

  // Create session configuration
  const config: LiveSessionConfig = {
    sessionId,
    model,
    modes: ['AUDIO', 'VIDEO', 'TEXT'],
    systemPrompt,
    apiKeyReference: GOOGLE_GEMINI_API_KEY ? 'configured' : 'not-configured',
    createdAt
  };

  // Store session
  sessionStore.set(sessionId, {
    config,
    frameCount: 0,
    audioChunkCount: 0,
    lastActivity: createdAt
  });

  // Log to OASIS
  await logLiveSessionStarted({
    sessionId,
    role: request.role,
    tenant: request.tenant,
    route: request.route,
    selectedId: request.selectedId,
    model
  });

  console.log(`[VTID-0151] Live session initialized: ${sessionId} (model: ${model})`);

  return {
    ok: true,
    sessionId,
    config
  };
}

/**
 * Compose the system prompt for the assistant
 */
function composeSystemPrompt(context: {
  role: string;
  tenant: string;
  route: string;
  selectedId: string;
}): string {
  return `You are the Vitana Global Assistant, a helpful AI assistant integrated into the Vitana platform.

IMPORTANT: You are NOT the Operator. You are the global ORB assistant available across all screens.

Context:
- User Role: ${context.role}
- Tenant: ${context.tenant}
- Current Route: ${context.route}
- Selected Item ID: ${context.selectedId || 'none'}

Capabilities:
- You can see and analyze images from camera or screen share
- You can hear and transcribe audio input
- You provide helpful, concise responses about the current screen context
- You help users understand and navigate the Vitana platform

Guidelines:
- Be helpful and concise
- Focus on the current screen context
- Do not perform any destructive actions
- Do not create tasks or deployments (you are read-only)
- If asked about Operator functions, direct users to the Operator Console

Current timestamp: ${new Date().toISOString()}`;
}

/**
 * Process a frame (camera or screen capture)
 *
 * MVP: Logs frame metadata and optionally sends to Gemini Vision for analysis
 */
export async function processFrame(request: FrameProcessRequest): Promise<FrameProcessResponse> {
  const frameId = randomUUID();
  const receivedAt = new Date().toISOString();

  console.log(`[VTID-0151] Processing frame: ${frameId} (source: ${request.source})`);

  // Validate session
  const session = sessionStore.get(request.sessionId);
  if (!session) {
    console.warn(`[VTID-0151] Session not found: ${request.sessionId}`);
    return {
      ok: false,
      sessionId: request.sessionId,
      frameId,
      source: request.source,
      meta: {
        received_at: receivedAt,
        frame_size_bytes: 0
      },
      error: 'Session not found. Please initialize a session first.'
    };
  }

  // Calculate frame size
  const frameSizeBytes = Buffer.byteLength(request.frame, 'base64');

  // Update session
  session.frameCount++;
  session.lastActivity = receivedAt;

  // Log to OASIS
  await logFrameReceived({
    sessionId: request.sessionId,
    frameId,
    source: request.source,
    route: request.route,
    selectedId: request.selectedId,
    sizeBytes: frameSizeBytes,
    model: undefined // VTID-03579: resolved by the router per call, not known here
  });

  // VTID-03579: no longer gated on GOOGLE_GEMINI_API_KEY. With Google switched
  // off that key is unset, so the old gate would have silently disabled frame
  // analysis entirely rather than routing it. Whether a provider is available
  // is the router's question to answer, not this call site's.
  let analysis: string | undefined;
  let modelUsed: string | undefined;

  {
    try {
      const visionResult = await analyzeFrameWithGemini(request.frame, request.source);
      analysis = visionResult.analysis;
      modelUsed = visionResult.model;
    } catch (err: any) {
      console.warn(`[VTID-0151] Vision analysis failed: ${err.message}`);
      // Non-fatal - continue without analysis
    }
  }

  console.log(`[VTID-0151] Frame processed: ${frameId} (${frameSizeBytes} bytes)`);

  return {
    ok: true,
    sessionId: request.sessionId,
    frameId,
    source: request.source,
    analysis,
    meta: {
      received_at: receivedAt,
      frame_size_bytes: frameSizeBytes,
      model_used: modelUsed
    }
  };
}

/**
 * Analyze a frame using Gemini Vision API
 */
async function analyzeFrameWithGemini(frameBase64: string, source: 'camera' | 'screen'): Promise<{
  analysis: string;
  model: string;
}> {
  const prompt = source === 'screen'
    ? 'Briefly describe what you see on this screen. Focus on the main UI elements and any important information visible.'
    : 'Briefly describe what you see in this camera frame. Focus on the main subjects and context.';

  // VTID-03579: was a hardcoded gemini-2.5-flash call against
  // generativelanguage.googleapis.com. Routed now via the `vision` stage —
  // Bedrock Claude accepts the same base64 image blocks, so this is a provider
  // swap and not a capability change.
  const r = await callViaRouter('vision', prompt, {
    service: 'assistant-core-frame',
    maxTokens: 256,
    image: { base64: frameBase64, mimeType: 'image/jpeg' },
  });

  if (!r.ok || !r.text) {
    throw new Error(
      `Frame analysis failed via ${r.provider ?? 'router'}: ${r.error ?? 'empty response'}`,
    );
  }

  return {
    analysis: r.text,
    model: r.model ?? 'router',
  };
}

/**
 * Process an audio chunk
 *
 * MVP: Logs audio metadata and optionally sends to Gemini for transcription
 */
export async function processAudio(request: AudioProcessRequest): Promise<AudioProcessResponse> {
  const chunkId = randomUUID();
  const receivedAt = Date.now();

  console.log(`[VTID-0151] Processing audio chunk: ${chunkId}`);

  // Validate session
  const session = sessionStore.get(request.sessionId);
  if (!session) {
    console.warn(`[VTID-0151] Session not found: ${request.sessionId}`);
    return {
      ok: false,
      sessionId: request.sessionId,
      meta: {
        chunk_received_ms: receivedAt,
        audio_size_bytes: 0
      },
      error: 'Session not found. Please initialize a session first.'
    };
  }

  // Calculate audio size
  const audioSizeBytes = Buffer.byteLength(request.audio, 'base64');

  // Update session
  session.audioChunkCount++;
  session.lastActivity = new Date().toISOString();

  // VTID-03579: transcription is disabled, not merely unconfigured — see
  // `transcribeAudioWithGemini` for why no routing change can restore it.
  // Left as an explicit constant rather than a live call that throws on every
  // chunk: this path receives audio continuously, and a per-chunk warning would
  // be pure log noise for a known, documented gap.
  const transcript: string | undefined = undefined;
  const modelUsed: string | undefined = undefined;
  void transcribeAudioWithGemini;

  // Log to OASIS
  await logAudioReceived({
    sessionId: request.sessionId,
    chunkId,
    route: request.route,
    selectedId: request.selectedId,
    sizeBytes: audioSizeBytes,
    model: modelUsed,
    hasTranscript: !!transcript
  });

  console.log(`[VTID-0151] Audio chunk processed: ${chunkId} (${audioSizeBytes} bytes)`);

  return {
    ok: true,
    sessionId: request.sessionId,
    transcript,
    meta: {
      chunk_received_ms: receivedAt,
      audio_size_bytes: audioSizeBytes,
      model_used: modelUsed
    }
  };
}

/**
 * Transcribe audio using Gemini Audio API
 */
async function transcribeAudioWithGemini(_audioBase64: string): Promise<{
  transcript: string;
  model: string;
}> {
  // VTID-03579: this path is OFF, deliberately and visibly.
  //
  // It used to POST raw audio to gemini-2.5-flash. Google is switched off
  // platform-wide, and unlike the frame path above this one CANNOT simply be
  // rerouted: no Anthropic model — on Bedrock or anywhere else — accepts audio
  // input. Speech is a different modality, not a different provider.
  //
  // The AWS replacement is Amazon Transcribe, which is a new adapter and its
  // own build, not a routing change. Until that exists this throws with the
  // real reason rather than returning an empty transcript, because an empty
  // string here is indistinguishable from "the user said nothing" and would
  // silently corrupt the session transcript.
  throw new Error(
    'Audio transcription is unavailable: the Google provider is disabled and no ' +
      'Anthropic/Bedrock model accepts audio input. Needs an Amazon Transcribe adapter (VTID-03579).',
  );
}

/**
 * Get session info (for health/debug)
 */
export function getSessionInfo(sessionId: string): {
  exists: boolean;
  config?: LiveSessionConfig;
  stats?: {
    frameCount: number;
    audioChunkCount: number;
    lastActivity: string;
  };
} {
  const session = sessionStore.get(sessionId);
  if (!session) {
    return { exists: false };
  }

  return {
    exists: true,
    config: session.config,
    stats: {
      frameCount: session.frameCount,
      audioChunkCount: session.audioChunkCount,
      lastActivity: session.lastActivity
    }
  };
}

// ==================== Exports ====================

export default {
  initLiveSession,
  processFrame,
  processAudio,
  getSessionInfo
};
