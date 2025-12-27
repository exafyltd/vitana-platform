/**
 * DEV-COMHU-2025-0014: ORB Multimodal v1 - Live Voice Session
 * VTID-0135: ORB Voice Conversation Enablement (Phase A)
 *
 * SSE endpoint for real-time voice interaction with Gemini API.
 *
 * Endpoints:
 * - GET  /api/v1/orb/live     - SSE stream for real-time responses
 * - POST /api/v1/orb/audio    - Audio chunk submission
 * - POST /api/v1/orb/start    - Start live session
 * - POST /api/v1/orb/stop     - Stop live session
 * - POST /api/v1/orb/mute     - Toggle mute state
 * - POST /api/v1/orb/chat     - VTID-0135: Voice conversation chat (Vertex routing)
 * - GET  /api/v1/orb/health   - Health check
 *
 * VTID-0135 Changes:
 * - Added POST /api/v1/orb/chat endpoint using Vertex routing (same as Operator Console)
 * - Added OASIS event emission for ORB sessions and turns
 * - Added conversation_id continuity support
 *
 * IMPORTANT:
 * - POST /orb/chat uses Vertex AI routing (same as Operator Console)
 * - Other endpoints still use direct Gemini API
 * - READ-ONLY: No state mutation, no tool execution
 * - CSP compliant: No inline scripts/styles
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { processWithGemini } from '../services/gemini-operator';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// Types & Constants
// =============================================================================

interface OrbLiveSession {
  sessionId: string;
  tenant: string;
  role: string;
  route: string;
  selectedId: string;
  muted: boolean;
  active: boolean;
  createdAt: Date;
  lastActivity: Date;
  audioChunksReceived: number;
  sseResponse: Response | null;
}

interface StartMessage {
  type: 'start';
  sessionId?: string;
  tenant: string;
  role: string;
  route: string;
  selectedId?: string;
  response?: { modalities: string[] };
}

interface AudioChunkMessage {
  type: 'audio_chunk';
  sessionId: string;
  mime: string;
  data_b64: string;
}

interface MuteMessage {
  type: 'mute';
  sessionId: string;
  muted: boolean;
}

interface StopMessage {
  type: 'stop';
  sessionId: string;
}

// In-memory session store (dev sandbox only)
const sessions = new Map<string, OrbLiveSession>();

// Session timeout: 30 minutes
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// Allowed origins (dev sandbox)
const ALLOWED_ORIGINS = [
  'https://gateway-536750820055.us-central1.run.app',
  'http://localhost:8080',
  'http://localhost:3000',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:3000'
];

// Connection limit per IP (dev sandbox)
const MAX_CONNECTIONS_PER_IP = 5;
const connectionCountByIP = new Map<string, number>();

// Gemini API configuration
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-2.0-flash-exp';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// =============================================================================
// VTID-0135: Voice Conversation Types & Stores
// =============================================================================

/**
 * VTID-0135: ORB Chat Request (voice conversation)
 */
interface OrbChatRequest {
  orb_session_id: string;
  conversation_id: string | null;
  input_text: string;
  meta?: {
    mode?: string;
    source?: string;
    vtid?: string | null;
  };
}

/**
 * VTID-0135: ORB Chat Response
 */
interface OrbChatResponse {
  ok: boolean;
  conversation_id: string;
  reply_text: string;
  meta: {
    provider: string;
    model: string;
    mode: string;
    vtid?: string;
  };
  error?: string;
}

/**
 * VTID-0135: Conversation context for continuity
 */
interface OrbConversation {
  conversationId: string;
  orbSessionId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: Date;
  lastActivity: Date;
}

// VTID-0135: In-memory conversation store (session-scoped)
const orbConversations = new Map<string, OrbConversation>();

// VTID-0135: Conversation timeout: 30 minutes
const CONVERSATION_TIMEOUT_MS = 30 * 60 * 1000;

// =============================================================================
// VTID-01039: ORB Session Transcript Store
// =============================================================================

/**
 * VTID-01039: Transcript turn for persisted storage
 */
interface OrbTranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: string;
}

/**
 * VTID-01039: Persisted transcript for ORB session
 */
