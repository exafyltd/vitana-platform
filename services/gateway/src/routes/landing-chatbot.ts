/**
 * VTID-LANDING: Landing Page Chatbot — ORB for First-Time Visitors
 *
 * Purpose: Provide an unauthenticated, text-based chatbot on the vitanalent.com
 * landing page so first-time visitors can communicate with the ORB and get help
 * with registration, onboarding, and understanding the Maxilla community.
 *
 * Endpoints:
 * - POST /api/v1/landing/chat   - Send a message, get a response
 * - GET  /api/v1/landing/health - Health check
 *
 * Design:
 * - NO authentication required (anonymous visitors)
 * - Rate-limited per IP to prevent abuse
 * - Uses existing Gemini/Vertex AI infrastructure via processWithGemini
 * - In-memory conversation threads (keyed by visitor session ID)
 * - Focused system instruction: registration guidance, Maxilla community info
 * - Thread auto-cleanup after 30 minutes of inactivity
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { processWithGemini } from '../services/gemini-operator';
import rateLimit from 'express-rate-limit';

const router = Router();

// =============================================================================
// Constants
// =============================================================================

/** Max conversation history turns retained per visitor thread */
const MAX_HISTORY_TURNS = 20;

/** Thread inactivity timeout (30 minutes) */
const THREAD_TTL_MS = 30 * 60 * 1000;

/** Cleanup interval (every 5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

// =============================================================================
// Landing Chatbot System Instruction
// =============================================================================

const LANDING_SYSTEM_INSTRUCTION = `You are VITANA ORB, the intelligent guide for vitanalent.com — the gateway to the Maxilla longevity community.

## Your Role
You are speaking with a first-time visitor who has NOT yet registered. Your purpose is to:
1. Welcome them warmly and explain what Vitana and the Maxilla community are about
2. Answer their questions about the platform, features, and community
3. Guide them through the registration process when they're ready
4. Help them understand the onboarding journey

## About Vitana & Maxilla
- **Vitana** is a longevity-focused personal intelligence platform that helps people live healthier, more connected lives
- The **Maxilla community** is a vibrant network of people passionate about longevity, wellness, health optimization, and meaningful connections
- Members get access to: personalized health insights, AI-powered recommendations, community matchmaking, live events & meetups, wellness tracking, and a personal AI assistant (the ORB)
- The platform uses AI to understand each member deeply — their health goals, interests, preferences, and social connections — to provide truly personalized guidance
- Vitana remembers you across sessions, learns your preferences, and proactively suggests relevant opportunities

## Registration Process
When the visitor wants to register, guide them through these steps:
1. Click the "Join Maxilla" or "Get Started" button on the landing page
2. Enter their email address and create a password
3. Verify their email via the confirmation link sent to their inbox
4. Complete their profile: name, interests, health goals
5. Explore the platform and start connecting with the community

## Conversation Guidelines
- Be warm, friendly, and enthusiastic — you're welcoming someone new
- Keep responses concise (2-4 sentences max) unless the visitor asks for detail
- Use simple language, avoid technical jargon
- If they ask about pricing: Vitana is currently free to join during the early-access phase
- If they ask about privacy: Vitana takes privacy seriously — all personal data is encrypted, memory is user-controlled, and users can delete their data at any time
- If they ask something you don't know: be honest and suggest they'll find more details after joining
- Gently encourage registration without being pushy
- You can use light, natural conversational tone — you're a guide, not a salesperson
- Never claim to be human. You are the ORB, Vitana's AI guide.
- If they seem confused about what to do next, proactively suggest exploring topics or starting registration

## What NOT To Do
- Do not make up specific statistics, pricing tiers, or feature details you're unsure of
- Do not process payments or handle sensitive data
- Do not pretend to have memory of this visitor (they are anonymous and new)
- Do not discuss internal platform architecture or technical implementation details`;

// =============================================================================
// Visitor Thread Management
// =============================================================================

interface VisitorThread {
  thread_id: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  created_at: string;
  last_activity: string;
  turn_count: number;
  ip_hash: string; // Hashed IP for abuse tracking (never stored as raw IP)
}

const threads = new Map<string, VisitorThread>();

/** Simple IP hash for abuse tracking — NOT for identification */
function hashIP(ip: string): string {
  // Simple hash without crypto overhead; just for grouping, not security
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    const char = ip.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `ip_${Math.abs(hash).toString(36)}`;
}

