import express from 'express';
import request from 'supertest';
import { generateOpenApi, VCAOP_ROUTES } from '../../src/api/openapi';
import { buildVcaopRouter } from '../../src/api/router';
import { InMemoryRepository } from '../../src/api/repository';
import { InMemoryOasisSink } from '../../src/api/oasis-sink';
import { PolicyEngine } from '../../src/guardrails/policy-engine';

describe('CTRL-API-0004 — OpenAPI', () => {
  test('generates a valid 3.0.3 doc covering every route', () => {
    const doc = generateOpenApi();
    expect(doc.openapi).toBe('3.0.3');
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    // every declared route appears in paths with its method
    for (const r of VCAOP_ROUTES) {
      const p = `/api/v1/vcaop${r.path}`;
      expect(doc.paths[p]).toBeDefined();
      expect(doc.paths[p][r.method]).toBeDefined();
      expect((doc.paths[p][r.method] as any)['x-roles']).toEqual(r.roles);
    }
    expect(doc.components).toHaveProperty('schemas.ApiOk');
    expect(doc.components).toHaveProperty('schemas.ApiErr');
  });

  test('path params are declared for templated routes', () => {
    const doc = generateOpenApi();
    const op = doc.paths['/api/v1/vcaop/approvals/{taskId}'].post as any;
    expect(op.parameters).toEqual([{ name: 'taskId', in: 'path', required: true, schema: { type: 'string' } }]);
  });

  test('GET /openapi.json is served without auth', async () => {
    const app = express();
    app.use('/api/v1/vcaop', buildVcaopRouter({ repo: new InMemoryRepository(), oasis: new InMemoryOasisSink(), policyEngine: new PolicyEngine() }));
    const r = await request(app).get('/api/v1/vcaop/openapi.json'); // no auth headers
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe('3.0.3');
  });
});