interface OrbSessionTranscript {
  orb_session_id: string;
  conversation_id: string | null;
  turns: OrbTranscriptTurn[];
  started_at: string;
  finalized: boolean;
  summary?: {
    title: string;
    bullets: string[];
    actions: string[];
    turns_count: number;
    duration_sec: number;
  };
}

// VTID-01039: In-memory transcript store
const orbTranscripts = new Map<string, OrbSessionTranscript>();

/**
 * VTID-01039: Cleanup expired transcripts (retain for 1 hour after finalization)
 */
function cleanupExpiredTranscripts(): void {
  const now = Date.now();
  const TRANSCRIPT_RETENTION_MS = 60 * 60 * 1000; // 1 hour

  for (const [sessionId, transcript] of orbTranscripts.entries()) {
    if (transcript.finalized) {
      const startedAt = new Date(transcript.started_at).getTime();
      if (now - startedAt > TRANSCRIPT_RETENTION_MS) {
        console.log(`[VTID-01039] Transcript expired: ${sessionId}`);
        orbTranscripts.delete(sessionId);
      }
    }
  }
}

// Cleanup expired transcripts every 10 minutes
setInterval(cleanupExpiredTranscripts, 10 * 60 * 1000);

/**
 * VTID-0135: Cleanup expired conversations
 */
function cleanupExpiredConversations(): void {
  const now = Date.now();
  for (const [convId, conv] of orbConversations.entries()) {
    if (now - conv.lastActivity.getTime() > CONVERSATION_TIMEOUT_MS) {
      console.log(`[VTID-0135] Conversation expired: ${convId}`);
      orbConversations.delete(convId);
    }
  }
}

// Cleanup expired conversations every 5 minutes
setInterval(cleanupExpiredConversations, 5 * 60 * 1000);

// =============================================================================
// VTID-0135: OASIS Event Emission for ORB
// =============================================================================

/**
 * VTID-0135: Emit orb.session.started event
 */
async function emitOrbSessionStarted(orbSessionId: string, conversationId: string): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0135',
    type: 'orb.session.started',
    source: 'command-hub',
    status: 'info',
    message: `ORB voice session started: ${orbSessionId}`,
    payload: {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      metadata: { mode: 'orb_voice' }
    }
  }).catch(err => console.warn('[VTID-0135] Failed to emit orb.session.started:', err.message));
}

/**
 * VTID-0135: Emit orb.turn.received event
 */
async function emitOrbTurnReceived(
  orbSessionId: string,
  conversationId: string,
  inputText: string
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0135',
    type: 'orb.turn.received',
    source: 'command-hub',
    status: 'info',
    message: `ORB turn received: ${inputText.substring(0, 50)}...`,
    payload: {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      input_length: inputText.length,
      metadata: { mode: 'orb_voice' }
    }
  }).catch(err => console.warn('[VTID-0135] Failed to emit orb.turn.received:', err.message));
}

/**
 * VTID-0135: Emit orb.turn.responded event
 */
async function emitOrbTurnResponded(
  orbSessionId: string,
  conversationId: string,
  replyText: string,
  provider: string
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0135',
    type: 'orb.turn.responded',
    source: 'command-hub',
    status: 'success',
    message: `ORB turn responded via ${provider}`,
    payload: {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      reply_length: replyText.length,
      provider,
      metadata: { mode: 'orb_voice' }
    }
  }).catch(err => console.warn('[VTID-0135] Failed to emit orb.turn.responded:', err.message));
}

/**
 * VTID-0135: Emit orb.session.ended event
 */
async function emitOrbSessionEnded(orbSessionId: string, conversationId: string): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-0135',
    type: 'orb.session.ended',
    source: 'command-hub',
    status: 'info',
    message: `ORB voice session ended: ${orbSessionId}`,
    payload: {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      metadata: { mode: 'orb_voice' }
    }
  }).catch(err => console.warn('[VTID-0135] Failed to emit orb.session.ended:', err.message));
}

// =============================================================================
// Helpers
// =============================================================================

function validateOrigin(req: Request): boolean {
  const origin = req.get('origin') || req.get('referer') || '';
  if (!origin) return true; // Allow requests without origin (e.g., curl)
  return ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed));
}

