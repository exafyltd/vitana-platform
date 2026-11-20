/**
 * Delivery loop: the facts the loop reads, as typed values parsed from OASIS rows.
 *
 * The GitLab webhook stage (services/gitlab-events) records what happened in GitLab as OASIS rows; the loop reads those rows and
 * never the webhook. A row is parsed field by field: its metadata was written by this gateway, but it is treated as untrusted
 * (an older writer, a hand-edited row, a field of the wrong type all give `null` for that fact, never an exception).
 */
import type { FailedJobFact } from './types';

/** An OASIS row, as the loop reads and writes it. `metadata` is the row's metadata (the event payload plus env). */
export interface LedgerEvent {
  id: string;
  created_at: string;
  vtid: string | null;
  topic: string;
  status: string | null;
  message: string | null;
  metadata: Record<string, unknown>;
}

/** Where the loop stopped reading: the keyset position of the last row it processed. */
export interface Cursor {
  created_at: string;
  id: string;
}

export const FACT_TOPICS = [
  'scm.gitlab.issue.opened',
  'scm.gitlab.issue.labeled',
  'scm.gitlab.merge_request.opened',
  'scm.gitlab.merge_request.updated',
  'scm.gitlab.merge_request.merged',
  'scm.gitlab.merge_request.closed',
  'scm.gitlab.pipeline.succeeded',
  'scm.gitlab.pipeline.failed',
] as const;

export interface FactBase {
  event: LedgerEvent;
  /** `group/name` of the GitLab project the fact is about. */
  project: string;
}

export interface IssueFact extends FactBase {
  kind: 'issue';
  action: 'opened' | 'labeled';
  iid: number;
  url: string | null;
  labels: string[];
  confidential: boolean;
  updated: string | null;
}

export interface PipelineFact extends FactBase {
  kind: 'pipeline';
  status: 'failed' | 'succeeded';
  pipeline_id: number;
  ref: string;
  sha: string | null;
  url: string | null;
  /** A pipeline of a tag (a release or cut tag): never repaired. */
  tag: boolean;
  /** The merge request the pipeline ran for, when it had one. */
  mr_iid: number | null;
  mr_source_branch: string | null;
  mr_target_branch: string | null;
  mr_url: string | null;
  lane_key: string | null;
  /** Only for a failed pipeline. */
  failed_jobs: FailedJobFact[];
}

export interface MergeRequestFact extends FactBase {
  kind: 'merge_request';
  state: 'opened' | 'updated' | 'merged' | 'closed';
  iid: number;
  source_branch: string | null;
  target_branch: string | null;
  head_sha: string | null;
  url: string | null;
}

export type Fact = IssueFact | PipelineFact | MergeRequestFact;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 512): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : []);

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

function projectOf(m: Obj): string | null {
  const p = str(m.project_path, 200);
  return p !== null && PROJECT_RE.test(p) ? p : null;
}

export function parseFailedJobs(v: unknown): FailedJobFact[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .slice(0, 20)
    .map((j) => ({ id: int(j.id), name: str(j.name), stage: str(j.stage), failure_reason: str(j.failure_reason, 64), exit_code: int(j.exit_code) }));
}

/** The fact a row records, or null when the row is not one the loop reads or lacks what the loop needs. */
export function toFact(e: LedgerEvent): Fact | null {
  const m = isObj(e.metadata) ? e.metadata : {};
  const project = projectOf(m);
  if (project === null) return null;

  switch (e.topic) {
    case 'scm.gitlab.issue.opened':
    case 'scm.gitlab.issue.labeled': {
      const iid = int(m.issue_iid);
      if (iid === null || iid <= 0) return null;
      return {
        kind: 'issue',
        event: e,
        project,
        action: e.topic.endsWith('.labeled') ? 'labeled' : 'opened',
        iid,
        url: str(m.url),
        labels: strings(m.labels),
        confidential: m.confidential === true,
        updated: str(e.created_at, 64),
      };
    }
    case 'scm.gitlab.pipeline.failed':
    case 'scm.gitlab.pipeline.succeeded': {
      const id = int(m.pipeline_id);
      const ref = str(m.ref, 255);
      if (id === null || id <= 0 || ref === null) return null;
      const failed = e.topic.endsWith('.failed');
      return {
        kind: 'pipeline',
        event: e,
        project,
        status: failed ? 'failed' : 'succeeded',
        pipeline_id: id,
        ref,
        sha: str(m.sha, 64),
        url: str(m.url),
        tag: m.tag === true,
        mr_iid: int(m.merge_request_iid),
        mr_source_branch: str(m.mr_source_branch, 255),
        mr_target_branch: str(m.mr_target_branch, 255),
        mr_url: str(m.mr_url),
        lane_key: str(m.lane_key, 200),
        failed_jobs: failed ? parseFailedJobs(m.failed_jobs) : [],
      };
    }
    case 'scm.gitlab.merge_request.opened':
    case 'scm.gitlab.merge_request.updated':
    case 'scm.gitlab.merge_request.merged':
    case 'scm.gitlab.merge_request.closed': {
      const iid = int(m.merge_request_iid);
      if (iid === null || iid <= 0) return null;
      return {
        kind: 'merge_request',
        event: e,
        project,
        state: e.topic.slice('scm.gitlab.merge_request.'.length) as MergeRequestFact['state'],
        iid,
        source_branch: str(m.source_branch, 255),
        target_branch: str(m.target_branch, 255),
        head_sha: str(m.head_sha, 64),
        url: str(m.url),
      };
    }
    default:
      return null;
  }
}

/** The branch a pipeline fact is about: the merge request's source branch, else the ref when it is a plain branch. */
export function branchOf(f: PipelineFact): string | null {
  if (f.mr_source_branch) return f.mr_source_branch;
  return f.ref.startsWith('refs/') ? null : f.ref;
}
