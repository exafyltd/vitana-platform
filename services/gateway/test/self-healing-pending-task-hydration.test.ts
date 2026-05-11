import express from 'express';
import request from 'supertest';
import { workerOrchestratorRouter } from '../src/routes/worker-orchestrator';
import { computeSpecChecksum, VtidSpecContent } from '../src/services/vtid-spec-service';

const app = express();
app.use(express.json());
app.use(workerOrchestratorRouter);

function mockJsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => data,
    text: async () => JSON.stringify(data),
    blob: async () => new Blob(),
    arrayBuffer: async () => new ArrayBuffer(0),
    formData: async () => new FormData(),
  } as Response);
}

describe('self-healing pending task hydration', () => {
  const fetchMock = global.fetch as jest.Mock;

  it('hydrates self-healing tasks with spec content, metadata, domain, target paths, and spec hash', async () => {
    const specContent: VtidSpecContent = {
      vtid: 'VTID-09001',
      title: 'Repair ORB health endpoint',
      spec_text: 'Patch the ORB health route and run the endpoint smoke test.',
      task_domain: 'backend',
      target_paths: ['services/gateway/src/routes/orb-live.ts'],
      acceptance_criteria: ['Health endpoint returns 200'],
      snapshot_created_at: '2026-05-11T00:00:00.000Z',
    };
    const specChecksum = computeSpecChecksum(specContent);

    fetchMock.mockImplementation((url: string | Request) => {
      const urlString = typeof url === 'string' ? url : url.url;

      if (urlString.includes('/rest/v1/vtid_ledger?')) {
        return mockJsonResponse([
          {
            vtid: 'VTID-09001',
            title: 'SELF-HEAL: ORB health endpoint',
            summary: 'Legacy summary should not replace canonical spec text',
            status: 'scheduled',
            spec_status: 'approved',
            layer: 'INFRA',
            module: 'GATEWAY',
            metadata: {
              source: 'self-healing',
              endpoint: '/api/v1/orb/health',
              failure_class: 'endpoint_health',
              files_to_modify: ['fallback/path.ts'],
              spec_hash: 'legacy-hash',
            },
            created_at: '2026-05-11T00:00:00.000Z',
            updated_at: '2026-05-11T00:01:00.000Z',
            claimed_by: null,
            claim_expires_at: null,
            claim_started_at: null,
            is_terminal: false,
          },
        ]);
      }

      if (urlString.includes('/rest/v1/vtid_specs?vtid=eq.VTID-09001')) {
        return mockJsonResponse([
          {
            vtid: 'VTID-09001',
            tenant_id: 'default',
            spec_version: 1,
            spec_content: specContent,
            spec_checksum: specChecksum,
            primary_domain: 'backend',
            system_surface: ['gateway'],
            created_at: '2026-05-11T00:00:00.000Z',
            locked_at: '2026-05-11T00:00:00.000Z',
            created_by: 'self-healing',
            metadata: { source: 'self-healing' },
          },
        ]);
      }

      if (urlString.includes('/rest/v1/oasis_events')) {
        return mockJsonResponse([]);
      }

      return mockJsonResponse([]);
    });

    const response = await request(app)
      .get('/api/v1/worker/orchestrator/tasks/pending')
      .query({ worker_id: 'worker-runner-1', limit: 1 })
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(response.body.count).toBe(1);
    expect(response.body.tasks[0]).toMatchObject({
      vtid: 'VTID-09001',
      title: 'SELF-HEAL: ORB health endpoint',
      spec_content: 'Patch the ORB health route and run the endpoint smoke test.',
      task_domain: 'backend',
      target_paths: ['services/gateway/src/routes/orb-live.ts'],
      spec_hash: specChecksum,
      metadata: {
        source: 'self-healing',
        endpoint: '/api/v1/orb/health',
        failure_class: 'endpoint_health',
      },
    });
  });

  it('hydrates self-healing tasks from legacy markdown specs when canonical spec content is unavailable', async () => {
    const specMarkdown = '# Legacy self-healing spec\n\nPatch the availability route and verify health.';

    fetchMock.mockImplementation((url: string | Request) => {
      const urlString = typeof url === 'string' ? url : url.url;

      if (urlString.includes('/rest/v1/vtid_ledger?')) {
        return mockJsonResponse([
          {
            vtid: 'VTID-09003',
            title: 'SELF-HEAL: availability health',
            summary: 'Legacy summary',
            status: 'scheduled',
            spec_status: 'approved',
            layer: 'INFRA',
            module: 'GATEWAY',
            metadata: {
              source: 'self-healing',
              endpoint: '/api/v1/availability/health',
              failure_class: 'import_error',
              files_to_modify: ['services/gateway/src/routes/availability-readiness.ts'],
              spec_hash: 'metadata-hash',
            },
            created_at: '2026-05-11T00:00:00.000Z',
            updated_at: '2026-05-11T00:01:00.000Z',
            claimed_by: null,
            claim_expires_at: null,
            claim_started_at: null,
            is_terminal: false,
          },
        ]);
      }

      if (
        urlString.includes('/rest/v1/vtid_specs?vtid=eq.VTID-09003') &&
        urlString.includes('select=vtid,title,spec_markdown')
      ) {
        return mockJsonResponse([
          {
            vtid: 'VTID-09003',
            title: 'SELF-HEAL: VTID-09003',
            spec_markdown: specMarkdown,
            spec_hash: 'legacy-hash',
            status: 'validated',
            created_by: 'self-healing',
            created_at: '2026-05-11T00:00:00.000Z',
          },
        ]);
      }

      if (urlString.includes('/rest/v1/vtid_specs?vtid=eq.VTID-09003')) {
        return mockJsonResponse([]);
      }

      if (urlString.includes('/rest/v1/oasis_events')) {
        return mockJsonResponse([]);
      }

      return mockJsonResponse([]);
    });

    const response = await request(app)
      .get('/api/v1/worker/orchestrator/tasks/pending')
      .query({ worker_id: 'worker-runner-1', limit: 1 })
      .expect(200);

    expect(response.body.tasks[0]).toMatchObject({
      vtid: 'VTID-09003',
      spec_content: specMarkdown,
      task_domain: 'backend',
      target_paths: ['services/gateway/src/routes/availability-readiness.ts'],
      spec_hash: 'legacy-hash',
    });
  });

  it('rejects self-healing success without repair evidence at gateway completion gates', async () => {
    fetchMock.mockImplementation((url: string | Request) => {
      const urlString = typeof url === 'string' ? url : url.url;

      if (urlString.includes('/rest/v1/vtid_ledger?vtid=eq.VTID-09002')) {
        return mockJsonResponse([
          {
            vtid: 'VTID-09002',
            metadata: {
              source: 'self-healing',
              endpoint: '/api/v1/orb/health',
            },
          },
        ]);
      }

      if (urlString.includes('/rest/v1/oasis_events')) {
        return mockJsonResponse([]);
      }

      return mockJsonResponse([]);
    });

    const subagentResponse = await request(app)
      .post('/api/v1/worker/subagent/complete')
      .send({
        vtid: 'VTID-09002',
        domain: 'backend',
        run_id: 'run_missing_evidence',
        result: {
          ok: true,
          files_changed: [],
          files_created: [],
          summary: 'Claimed fixed without patch evidence',
        },
      })
      .expect(400);

    expect(subagentResponse.body).toMatchObject({
      ok: false,
      reason: 'missing_repair_evidence',
      error: 'self-healing completion requires repair evidence',
    });

    const orchestratorResponse = await request(app)
      .post('/api/v1/worker/orchestrator/complete')
      .send({
        vtid: 'VTID-09002',
        run_id: 'run_missing_evidence',
        domain: 'backend',
        success: true,
        summary: 'Claimed fixed without patch evidence',
        result: {
          files_changed: [],
          files_created: [],
        },
      })
      .expect(400);

    expect(orchestratorResponse.body).toMatchObject({
      ok: false,
      reason: 'missing_repair_evidence',
      error: 'self-healing completion requires repair evidence',
    });
  });
});