function getClientIP(req: Request): string {
  return (req.get('x-forwarded-for') || req.ip || 'unknown').split(',')[0].trim();
}

function checkConnectionLimit(ip: string): boolean {
  const count = connectionCountByIP.get(ip) || 0;
  return count < MAX_CONNECTIONS_PER_IP;
}

function incrementConnection(ip: string): void {
  const count = connectionCountByIP.get(ip) || 0;
  connectionCountByIP.set(ip, count + 1);
}

function decrementConnection(ip: string): void {
  const count = connectionCountByIP.get(ip) || 0;
  if (count > 0) {
    connectionCountByIP.set(ip, count - 1);
  }
}

function generateSystemInstruction(session: OrbLiveSession): string {
  return `You are VITANA ORB, a voice-first multimodal assistant.

Context:
- tenant: ${session.tenant}
- role: ${session.role}
- route: ${session.route}
- selectedId: ${session.selectedId || 'none'}

Operating mode:
- Voice conversation is primary.
- Always listening while ORB overlay is open.
- Read-only: do not mutate system state.
- Be concise, contextual, and helpful.`;
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
      console.log(`[ORB-LIVE] Session expired: ${sessionId}`);
      if (session.sseResponse) {
        try {
          session.sseResponse.end();
        } catch (e) {
          // Ignore
        }
      }
      sessions.delete(sessionId);
    }
  }
}

// Cleanup expired sessions every 5 minutes
setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

/**
 * Call Gemini API with audio transcription request
 * Uses Gemini API directly (NOT Vertex)
 */
async function callGeminiWithAudio(
  session: OrbLiveSession,
  audioBase64: string,
  mimeType: string
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!GEMINI_API_KEY) {
    return { ok: false, error: 'GOOGLE_GEMINI_API_KEY not configured' };
  }

  try {
    const systemInstruction = generateSystemInstruction(session);

    // Build request for Gemini API
    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              inline_data: {
                mime_type: mimeType === 'audio/pcm;rate=16000' ? 'audio/wav' : mimeType,
                data: audioBase64
              }
            },
            {
              text: 'Please respond to this voice input. Be concise and helpful.'
            }
          ]
        }
      ],
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 256,
        topP: 0.9
      }
    };

    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ORB-LIVE] Gemini API error: ${response.status} - ${errorText}`);
      return { ok: false, error: `Gemini API error: ${response.status}` };
    }

    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

    // Extract text from response
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!text) {
      return { ok: false, error: 'No response from Gemini' };
    }

    return { ok: true, text };
  } catch (error: any) {
    console.error(`[ORB-LIVE] Gemini API call failed:`, error);
    return { ok: false, error: error.message || 'Failed to call Gemini API' };
  }
}

/**
 * Call Gemini API with text input (for testing/fallback)
 */
async function callGeminiWithText(
  session: OrbLiveSession,
  userText: string
): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!GEMINI_API_KEY) {
    return { ok: false, error: 'GOOGLE_GEMINI_API_KEY not configured' };
  }

  try {
    const systemInstruction = generateSystemInstruction(session);

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [{ text: userText }]
        }
      ],
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 256,
        topP: 0.9
      }
    };

    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ORB-LIVE] Gemini API error: ${response.status} - ${errorText}`);
      return { ok: false, error: `Gemini API error: ${response.status}` };
    }

    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!text) {
      return { ok: false, error: 'No response from Gemini' };
    }

    return { ok: true, text };
  } catch (error: any) {
    console.error(`[ORB-LIVE] Gemini API call failed:`, error);
    return { ok: false, error: error.message || 'Failed to call Gemini API' };
  }
}

// =============================================================================
// Routes
// =============================================================================

/**
 * GET /live - SSE endpoint for real-time responses
 */
