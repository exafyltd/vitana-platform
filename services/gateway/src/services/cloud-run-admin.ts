/**
 * Cloud Run Admin API client — Phase 0 staging build (handoff brief P0.4).
 *
 * Thin wrapper over the Cloud Run v2 REST API using ADC via google-auth-library
 * (no extra SDK dependency). Powers:
 *
 *   - GET service metadata + active revision + traffic split
 *   - LIST recent revisions for the CLOCK history view
 *   - UPDATE traffic split (revert flow: route 100% to a past revision)
 *
 * The publish flow does NOT go through here — it dispatches EXEC-DEPLOY.yml,
 * which is the canonical governed deploy path. This module is for the cheap
 * read-only metadata queries the CLOCK button needs, and the traffic-shift
 * write the revert button needs (~30s vs ~5min for a full redeploy).
 *
 * Required IAM on the gateway service account:
 *   - roles/run.viewer       (services.describe, revisions.list)
 *   - roles/run.developer    (services.update for traffic split)
 *
 * See handoff brief P0.4 step 5 for the one-time IAM grant command.
 */

import { GoogleAuth } from 'google-auth-library';

const RUN_API = 'https://run.googleapis.com/v2';
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || 'lovable-vitana-vers1';
const REGION = process.env.VERTEX_LOCATION || 'us-central1';

let cachedAuth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (!cachedAuth) {
    cachedAuth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  return cachedAuth;
}

async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const client = await getAuth().getClient();
  const token = await client.getAccessToken();
  if (!token.token) {
    throw new Error('cloud-run-admin: failed to acquire ADC access token');
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.token}`,
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined ?? {}),
  };
  return fetch(url, { ...init, headers });
}

function servicePath(service: string): string {
  return `projects/${PROJECT}/locations/${REGION}/services/${service}`;
}

// ==================== Public types ====================

export interface RevisionSummary {
  /** Full resource name, e.g. projects/.../services/gateway/revisions/gateway-00123-xyz */
  name: string;
  /** Short revision name, e.g. gateway-00123-xyz */
  shortName: string;
  /** Container image, e.g. us-central1-docker.pkg.dev/.../gateway:latest */
  image: string | null;
  /** Cloud Run revision creation time. */
  createdAt: string;
  /** Whether this revision is currently serving traffic (percent > 0). */
  isActive: boolean;
  /** Traffic percent (0-100); 0 when not serving. */
  trafficPercent: number;
  /** Commit SHA, if present as a container label or env var. May be null. */
  commitSha: string | null;
}

export interface ServiceSummary {
  service: string;
  url: string | null;
  latestReadyRevision: string | null;
  activeRevision: string | null;
  activeRevisionShort: string | null;
  activeRevisionCommit: string | null;
  /** All revisions with traffic > 0, in traffic-split order. */
  trafficSplit: Array<{ revision: string; percent: number }>;
}

// ==================== Read API ====================

/**
 * Describe a Cloud Run service: URL, latest ready revision, and traffic split.
 * Used by the publish flow to resolve "what's currently serving on staging".
 */
export async function describeService(service: string): Promise<ServiceSummary> {
  const resp = await authedFetch(`${RUN_API}/${servicePath(service)}`);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`cloud-run-admin describeService(${service}): ${resp.status} ${text}`);
  }
  const data = await resp.json() as {
    name: string;
    uri?: string;
    latestReadyRevision?: string;
    traffic?: Array<{ type?: string; revision?: string; percent?: number }>;
    template?: {
      containers?: Array<{ image?: string; env?: Array<{ name?: string; value?: string }> }>;
    };
  };

  // Cloud Run v2 traffic targets have two shapes:
  //   - { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: '...', percent }
  //   - { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent }  (no revision field)
  // The LATEST type means "route to whatever latestReadyRevision is", which is
  // the default after `gcloud run deploy` without an explicit --traffic flag.
  // We resolve LATEST entries to data.latestReadyRevision so the CLOCK
  // dropdown's `is_active` flag is accurate.
  const trafficSplit = (data.traffic ?? [])
    .filter(t => (t.percent ?? 0) > 0)
    .map(t => {
      const isLatest = t.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST';
      const rev = (isLatest ? data.latestReadyRevision : t.revision) ?? null;
      return rev ? { revision: rev, percent: t.percent ?? 0 } : null;
    })
    .filter((x): x is { revision: string; percent: number } => x !== null)
    .sort((a, b) => b.percent - a.percent);

  const activeFull = trafficSplit[0]?.revision ?? data.latestReadyRevision ?? null;
  const activeShort = activeFull ? activeFull.split('/').pop() ?? activeFull : null;

  // Commit SHA: best-effort. Cloud Run doesn't store commit SHAs natively, so
  // we look for a GIT_COMMIT_SHA / COMMIT_SHA env var on the service template
  // (set by EXEC-DEPLOY / STAGE-DEPLOY). If absent, return null and let the
  // caller fall back to software_versions lookup by revision name.
  const containers = data.template?.containers ?? [];
  let commit: string | null = null;
  for (const c of containers) {
    for (const e of c.env ?? []) {
      if ((e.name === 'GIT_COMMIT_SHA' || e.name === 'COMMIT_SHA') && e.value) {
        commit = e.value;
        break;
      }
    }
    if (commit) break;
  }

  return {
    service,
    url: data.uri ?? null,
    latestReadyRevision: data.latestReadyRevision ?? null,
    activeRevision: activeFull,
    activeRevisionShort: activeShort,
    activeRevisionCommit: commit,
    trafficSplit,
  };
}

/**
 * List recent revisions for a service, newest first. Used by the CLOCK
 * history view to render the "all past revisions" list with revert eligibility.
 */
export async function listRevisions(service: string, limit = 50): Promise<RevisionSummary[]> {
  // Cloud Run v2 listRevisions uses pageSize; default ordering is creation
  // time descending in practice, but we sort explicitly to be safe.
  const url = `${RUN_API}/${servicePath(service)}/revisions?pageSize=${Math.min(limit, 100)}`;
  const resp = await authedFetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`cloud-run-admin listRevisions(${service}): ${resp.status} ${text}`);
  }
  const data = await resp.json() as {
    revisions?: Array<{
      name?: string;
      createTime?: string;
      containers?: Array<{ image?: string; env?: Array<{ name?: string; value?: string }> }>;
    }>;
  };

  // Resolve current traffic from describeService once so we can mark active.
  let trafficByRev = new Map<string, number>();
  try {
    const svc = await describeService(service);
    for (const t of svc.trafficSplit) trafficByRev.set(t.revision, t.percent);
  } catch (err) {
    // Non-fatal: revisions still list, just without isActive flags.
    console.warn(`cloud-run-admin: traffic lookup failed for ${service}: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  const revisions: RevisionSummary[] = (data.revisions ?? []).map(r => {
    const fullName = r.name ?? '';
    const shortName = fullName.split('/').pop() ?? fullName;
    const image = r.containers?.[0]?.image ?? null;
    let commit: string | null = null;
    for (const c of r.containers ?? []) {
      for (const e of c.env ?? []) {
        if ((e.name === 'GIT_COMMIT_SHA' || e.name === 'COMMIT_SHA') && e.value) {
          commit = e.value;
          break;
        }
      }
      if (commit) break;
    }
    const percent = trafficByRev.get(fullName) ?? 0;
    return {
      name: fullName,
      shortName,
      image,
      createdAt: r.createTime ?? '',
      isActive: percent > 0,
      trafficPercent: percent,
      commitSha: commit,
    };
  });

  revisions.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
  return revisions.slice(0, limit);
}

