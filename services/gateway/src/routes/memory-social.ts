/**
 * BOOTSTRAP-SOCIAL-MEMORY — Social Memory Intelligence endpoints.
 *
 * Mounted at /api/v1/memory/social. All endpoints are self-scoped: the
 * acting user comes from the verified JWT (req.identity), NEVER from the
 * request body/params — a client cannot read another user's social memory.
 * The only cross-user reads are the privacy-gated person/activity views,
 * which go through person-context-builder's minimization rules.
 *
 * GET  /context/me            — full Social Context Pack for the caller
 * GET  /following             — who the caller follows
 * GET  /followers             — who follows the caller
 * GET  /matches               — matches with scores + reasons
 * GET  /messages              — recent DM contacts (own conversations only)
 * GET  /group-chats           — group chats the caller participates in
 * GET  /interesting-posts     — explainably ranked posts
 * GET  /interesting-events    — explainably ranked events
 * GET  /person/:userId        — Person Intelligence (privacy-gated)
 * GET  /activity/:personId    — a person's recent visible activity
 * POST /assistant-context     — the assistant-facing aggregate (spec shape)
 */

import { Router, Response } from 'express';
import {
  requireAuth,
  requireTenant,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { buildSocialContextPack } from '../services/social-memory/social-context-builder';
import { buildPersonContext } from '../services/social-memory/person-context-builder';
import {
  buildPersonActivity,
} from '../services/social-memory/community-activity-builder';
import {
  buildAssistantSocialContext,
} from '../services/social-memory/social-memory-service';
import {
  fetchExclusions,
  fetchFollowEdges,
  fetchMatches,
  fetchRecentMessageContacts,
  fetchGroupChats,
} from '../services/social-memory/social-memory-repository';

const router = Router();
router.use(requireAuth);
router.use(requireTenant);

function identityOf(req: AuthenticatedRequest): { user_id: string; tenant_id: string } {
  return {
    user_id: (req.identity as any).user_id,
    tenant_id: (req.identity as any).tenant_id,
  };
}

router.get('/context/me', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = identityOf(req);
    const pack = await buildSocialContextPack({ ...id, question: String(req.query.q || '') });
    return res.json({ ok: true, ...pack });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/following', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = identityOf(req);
    const excl = await fetchExclusions(id.user_id);
    const { following } = await fetchFollowEdges(id.user_id, excl.blocked);
    return res.json({ ok: true, following, count: following.length });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/followers', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = identityOf(req);
    const excl = await fetchExclusions(id.user_id);
    const { followers } = await fetchFollowEdges(id.user_id, excl.blocked);
    return res.json({ ok: true, followers, count: followers.length });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/matches', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = identityOf(req);
    const excl = await fetchExclusions(id.user_id);
    const matches = await fetchMatches(id.user_id, excl.blocked);
    return res.json({ ok: true, matches, count: matches.length });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/messages', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = identityOf(req);
    const excl = await fetchExclusions(id.user_id);
    const contacts = await fetchRecentMessageContacts(id.user_id, id.tenant_id, excl.blocked);
    return res.json({ ok: true, contacts, count: contacts.length });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/group-chats', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = identityOf(req);
    const groups = await fetchGroupChats(id.user_id, id.tenant_id);
    return res.json({ ok: true, group_chats: groups, count: groups.length });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/interesting-posts', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = identityOf(req);
    const pack = await buildSocialContextPack({ ...id, compact: false });
    return res.json({ ok: true, posts: pack.interesting_posts });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/interesting-events', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = identityOf(req);
    const pack = await buildSocialContextPack({ ...id, compact: false });
    return res.json({ ok: true, events: pack.interesting_events });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/person/:userId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = identityOf(req);
    const person = await buildPersonContext({
      ...id,
      person_id: String(req.params.userId),
    });
    if (!person) {
      return res.status(404).json({ ok: false, error: 'PERSON_NOT_FOUND' });
    }
    return res.json({ ok: true, person_context: person });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/activity/:personId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = identityOf(req);
    // Privacy gate: reuse person context resolution — blocked or
    // privacy-limited people expose no activity.
    const person = await buildPersonContext({ ...id, person_id: String(req.params.personId) });
    if (!person) return res.status(404).json({ ok: false, error: 'PERSON_NOT_FOUND' });
    if (person.privacy_limited) {
      return res.json({
        ok: true,
        activity: { person: person.person, items: [], window_days: 0 },
        privacy_limited: true,
      });
    }
    const activity = await buildPersonActivity(person.person.user_id);
    return res.json({ ok: true, activity });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * The assistant-facing aggregate (spec shape). userId in the body is
 * accepted only as 'current-user' or the caller's own id — the identity
 * always comes from the JWT.
 */
router.post('/assistant-context', async (req: AuthenticatedRequest, res: Response) => {
  // impact-allow-no-oasis — this is a READ aggregate (POST only for the
  // request body); the retrieval event memory.social.context_built is
  // emitted inside buildAssistantSocialContext (social-memory-service.ts),
  // so emitting here would double-count every call.
  try {
    const id = identityOf(req);
    const bodyUserId = req.body?.userId;
    if (bodyUserId && bodyUserId !== 'current-user' && bodyUserId !== id.user_id) {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN_USER_SCOPE' });
    }
    const question = String(req.body?.question || '');
    const surface = req.body?.surface;

    const result = await buildAssistantSocialContext({
      tenant_id: id.tenant_id,
      user_id: id.user_id,
      question,
      conversation_id: req.body?.conversationId,
      surface,
    });

    const p = result.pack;
    return res.json({
      ok: true,
      user: p.user ?? {},
      relationships: p.relationships,
      matches: p.matches,
      messages: p.messages,
      groupChats: p.group_chats,
      interestingPosts: p.interesting_posts,
      interestingEvents: p.interesting_events,
      personContext: p.person_context ?? {},
      activityContext: p.activity_context ?? {},
      memoryHighlights: p.memory_highlights,
      recommendedActions: p.recommended_actions,
      assistantSystemHints: p.assistant_system_hints,
      meta: p.meta,
      intent: result.intent,
    });
  } catch (err: any) {
    console.error('[memory-social] assistant-context failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