router.get('/live', (req: Request, res: Response) => {
  console.log('[ORB-LIVE] SSE connection request');

  // Validate origin
  if (!validateOrigin(req)) {
    console.warn('[ORB-LIVE] Origin not allowed:', req.get('origin'));
    return res.status(403).json({ ok: false, error: 'Origin not allowed' });
  }

  // Check connection limit
  const clientIP = getClientIP(req);
  if (!checkConnectionLimit(clientIP)) {
    console.warn('[ORB-LIVE] Connection limit exceeded for IP:', clientIP);
    return res.status(429).json({ ok: false, error: 'Too many connections' });
  }

  // Get session ID from query
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: 'sessionId required' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  // Setup SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Track connection
  incrementConnection(clientIP);
  session.sseResponse = res;
  session.lastActivity = new Date();

  // Send ready event
  res.write(`data: ${JSON.stringify({ type: 'ready', meta: { model: GEMINI_MODEL } })}\n\n`);

  // Heartbeat every 30 seconds
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`:heartbeat\n\n`);
    } catch (e) {
      clearInterval(heartbeatInterval);
    }
  }, 30000);

  // Handle client disconnect
  req.on('close', () => {
    console.log(`[ORB-LIVE] SSE connection closed for session: ${sessionId}`);
    clearInterval(heartbeatInterval);
    decrementConnection(clientIP);
    if (session.sseResponse === res) {
      session.sseResponse = null;
    }
  });
});

/**
 * POST /start - Start a new live session
 */
router.post('/start', (req: Request, res: Response) => {
  console.log('[ORB-LIVE] POST /start');

  // Validate origin
  if (!validateOrigin(req)) {
    return res.status(403).json({ ok: false, error: 'Origin not allowed' });
  }

  const body = req.body as StartMessage;

  if (!body.tenant || !body.role || !body.route) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: tenant, role, route'
    });
  }

  // Generate or use provided session ID
  const sessionId = body.sessionId || `orb-${randomUUID()}`;

  // Create session
  const session: OrbLiveSession = {
    sessionId,
    tenant: body.tenant,
    role: body.role,
    route: body.route,
    selectedId: body.selectedId || '',
    muted: false,
    active: true,
    createdAt: new Date(),
    lastActivity: new Date(),
    audioChunksReceived: 0,
    sseResponse: null
  };

  sessions.set(sessionId, session);

  console.log(`[ORB-LIVE] Session created: ${sessionId}`);

  return res.status(200).json({
    ok: true,
    sessionId,
    meta: { model: GEMINI_MODEL }
  });
});

/**
 * POST /audio - Submit audio chunk
 */
router.post('/audio', async (req: Request, res: Response) => {
  const body = req.body as AudioChunkMessage;

  if (!body.sessionId || !body.data_b64) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: sessionId, data_b64'
    });
  }

  const session = sessions.get(body.sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  if (!session.active) {
    return res.status(400).json({ ok: false, error: 'Session not active' });
  }

  if (session.muted) {
    return res.status(200).json({ ok: true, muted: true });
  }

  // Update activity
  session.lastActivity = new Date();
  session.audioChunksReceived++;

  const mime = body.mime || 'audio/pcm;rate=16000';

  // Process audio with Gemini
  console.log(`[ORB-LIVE] Processing audio chunk for session: ${body.sessionId}, chunk #${session.audioChunksReceived}`);

  const result = await callGeminiWithAudio(session, body.data_b64, mime);

  if (result.ok && result.text) {
    // Send response via SSE if connected
    if (session.sseResponse) {
      try {
        session.sseResponse.write(`data: ${JSON.stringify({ type: 'assistant_text', text: result.text })}\n\n`);
      } catch (e) {
        console.error('[ORB-LIVE] Failed to send SSE response:', e);
      }
    }

    return res.status(200).json({
      ok: true,
      text: result.text
    });
  } else {
    // Send error via SSE if connected
    if (session.sseResponse) {
      try {
        session.sseResponse.write(`data: ${JSON.stringify({ type: 'error', message: result.error })}\n\n`);
      } catch (e) {
        // Ignore
      }
    }

    return res.status(200).json({
      ok: false,
      error: result.error
    });
  }
});

/**
 * POST /text - Submit text message (fallback/testing)
 */
