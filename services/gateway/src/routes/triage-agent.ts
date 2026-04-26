/**
 * Incident Triage Agent — Claude Managed Agents proxy route
 *
 * Proxies Claude Managed Agents sessions to the Command Hub for Voice Lab
 * incident investigation. The agent reads the vitana-platform repo, queries
 * OASIS events via a custom tool (Supabase creds stay host-side), and streams
 * its investigation back to the browser via SSE.
 *
 * Endpoints:
 *   POST /api/v1/agents/triage/investigate  — create a session + send initial prompt
 *   GET  /api/v1/agents/triage/:sessionId/stream — SSE proxy for agent events
 *
 * The Anthropic API key, agent ID, and environment ID are read from env vars:
 *   ANTHROPIC_API_KEY, TRIAGE_AGENT_ID, TRIAGE_ENVIRONMENT_ID
 */

import { Router, Request, Response } from 'express';

export const triageAgentRouter = Router();

const LOG_PREFIX = '[triage-agent]';

// Config from environment
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AGENT_ID = process.env.TRIAGE_AGENT_ID || 'agent_011Ca1RTRZADaWdZsKAKjs3B';
const ENVIRONMENT_ID = process.env.TRIAGE_ENVIRONMENT_ID || 'env_01VrvRRUWP91wiFQrmWaUcEh';
const ANTHROPIC_BASE = 'https://api.anthropic.com';
const BETA_HEADER = 'managed-agents-2026-04-01';

// =============================================================================
// Anthropic API helper
// =============================================================================

