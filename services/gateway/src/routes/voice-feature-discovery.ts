/**
 * VTID-02923 (B0e.3): Feature Discovery inspection API.
 *
 *   GET /api/v1/voice/feature-discovery/preview?userId=…&tenantId=…&surface=…
 *       Runs the B0e.2 provider against the real Supabase-backed
 *       fetcher for the given user and returns:
 *         - capabilities snapshot (catalog the provider saw)
 *         - awareness snapshot (user's state ladder)
 *         - the ProviderResult (status: returned | suppressed | skipped
 *           | errored), the selected candidate when present, and the
 *           per-capability rejection map when suppressed
 *
 * Auth: exafy_admin required (same as B0c Journey Context inspection).
 *
 * Wall discipline: this endpoint is **read-only**. It runs the
 * provider's `produce()` to capture decision evidence but does NOT
 * call any awareness-state mutator. State advancement is B0e.4's
 * concern; this slice (B0e.3) is observability only.
 */

import { Router, Response } from 'express';
import {
  requireAuthWithTenant,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { makeFeatureDiscoveryProvider } from '../services/assistant-continuation/providers/feature-discovery';
import { defaultSupabaseCapabilityFetcher } from '../services/capability-awareness/supabase-capability-fetcher';
import type { ProviderResult, ContinuationSurface } from '../services/assistant-continuation/types';

const router = Router();
const VTID = 'VTID-02923';

const VALID_SURFACES = new Set<ContinuationSurface>([
  'orb_wake',
  'orb_turn_end',
  'text_turn_end',
  'home',
]);

router.get(
  '/voice/feature-discovery/preview',
  requireAuthWithTenant,
  requireExafyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
      const surfaceRaw = typeof req.query.surface === 'string' ? req.query.surface : 'orb_turn_end';
      const envelopeJourneySurface =
        typeof req.query.envelopeJourneySurface === 'string'
          ? req.query.envelopeJourneySurface
          : undefined;

      if (!userId || !tenantId) {
        return res.status(400).json({
          ok: false,
          error: 'userId and tenantId are required',
          vtid: VTID,
        });
      }
      if (!VALID_SURFACES.has(surfaceRaw as ContinuationSurface)) {
        return res.status(400).json({
          ok: false,
          error: `surface must be one of ${Array.from(VALID_SURFACES).join(', ')}`,
          vtid: VTID,
        });
      }
      const surface = surfaceRaw as ContinuationSurface;

      // Pull the snapshots BEFORE invoking the provider so the panel
      // can show the catalog + awareness the ranker actually saw.
      const [capabilities, awareness] = await Promise.all([
        defaultSupabaseCapabilityFetcher.listCapabilities(),
        defaultSupabaseCapabilityFetcher.listAwareness({ tenantId, userId }),
      ]);

      // Build a transient provider with includeOrbWake=true so the
      // preview can also inspect what the wake surface would have
      // returned — operators need to see the defensive-skip reason
      // ("feature_discovery_disabled_on_orb_wake") on the wake row.
      const provider = makeFeatureDiscoveryProvider({
        fetcher: defaultSupabaseCapabilityFetcher,
        includeOrbWake: true,
      });

      const result = (await provider.produce({
        sessionId: 'preview',
        userId,
        tenantId,
        surface,
        envelopeJourneySurface,
      })) as ProviderResult;

      return res.json({
        ok: true,
        vtid: VTID,
        catalog: capabilities,
        awareness,
        provider: {
          key: result.providerKey,
          status: result.status,
          latencyMs: result.latencyMs,
          reason: result.reason ?? null,
          candidate: result.candidate ?? null,
        },
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: (e as Error).message,
        vtid: VTID,
      });
    }
  },
);

export default router;
