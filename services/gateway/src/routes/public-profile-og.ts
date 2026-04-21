/**
 * Public, auth-less profile lookup used to populate rich share previews
 * (Open Graph / Twitter cards) on WhatsApp, Telegram, LinkedIn, etc.
 *
 * Consumed by the Cloudflare Worker at `e.vitanaland.com`
 * (`cloudflare/vitanaland-og-proxy/worker.js` → `renderProfileOg`). The worker
 * detects crawler User-Agents, hits this endpoint, and assembles the OG
 * meta HTML inline — mirroring the product OG flow.
 *
 * Returns only display / identity fields that are already public on
 * `/u/:handle`. No emails, no DOB, no contact info.
 */
import { Router, Request, Response } from 'express';
import { getSupabase } from '../lib/supabase';

const router = Router();

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HANDLE_RE = /^[a-z0-9_]{1,64}$/;

router.get('/profile/:id', async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ ok: false, error: 'Supabase unavailable' });
    return;
  }

  const raw = String(req.params.id ?? '').trim();
  if (!raw) {
    res.status(400).json({ ok: false, error: 'missing id' });
    return;
  }

  const isUuid = UUID_RE.test(raw);
  const isHandle = !isUuid && HANDLE_RE.test(raw.toLowerCase());
  if (!isUuid && !isHandle) {
    res.status(400).json({ ok: false, error: 'invalid id' });
    return;
  }

  // Accept either a UUID (matches profiles.user_id which is what useProfileShare
  // puts in the URL, with profiles.id as a secondary match) or a handle.
  const query = supabase
    .from('profiles')
    .select(
      'id, user_id, handle, display_name, first_name, last_name, longevity_archetype, bio, avatar_url, cover_url',
    );

  const { data, error } = await (isUuid
    ? query.or(`user_id.eq.${raw},id.eq.${raw}`).maybeSingle()
    : query.eq('handle', raw.toLowerCase()).maybeSingle());

  if (error) {
    res.status(500).json({ ok: false, error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ ok: false, error: 'profile not found' });
    return;
  }

  // Cache-friendly: profile card contents change rarely.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.json({ ok: true, profile: data });
});

export default router;