async function anthropicRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{ ok: boolean; data?: T; error?: string; status?: number }> {
  if (!ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY not set', status: 500 };
  }

  try {
    const response = await fetch(`${ANTHROPIC_BASE}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_HEADER,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { ok: false, error: `${response.status}: ${errorText}`, status: response.status };
    }

    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String(error), status: 500 };
  }
}

// =============================================================================
// Supabase helper for custom tool (query_oasis_events)
// =============================================================================

async function queryOasisEvents(
  sessionId: string,
  limit: number = 100
): Promise<{ ok: boolean; events?: unknown[]; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'Missing Supabase credentials' };
  }

  try {
    // Query OASIS events for this session ID — check both metadata.session_id
    // and metadata.sessionId patterns (both exist in the codebase)
    const response = await fetch(
      `${supabaseUrl}/rest/v1/oasis_events?or=(metadata->>session_id.eq.${encodeURIComponent(sessionId)},metadata->>sessionId.eq.${encodeURIComponent(sessionId)})&order=created_at.asc&limit=${limit}&select=id,topic,vtid,status,message,metadata,created_at`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!response.ok) {
      return { ok: false, error: `Supabase ${response.status}: ${await response.text()}` };
    }

    const events = (await response.json()) as unknown[];
    return { ok: true, events };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// =============================================================================
// POST /api/v1/agents/triage/investigate
// =============================================================================

interface InvestigateRequest {
  session_id: string;
  diagnostic_summary: string;
  flags: string[];
  metrics: {
    duration_ms?: number;
    audio_in_chunks?: number;
    audio_out_chunks?: number;
    turn_count?: number;
    error_count?: number;
    interrupted_count?: number;
  };
}

triageAgentRouter.post('/investigate', async (req: Request, res: Response) => {
  try {
    const body = req.body as InvestigateRequest;

    if (!body.session_id) {
      return res.status(400).json({ ok: false, error: 'session_id is required' });
    }

    if (!ANTHROPIC_API_KEY) {
      return res.status(503).json({
        ok: false,
        error: 'Incident triage is not configured — ANTHROPIC_API_KEY is not set on this gateway instance.',
      });
    }

    console.log(`${LOG_PREFIX} Starting investigation for session ${body.session_id}`);

    // 1. Create a Managed Agents session with the repo mounted
    const sessionResult = await anthropicRequest<any>('/v1/sessions', {
      method: 'POST',
      body: {
        agent: { type: 'agent', id: AGENT_ID, version: 1 },
        environment_id: ENVIRONMENT_ID,
        title: `Voice triage: ${body.session_id}`,
        resources: [
          {
            type: 'github_repository',
            url: 'https://github.com/exafyltd/vitana-platform',
            authorization_token: process.env.GITHUB_SAFE_MERGE_TOKEN || '',
            mount_path: '/workspace/repo',
            checkout: { type: 'branch', name: 'main' },
          },
        ],
      },
    });

    if (!sessionResult.ok || !sessionResult.data) {
      console.error(`${LOG_PREFIX} Session creation failed:`, sessionResult.error);
      return res.status(500).json({
        ok: false,
        error: 'Failed to create triage session',
        detail: sessionResult.error,
      });
    }

    const sessionId = sessionResult.data.id;
    console.log(`${LOG_PREFIX} Session created: ${sessionId}`);

    // 2. Build the investigation prompt from the diagnostic data
    const flagsList = body.flags.length > 0
      ? body.flags.map((f: string) => `  - ${f}`).join('\n')
      : '  (no diagnostic flags)';

    const prompt = [
      `Investigate this ORB voice session that has diagnostic issues.`,
      ``,
      `## Session: ${body.session_id}`,
      ``,
      `## Diagnostic Flags`,
      flagsList,
      ``,
      `## Metrics`,
      `- Duration: ${body.metrics.duration_ms ? Math.round(body.metrics.duration_ms / 1000) + 's' : 'unknown'}`,
      `- Audio in chunks: ${body.metrics.audio_in_chunks ?? 'unknown'}`,
      `- Audio out chunks: ${body.metrics.audio_out_chunks ?? 'unknown'}`,
      `- Turns: ${body.metrics.turn_count ?? 'unknown'}`,
      `- Errors: ${body.metrics.error_count ?? 'unknown'}`,
      `- Interrupts: ${body.metrics.interrupted_count ?? 'unknown'}`,
      ``,
      `## Summary`,
      body.diagnostic_summary || 'No summary provided.',
      ``,
      `## Instructions`,
      `1. Start by calling query_oasis_events with session_id="${body.session_id}" to get the raw event timeline`,
      `2. Read the relevant source code in /workspace/repo/ based on what the events reveal`,
      `3. Produce a structured triage report with root cause, severity, and recommended fix`,
    ].join('\n');

    // 3. Send the initial message
    const sendResult = await anthropicRequest<any>(
      `/v1/sessions/${sessionId}/events`,
      {
        method: 'POST',
        body: {
          events: [
            {
              type: 'user.message',
              content: [{ type: 'text', text: prompt }],
            },
          ],
        },
      }
    );

    if (!sendResult.ok) {
      console.error(`${LOG_PREFIX} Failed to send initial message:`, sendResult.error);
    }

    return res.status(200).json({
      ok: true,
      session_id: sessionId,
      orb_session_id: body.session_id,
      stream_url: `/api/v1/agents/triage/${sessionId}/stream`,
    });
  } catch (error: any) {
    console.error(`${LOG_PREFIX} investigate error:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// =============================================================================
// GET /api/v1/agents/triage/:sessionId/stream — SSE proxy
// =============================================================================

triageAgentRouter.get('/:sessionId/stream', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ ok: false, error: 'ANTHROPIC_API_KEY not set' });
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  console.log(`${LOG_PREFIX} Stream opened for session ${sessionId}`);

  // Helper to send SSE events to the browser
  const sendSSE = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Poll events from the Managed Agents session and forward to the browser.
    // Also handle custom tool calls (query_oasis_events).
    //
    // The Anthropic events list endpoint does NOT support an after-cursor
    // query param — valid params are `limit`, `order`, `page` (per
    // managed-agents-2026-04-01). We fetch up to the page max each poll and
    // dedupe by event ID via `seenIds`. A triage session is expected to
    // produce well under 1000 events, so a single page is sufficient. If we
    // ever hit the cap, switch to cursor pagination via `page`.
    let done = false;
    const seenIds = new Set<string>();

    while (!done) {
      const eventsResult = await anthropicRequest<any>(
        `/v1/sessions/${sessionId}/events?limit=1000&order=asc`,
      );

      if (!eventsResult.ok || !eventsResult.data) {
        sendSSE('error', { error: eventsResult.error });
        break;
      }

      const events = eventsResult.data.data || [];

      for (const event of events) {
        if (seenIds.has(event.id)) continue;
        seenIds.add(event.id);

        // Forward relevant events to the browser
        switch (event.type) {
          case 'agent.message':
            sendSSE('agent.message', {
              id: event.id,
              content: event.content,
            });
            break;

          case 'agent.thinking':
            sendSSE('agent.thinking', {
              id: event.id,
              thinking: event.thinking,
            });
            break;

          case 'agent.tool_use':
          case 'agent.tool_result':
            sendSSE(event.type, {
              id: event.id,
              name: event.name || event.tool_name,
              input: event.input,
              content: event.content,
            });
            break;

          case 'agent.custom_tool_use': {
            // Handle query_oasis_events — execute with our Supabase creds
            sendSSE('agent.custom_tool_use', {
              id: event.id,
              tool_name: event.tool_name,
              input: event.input,
            });

            if (event.tool_name === 'query_oasis_events') {
              const oasisResult = await queryOasisEvents(
                event.input?.session_id || '',
                event.input?.limit || 100
              );

              const resultText = oasisResult.ok
                ? JSON.stringify(oasisResult.events, null, 2)
                : `Error querying OASIS events: ${oasisResult.error}`;

              // Send the tool result back to the managed agent
              await anthropicRequest(
                `/v1/sessions/${sessionId}/events`,
                {
                  method: 'POST',
                  body: {
                    events: [
                      {
                        type: 'user.custom_tool_result',
                        custom_tool_use_id: event.id,
                        content: [{ type: 'text', text: resultText }],
                      },
                    ],
                  },
                }
              );

              sendSSE('tool_result_sent', {
                tool_name: 'query_oasis_events',
                event_count: oasisResult.ok ? (oasisResult.events?.length || 0) : 0,
              });
            }
            break;
          }

          case 'session.status_idle': {
            const stopReason = event.stop_reason?.type;
            if (stopReason === 'requires_action') {
              // Agent is waiting for our tool result — continue the loop
              continue;
            }
            // end_turn or retries_exhausted — we're done
            sendSSE('session.idle', { stop_reason: stopReason });
            done = true;
            break;
          }

          case 'session.status_terminated':
            sendSSE('session.terminated', {});
            done = true;
            break;

          case 'session.error':
            sendSSE('session.error', {
              error: event.error || event.message,
            });
            break;
        }
      }

      // If no new events and not done, wait briefly before polling again
      if (events.length === 0 && !done) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Check if client disconnected
      if (req.socket.destroyed) {
        console.log(`${LOG_PREFIX} Client disconnected from stream ${sessionId}`);
        done = true;
      }
    }
  } catch (error: any) {
    console.error(`${LOG_PREFIX} Stream error for ${sessionId}:`, error);
    sendSSE('error', { error: error.message });
  } finally {
    sendSSE('done', {});
    res.end();
    console.log(`${LOG_PREFIX} Stream closed for session ${sessionId}`);
  }
});