// ==================== Write API ====================

export interface UpdateTrafficResult {
  ok: boolean;
  operationName?: string;
  error?: string;
}

/**
 * Route 100% of traffic to a single revision. Used by the revert flow.
 *
 * Accepts either a full revision name (`projects/.../revisions/<name>`) or
 * the short revision name (`gateway-00123-xyz`) — both get normalized to the
 * Cloud Run wire format which expects only the short name in traffic[i].revision.
 *
 * Returns the long-running operation name (Cloud Run returns 200 + an
 * Operation; we don't poll, because traffic shifts typically complete in
 * <30s and the caller will verify via describeService.)
 */
export async function updateTrafficToRevision(
  service: string,
  targetRevision: string
): Promise<UpdateTrafficResult> {
  const shortRev = targetRevision.includes('/')
    ? targetRevision.split('/').pop() ?? targetRevision
    : targetRevision;

  // Cloud Run PATCH replaces the full traffic array. Single revision, 100%.
  const body = {
    traffic: [
      { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: shortRev, percent: 100 },
    ],
  };

  const url = `${RUN_API}/${servicePath(service)}?updateMask=traffic`;
  const resp = await authedFetch(url, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false, error: `cloud-run-admin updateTraffic(${service}, ${shortRev}): ${resp.status} ${text}` };
  }

  const data = await resp.json() as { name?: string };
  return { ok: true, operationName: data.name };
}

// ==================== Small helpers ====================

/** Strip the long resource prefix to leave just the revision short name. */
export function shortRevisionName(full: string): string {
  return full.includes('/') ? full.split('/').pop() ?? full : full;
}