router.post('/text', async (req: Request, res: Response) => {
  const body = req.body as { sessionId: string; text: string };

  if (!body.sessionId || !body.text) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: sessionId, text'
    });
  }

  const session = sessions.get(body.sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  if (!session.active) {
    return res.status(400).json({ ok: false, error: 'Session not active' });
  }

  // Update activity
  session.lastActivity = new Date();

  console.log(`[ORB-LIVE] Processing text for session: ${body.sessionId}`);

  const result = await callGeminiWithText(session, body.text);

  if (result.ok && result.text) {
    // Send response via SSE if connected
    if (session.sseResponse) {
      try {
        session.sseResponse.write(`data: ${JSON.stringify({ type: 'assistant_text', text: result.text })}\n\n`);
      } catch (e) {
        console.error('[ORB-LIVE] Failed to send SSE response:', e);
      }
    }

    return res.status(200).json({
      ok: true,
      text: result.text
    });
  } else {
    return res.status(200).json({
      ok: false,
      error: result.error
    });
  }
});

/**
 * POST /mute - Toggle mute state
 */
router.post('/mute', (req: Request, res: Response) => {
  const body = req.body as MuteMessage;

  if (!body.sessionId || typeof body.muted !== 'boolean') {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: sessionId, muted'
    });
  }

  const session = sessions.get(body.sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  session.muted = body.muted;
  session.lastActivity = new Date();

  console.log(`[ORB-LIVE] Session ${body.sessionId} muted: ${body.muted}`);

  return res.status(200).json({
    ok: true,
    muted: session.muted
  });
});

/**
 * POST /stop - Stop live session
 */
router.post('/stop', (req: Request, res: Response) => {
  const body = req.body as StopMessage;

  if (!body.sessionId) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required field: sessionId'
    });
  }

  const session = sessions.get(body.sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found' });
  }

  // Close SSE connection
  if (session.sseResponse) {
    try {
      session.sseResponse.write(`data: ${JSON.stringify({ type: 'session_ended' })}\n\n`);
      session.sseResponse.end();
    } catch (e) {
      // Ignore
    }
    session.sseResponse = null;
  }

  session.active = false;
  sessions.delete(body.sessionId);

  console.log(`[ORB-LIVE] Session stopped: ${body.sessionId}`);

  return res.status(200).json({ ok: true });
});

/**
 * VTID-0135: POST /chat - Voice conversation chat (Vertex routing)
 *
 * Request JSON:
 * {
 *   "orb_session_id": "uuid",
 *   "conversation_id": "string|null",
 *   "input_text": "string",
 *   "meta": { "mode": "orb_voice", "source": "command-hub", "vtid": null }
 * }
 *
 * Response JSON:
 * {
 *   "ok": true,
 *   "conversation_id": "string",
 *   "reply_text": "string",
 *   "meta": { "provider": "vertex", "model": "gemini-*", "mode": "orb_voice" }
 * }
 */