/** Get or create a visitor conversation thread */
function getOrCreateThread(threadId: string | undefined, ipHash: string): VisitorThread {
  if (threadId && threads.has(threadId)) {
    const thread = threads.get(threadId)!;
    thread.last_activity = new Date().toISOString();
    return thread;
  }

  const id = threadId || `landing-${randomUUID()}`;
  const thread: VisitorThread = {
    thread_id: id,
    history: [],
    created_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    turn_count: 0,
    ip_hash: ipHash,
  };
  threads.set(id, thread);
  return thread;
}

/** Periodic cleanup of stale threads */
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, thread] of threads) {
    if (now - new Date(thread.last_activity).getTime() > THREAD_TTL_MS) {
      threads.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[VTID-LANDING] Cleaned ${cleaned} stale visitor threads (${threads.size} remaining)`);
  }
}, CLEANUP_INTERVAL_MS);

// =============================================================================
// Rate Limiting
// =============================================================================

/** Rate limit: 30 messages per 5 minutes per IP */
const chatRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: 'RATE_LIMITED',
    message: 'Too many messages. Please wait a few minutes before trying again.',
  },
  keyGenerator: (req: Request) => {
    return req.ip || req.socket.remoteAddress || 'unknown';
  },
});

// =============================================================================
// Endpoints
// =============================================================================

/**
 * POST /api/v1/landing/chat
 *
 * Send a message to the landing page chatbot. No authentication required.
 *
 * Body:
 * {
 *   "thread_id": "optional-thread-id",
 *   "message": "Hello, what is Vitana?"
 * }
 *
 * Response:
 * {
 *   "ok": true,
 *   "thread_id": "landing-uuid",
 *   "reply": "Welcome! Vitana is...",
 *   "turn_count": 1
 * }
 */
router.post('/chat', chatRateLimiter, async (req: Request, res: Response) => {
  const { thread_id, message } = req.body || {};

  // Validate input
  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_INPUT',
      message: 'message is required and must be a non-empty string',
    });
  }

  const userMessage = message.trim();

  // Enforce max message length (prevent abuse)
  if (userMessage.length > 2000) {
    return res.status(400).json({
      ok: false,
      error: 'MESSAGE_TOO_LONG',
      message: 'Message must be 2000 characters or less',
    });
  }

  const ipHash = hashIP(req.ip || req.socket.remoteAddress || 'unknown');
  const thread = getOrCreateThread(thread_id, ipHash);

  // Add user message to history
  thread.history.push({ role: 'user', content: userMessage });
  thread.turn_count++;

  // Trim history if too long (keep most recent turns)
  if (thread.history.length > MAX_HISTORY_TURNS * 2) {
    thread.history = thread.history.slice(-MAX_HISTORY_TURNS * 2);
  }

  console.log(`[VTID-LANDING] Chat turn #${thread.turn_count} (thread=${thread.thread_id.substring(0, 12)}..., ip=${ipHash})`);

  try {
    // Build conversation history for Gemini (exclude the current user message, already passed as text)
    const geminiHistory = thread.history.slice(0, -1).map(h => ({
      role: (h.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: h.content,
    }));

    // Call Gemini via the existing infrastructure
    const result = await processWithGemini({
      text: userMessage,
      threadId: thread.thread_id,
      systemInstruction: LANDING_SYSTEM_INSTRUCTION,
      conversationHistory: geminiHistory,
    });

    const replyText = result?.reply || "I'm sorry, I'm having trouble right now. Please try again in a moment!";

    // Add assistant response to history
    thread.history.push({ role: 'assistant', content: replyText });

    return res.status(200).json({
      ok: true,
      thread_id: thread.thread_id,
      reply: replyText,
      turn_count: thread.turn_count,
    });
  } catch (error: any) {
    console.error(`[VTID-LANDING] Chat error (thread=${thread.thread_id.substring(0, 12)}...):`, error.message);

    // Remove the failed user message from history so it can be retried
    thread.history.pop();
    thread.turn_count--;

    return res.status(500).json({
      ok: false,
      error: 'CHAT_ERROR',
      message: 'Something went wrong. Please try again.',
    });
  }
});

/**
 * GET /api/v1/landing/health
 *
 * Health check for the landing chatbot service.
 */
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    service: 'landing-chatbot',
    active_threads: threads.size,
    timestamp: new Date().toISOString(),
  });
});

export default router;
