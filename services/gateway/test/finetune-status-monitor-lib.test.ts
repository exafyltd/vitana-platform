import {
  classifyJob,
  extractJobId,
  isQuotaWait,
  mapStateToVerdict,
  pickLatestJob,
  verdictToEventStatus,
  STUCK_PENDING_THRESHOLD_MINUTES,
  type VertexJobDescribe,
} from '../scripts/finetune/status-monitor-lib';

const NOW = Date.parse('2026-06-02T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe('mapStateToVerdict', () => {
  test('maps Vertex job states to verdict buckets', () => {
    expect(mapStateToVerdict('JOB_STATE_RUNNING')).toBe('RUNNING');
    expect(mapStateToVerdict('JOB_STATE_SUCCEEDED')).toBe('SUCCEEDED');
    expect(mapStateToVerdict('JOB_STATE_FAILED')).toBe('FAILED');
    expect(mapStateToVerdict('JOB_STATE_CANCELLED')).toBe('FAILED');
    expect(mapStateToVerdict('JOB_STATE_EXPIRED')).toBe('FAILED');
    expect(mapStateToVerdict('JOB_STATE_PENDING')).toBe('PENDING');
    expect(mapStateToVerdict('JOB_STATE_QUEUED')).toBe('PENDING');
  });

  test('returns UNKNOWN for missing or unrecognised states', () => {
    expect(mapStateToVerdict(undefined)).toBe('UNKNOWN');
    expect(mapStateToVerdict('')).toBe('UNKNOWN');
    expect(mapStateToVerdict('JOB_STATE_SOMETHING_NEW')).toBe('UNKNOWN');
  });
});

describe('extractJobId', () => {
  test('pulls the numeric id from a full resource name', () => {
    expect(
      extractJobId('projects/123/locations/us-central1/customJobs/3154255301083922432'),
    ).toBe('3154255301083922432');
  });
  test('accepts a bare numeric id and rejects junk', () => {
    expect(extractJobId('3154255301083922432')).toBe('3154255301083922432');
    expect(extractJobId('not-a-job')).toBeNull();
    expect(extractJobId(undefined)).toBeNull();
  });
});

describe('isQuotaWait (L4 quota-wait detection)', () => {
  test('flags a long-pending job that never started', () => {
    const job: VertexJobDescribe = {
      state: 'JOB_STATE_PENDING',
      createTime: minsAgo(STUCK_PENDING_THRESHOLD_MINUTES + 5),
      // startTime intentionally absent — Vertex queued it but never started
    };
    expect(isQuotaWait(job, NOW)).toBe(true);
  });

  test('does NOT flag a freshly-pending job under the threshold', () => {
    const job: VertexJobDescribe = {
      state: 'JOB_STATE_PENDING',
      createTime: minsAgo(STUCK_PENDING_THRESHOLD_MINUTES - 5),
    };
    expect(isQuotaWait(job, NOW)).toBe(false);
  });

  test('does NOT flag a job that has already started running', () => {
    const job: VertexJobDescribe = {
      state: 'JOB_STATE_RUNNING',
      createTime: minsAgo(120),
      startTime: minsAgo(60),
    };
    expect(isQuotaWait(job, NOW)).toBe(false);
  });

  test('does NOT flag a pending job that recorded a startTime', () => {
    const job: VertexJobDescribe = {
      state: 'JOB_STATE_PENDING',
      createTime: minsAgo(120),
      startTime: minsAgo(90),
    };
    expect(isQuotaWait(job, NOW)).toBe(false);
  });
});

describe('classifyJob', () => {
  test('RUNNING job: not quota-wait, no attention needed', () => {
    const r = classifyJob(
      {
        name: 'projects/1/locations/us-central1/customJobs/999',
        displayName: 'voice-tool-router-ft-2026',
        state: 'JOB_STATE_RUNNING',
        createTime: minsAgo(40),
        startTime: minsAgo(10),
      },
      NOW,
    );
    expect(r.verdict).toBe('RUNNING');
    expect(r.quotaWait).toBe(false);
    expect(r.needsAttention).toBe(false);
    expect(r.jobId).toBe('999');
  });

  test('SUCCEEDED job: success, no attention needed', () => {
    const r = classifyJob({ name: 'x/customJobs/1', state: 'JOB_STATE_SUCCEEDED' }, NOW);
    expect(r.verdict).toBe('SUCCEEDED');
    expect(r.needsAttention).toBe(false);
    expect(r.summary).toMatch(/SUCCEEDED/);
  });

  test('FAILED job: surfaces error message and needs attention', () => {
    const r = classifyJob(
      {
        name: 'x/customJobs/2',
        state: 'JOB_STATE_FAILED',
        error: { code: 9, message: 'torch shadowed the container PyTorch' },
      },
      NOW,
    );
    expect(r.verdict).toBe('FAILED');
    expect(r.needsAttention).toBe(true);
    expect(r.errorMessage).toMatch(/torch shadowed/);
    expect(r.summary).toMatch(/torch shadowed/);
  });

  test('stuck PENDING job: quota-wait verdict needs attention and names the fix', () => {
    const r = classifyJob(
      {
        name: 'x/customJobs/3',
        state: 'JOB_STATE_PENDING',
        createTime: minsAgo(STUCK_PENDING_THRESHOLD_MINUTES + 60),
      },
      NOW,
    );
    expect(r.verdict).toBe('PENDING');
    expect(r.quotaWait).toBe(true);
    expect(r.needsAttention).toBe(true);
    expect(r.summary).toMatch(/quota/i);
  });

  test('fresh PENDING job: not quota-wait, no attention needed', () => {
    const r = classifyJob(
      { name: 'x/customJobs/4', state: 'JOB_STATE_PENDING', createTime: minsAgo(2) },
      NOW,
    );
    expect(r.verdict).toBe('PENDING');
    expect(r.quotaWait).toBe(false);
    expect(r.needsAttention).toBe(false);
  });

  test('empty describe (no job found): UNKNOWN and needs attention', () => {
    const r = classifyJob({}, NOW);
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.jobId).toBeNull();
    expect(r.needsAttention).toBe(true);
    expect(r.summary).toMatch(/No matching CustomJob/);
  });
});

describe('pickLatestJob', () => {
  test('returns the most recent job by createTime', () => {
    const jobs: VertexJobDescribe[] = [
      { name: 'x/customJobs/old', createTime: minsAgo(500) },
      { name: 'x/customJobs/new', createTime: minsAgo(10) },
      { name: 'x/customJobs/mid', createTime: minsAgo(100) },
    ];
    expect(pickLatestJob(jobs)?.name).toBe('x/customJobs/new');
  });

  test('returns null for an empty list', () => {
    expect(pickLatestJob([])).toBeNull();
  });
});

describe('verdictToEventStatus', () => {
  test('maps verdicts onto OASIS event status values', () => {
    expect(verdictToEventStatus('SUCCEEDED')).toBe('success');
    expect(verdictToEventStatus('FAILED')).toBe('error');
    expect(verdictToEventStatus('PENDING')).toBe('warning');
    expect(verdictToEventStatus('RUNNING')).toBe('info');
    expect(verdictToEventStatus('UNKNOWN')).toBe('warning');
  });
});