router.post('/chat', async (req: Request, res: Response) => {
  const body = req.body as OrbChatRequest;

  console.log('[VTID-0135] POST /orb/chat received');

  // Validate required fields
  if (!body.orb_session_id || !body.input_text) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: orb_session_id, input_text'
    });
  }

  const orbSessionId = body.orb_session_id;
  const inputText = body.input_text.trim();

  if (!inputText) {
    return res.status(400).json({
      ok: false,
      error: 'input_text cannot be empty'
    });
  }

  // Get or create conversation
  let conversationId = body.conversation_id;
  let conversation: OrbConversation;
  let isNewSession = false;

  if (conversationId && orbConversations.has(conversationId)) {
    // Continue existing conversation
    conversation = orbConversations.get(conversationId)!;
    conversation.lastActivity = new Date();
    console.log(`[VTID-0135] Continuing conversation: ${conversationId}`);
  } else {
    // Create new conversation
    conversationId = `orb-conv-${randomUUID()}`;
    conversation = {
      conversationId,
      orbSessionId,
      history: [],
      createdAt: new Date(),
      lastActivity: new Date()
    };
    orbConversations.set(conversationId, conversation);
    isNewSession = true;
    console.log(`[VTID-0135] Created new conversation: ${conversationId}`);

    // Emit session started event
    await emitOrbSessionStarted(orbSessionId, conversationId);
  }

  // VTID-01039: Append user turn to transcript (replaces per-turn OASIS event)
  // Get or create transcript for this session
  let transcript = orbTranscripts.get(orbSessionId);
  if (!transcript) {
    transcript = {
      orb_session_id: orbSessionId,
      conversation_id: conversationId,
      turns: [],
      started_at: new Date().toISOString(),
      finalized: false
    };
    orbTranscripts.set(orbSessionId, transcript);
    console.log(`[VTID-01039] Transcript created via /chat: ${orbSessionId}`);
  }

  // Append user turn
  transcript.turns.push({
    role: 'user',
    text: inputText,
    ts: new Date().toISOString()
  });

  try {
    // Build thread ID for Gemini processing
    const threadId = `orb-${orbSessionId}`;

    // Process with Gemini using Vertex routing (same as Operator Console)
    // VTID-0135: Uses processWithGemini which prioritizes Vertex AI > Gemini API > Local
    const geminiResponse = await processWithGemini({
      text: inputText,
      threadId,
      conversationHistory: conversation.history,
      conversationId
    });

    const replyText = geminiResponse.reply || 'I apologize, but I could not generate a response.';
    const provider = (geminiResponse.meta?.provider as string) || 'vertex';
    const model = (geminiResponse.meta?.model as string) || 'gemini-2.5-pro';

    // Update conversation history
    conversation.history.push({ role: 'user', content: inputText });
    conversation.history.push({ role: 'assistant', content: replyText });

    // Limit history to last 20 turns (10 pairs) to avoid context overflow
    if (conversation.history.length > 20) {
      conversation.history = conversation.history.slice(-20);
    }

    // VTID-01039: Append assistant turn to transcript (replaces per-turn OASIS event)
    if (transcript) {
      transcript.turns.push({
        role: 'assistant',
        text: replyText,
        ts: new Date().toISOString()
      });
    }

    console.log(`[VTID-0135] Chat response generated via ${provider}`);

    const response: OrbChatResponse = {
      ok: true,
      conversation_id: conversationId,
      reply_text: replyText,
      meta: {
        provider,
        model,
        mode: 'orb_voice',
        vtid: 'VTID-0135'
      }
    };

    return res.status(200).json(response);

  } catch (error: any) {
    console.error('[VTID-0135] Chat processing error:', error);

    return res.status(500).json({
      ok: false,
      conversation_id: conversationId,
      reply_text: '',
      error: error.message || 'Failed to process chat request',
      meta: {
        provider: 'error',
        model: 'none',
        mode: 'orb_voice',
        vtid: 'VTID-0135'
      }
    });
  }
});

/**
 * VTID-0135: POST /end-session - End an ORB voice conversation session
 * VTID-01039: Now finalizes session and emits ONE orb.session.summary event
 */
router.post('/end-session', async (req: Request, res: Response) => {
  const { orb_session_id, conversation_id } = req.body;

  if (!orb_session_id) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required field: orb_session_id'
    });
  }

  console.log(`[VTID-01039] Ending session: ${orb_session_id}`);

  // Find and remove conversation
  if (conversation_id && orbConversations.has(conversation_id)) {
    orbConversations.delete(conversation_id);
  }

  // VTID-01039: Finalize transcript and emit summary instead of orb.session.ended
  const transcript = orbTranscripts.get(orb_session_id);
  if (transcript && !transcript.finalized) {
    // Generate summary
    const summaryContent = generateSessionSummary(transcript.turns);

    // Calculate duration
    const durationSec = Math.round(
      (Date.now() - new Date(transcript.started_at).getTime()) / 1000
    );

    // Store summary
    transcript.summary = {
      ...summaryContent,
      turns_count: transcript.turns.length,
      duration_sec: durationSec
    };
    transcript.finalized = true;

    // Emit ONE orb.session.summary event to OASIS
    await emitOasisEvent({
      vtid: 'VTID-01039',
      type: 'orb.session.summary',
      source: 'command-hub',
      status: 'success',
      message: summaryContent.title,
      payload: {
        orb_session_id,
        conversation_id: transcript.conversation_id || conversation_id || null,
        turns_count: transcript.summary.turns_count,
        duration_sec: transcript.summary.duration_sec,
        summary: {
          title: summaryContent.title,
          bullets: summaryContent.bullets,
          actions: summaryContent.actions
        },
        metadata: { mode: 'orb_voice' }
      }
    }).catch(err => console.warn('[VTID-01039] Failed to emit orb.session.summary:', err.message));

    console.log(`[VTID-01039] Session finalized: ${orb_session_id} (${transcript.summary.turns_count} turns, ${durationSec}s)`);
  }

  return res.status(200).json({ ok: true });
});

// =============================================================================
// VTID-01039: ORB Session Aggregation Endpoints
// =============================================================================

/**
 * VTID-01039: Generate summary from transcript turns
 * Creates title (max 80 chars), bullets (max 3), actions (max 3)
 */
function generateSessionSummary(turns: OrbTranscriptTurn[]): {
  title: string;
  bullets: string[];
  actions: string[];
} {
  if (turns.length === 0) {
    return {
      title: 'Empty ORB session',
      bullets: [],
      actions: []
    };
  }

  // Extract key topics from user turns
  const userTurns = turns.filter(t => t.role === 'user').map(t => t.text);
  const assistantTurns = turns.filter(t => t.role === 'assistant').map(t => t.text);

  // Generate title from first user message (truncated to 80 chars)
  let title = 'ORB voice conversation';
  if (userTurns.length > 0) {
    const firstQuery = userTurns[0].substring(0, 70);
    title = userTurns.length > 1
      ? `${firstQuery}... (+${userTurns.length - 1} more)`
      : firstQuery;
    if (title.length > 80) {
      title = title.substring(0, 77) + '...';
    }
  }

  // Generate bullets from assistant responses (max 3)
  const bullets: string[] = [];
  for (let i = 0; i < Math.min(3, assistantTurns.length); i++) {
    const response = assistantTurns[i];
    // Extract first sentence or first 100 chars
    const firstSentence = response.split(/[.!?]/)[0];
    const bullet = firstSentence.length > 100
      ? firstSentence.substring(0, 97) + '...'
      : firstSentence;
    if (bullet.trim()) {
      bullets.push(bullet.trim());
    }
  }

  // Generate actions from assistant responses (look for action keywords)
  const actions: string[] = [];
  const actionKeywords = ['you can', 'you should', 'try', 'consider', 'recommend', 'suggest'];
  for (const response of assistantTurns) {
    if (actions.length >= 3) break;
    const lowerResponse = response.toLowerCase();
    for (const keyword of actionKeywords) {
      if (lowerResponse.includes(keyword) && actions.length < 3) {
        // Extract the sentence containing the action keyword
        const sentences = response.split(/[.!?]/);
        for (const sentence of sentences) {
          if (sentence.toLowerCase().includes(keyword) && actions.length < 3) {
            const action = sentence.trim().substring(0, 100);
            if (action && !actions.includes(action)) {
              actions.push(action);
              break;
            }
          }
        }
        break;
      }
    }
  }

  return { title, bullets, actions };
}

/**
 * VTID-01039: POST /session/append - Append a turn to transcript
 *
 * Request:
 * {
 *   "orb_session_id": "uuid",
 *   "conversation_id": "string|null",
 *   "role": "user|assistant",
 *   "text": "string",
 *   "ts": "iso"
 * }
 */
router.post('/session/append', (req: Request, res: Response) => {
  const { orb_session_id, conversation_id, role, text, ts } = req.body;

  if (!orb_session_id || !role || !text) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: orb_session_id, role, text'
    });
  }

  if (role !== 'user' && role !== 'assistant') {
    return res.status(400).json({
      ok: false,
      error: 'role must be "user" or "assistant"'
    });
  }

  // Get or create transcript
  let transcript = orbTranscripts.get(orb_session_id);
  if (!transcript) {
    transcript = {
      orb_session_id,
      conversation_id: conversation_id || null,
      turns: [],
      started_at: new Date().toISOString(),
      finalized: false
    };
    orbTranscripts.set(orb_session_id, transcript);
    console.log(`[VTID-01039] Transcript created: ${orb_session_id}`);
  }

  if (transcript.finalized) {
    return res.status(400).json({
      ok: false,
      error: 'Session already finalized'
    });
  }

  // Update conversation_id if provided and not set
  if (conversation_id && !transcript.conversation_id) {
    transcript.conversation_id = conversation_id;
  }

  // Append turn
  transcript.turns.push({
    role,
    text,
    ts: ts || new Date().toISOString()
  });

  console.log(`[VTID-01039] Turn appended to ${orb_session_id}: ${role} (${text.length} chars)`);

  return res.status(200).json({
    ok: true,
    orb_session_id,
    turns_count: transcript.turns.length
  });
});

/**
 * VTID-01039: POST /session/finalize - Finalize session and emit summary event
 *
 * Request:
 * {
 *   "orb_session_id": "uuid",
 *   "conversation_id": "string|null",
 *   "turns_count": 12,
 *   "duration_sec": 180
 * }
 */
router.post('/session/finalize', async (req: Request, res: Response) => {
  const { orb_session_id, conversation_id, turns_count, duration_sec } = req.body;

  if (!orb_session_id) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required field: orb_session_id'
    });
  }

  // Get transcript
  const transcript = orbTranscripts.get(orb_session_id);
  if (!transcript) {
    return res.status(404).json({
      ok: false,
      error: 'Session transcript not found'
    });
  }

  if (transcript.finalized) {
    return res.status(400).json({
      ok: false,
      error: 'Session already finalized'
    });
  }

  // Generate summary
  const summaryContent = generateSessionSummary(transcript.turns);

  // Calculate duration if not provided
  const actualDuration = duration_sec || (
    transcript.turns.length > 0
      ? Math.round((Date.now() - new Date(transcript.started_at).getTime()) / 1000)
      : 0
  );

  // Store summary
  transcript.summary = {
    ...summaryContent,
    turns_count: turns_count || transcript.turns.length,
    duration_sec: actualDuration
  };
  transcript.finalized = true;

  // Emit ONE orb.session.summary event to OASIS
  await emitOasisEvent({
    vtid: 'VTID-01039',
    type: 'orb.session.summary',
    source: 'command-hub',
    status: 'success',
    message: summaryContent.title,
    payload: {
      orb_session_id,
      conversation_id: transcript.conversation_id || conversation_id || null,
      turns_count: transcript.summary.turns_count,
      duration_sec: transcript.summary.duration_sec,
      summary: {
        title: summaryContent.title,
        bullets: summaryContent.bullets,
        actions: summaryContent.actions
      },
      metadata: { mode: 'orb_voice' }
    }
  }).catch(err => console.warn('[VTID-01039] Failed to emit orb.session.summary:', err.message));

  console.log(`[VTID-01039] Session finalized: ${orb_session_id} (${transcript.summary.turns_count} turns, ${transcript.summary.duration_sec}s)`);

  return res.status(200).json({
    ok: true,
    orb_session_id,
    summary: transcript.summary
  });
});

/**
 * VTID-01039: GET /session/:orb_session_id - Get full transcript + summary
 */
router.get('/session/:orb_session_id', (req: Request, res: Response) => {
  const { orb_session_id } = req.params;

  if (!orb_session_id) {
    return res.status(400).json({
      ok: false,
      error: 'Missing orb_session_id parameter'
    });
  }

  const transcript = orbTranscripts.get(orb_session_id);
  if (!transcript) {
    return res.status(404).json({
      ok: false,
      error: 'Session transcript not found'
    });
  }

  return res.status(200).json({
    ok: true,
    orb_session_id: transcript.orb_session_id,
    conversation_id: transcript.conversation_id,
    started_at: transcript.started_at,
    finalized: transcript.finalized,
    turns: transcript.turns,
    summary: transcript.summary || null
  });
});

/**
 * GET /health - Health check
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasGeminiKey = !!GEMINI_API_KEY;

  return res.status(200).json({
    ok: true,
    service: 'orb-live',
    vtid: ['DEV-COMHU-2025-0014', 'VTID-0135', 'VTID-01039'],
    model: GEMINI_MODEL,
    transport: 'SSE',
    gemini_configured: hasGeminiKey,
    active_sessions: sessions.size,
    active_conversations: orbConversations.size,
    active_transcripts: orbTranscripts.size,
    voice_conversation_enabled: true,
    timestamp: new Date().toISOString()
  });
});

export default router;
