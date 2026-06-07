/**
 * OpenAPI spec generation for the VCAOP API (CTRL-API-0004 follow-up, runbook Sec. 6
 * AC: "OpenAPI generated"). Describes the 10 resource groups, their methods, role
 * requirements, and the standard `{ ok, data | error }` envelope. Pure data — no
 * runtime deps — so it can be served at `/api/v1/vcaop/openapi.json` or written to disk.
 */
import { Role } from './types';

interface RouteDef {
  method: 'get' | 'post' | 'put';
  path: string; // under /api/v1/vcaop
  summary: string;
  roles: Role[];
}

/** The VCAOP route table (kept in sync with router.ts). */
export const VCAOP_ROUTES: RouteDef[] = [
  { method: 'get', path: '/providers', summary: 'List providers', roles: ['staff', 'admin', 'developer'] },
  { method: 'put', path: '/policies/{providerId}', summary: 'Set per-provider policy', roles: ['admin'] },
  { method: 'get', path: '/accounts', summary: 'List provider accounts', roles: ['staff', 'admin'] },
  { method: 'post', path: '/accounts', summary: 'Create a provider account (single-identity gated)', roles: ['staff'] },
  { method: 'get', path: '/jobs', summary: 'List provisioning jobs', roles: ['staff', 'admin'] },
  { method: 'post', path: '/jobs', summary: 'Queue a provisioning job', roles: ['staff'] },
  { method: 'get', path: '/tasks', summary: 'List human tasks', roles: ['staff', 'admin'] },
  { method: 'post', path: '/tasks', summary: 'Open a human task', roles: ['staff'] },
  { method: 'post', path: '/approvals/{taskId}', summary: 'Approve/reject a human task', roles: ['admin'] },
  { method: 'get', path: '/affiliate-programs', summary: 'List affiliate programs', roles: ['staff', 'admin'] },
  { method: 'put', path: '/affiliate-programs/{id}', summary: 'Upsert an affiliate program', roles: ['admin'] },
  { method: 'get', path: '/rewards', summary: 'List rewards (own for community)', roles: ['community', 'staff', 'admin'] },
  { method: 'get', path: '/cart', summary: 'List carts (own for community)', roles: ['community', 'staff', 'admin'] },
  { method: 'post', path: '/cart', summary: 'Open a cart', roles: ['community'] },
  { method: 'get', path: '/audit', summary: 'Read audit events', roles: ['staff', 'admin'] },
];

export interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  components: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
}

const BASE = '/api/v1/vcaop';

export function generateOpenApi(version = '0.1.0'): OpenApiDoc {
  const paths: OpenApiDoc['paths'] = {};
  for (const r of VCAOP_ROUTES) {
    const fullPath = `${BASE}${r.path}`;
    paths[fullPath] = paths[fullPath] ?? {};
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string' },
    }));
    paths[fullPath][r.method] = {
      summary: r.summary,
      'x-roles': r.roles,
      security: [{ bearerAuth: [] }],
      parameters: params,
      responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiOk' } } } },
        '401': { description: 'Unauthenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErr' } } } },
        '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErr' } } } },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'VCAOP API', version, description: 'Vitanaland Commerce & Account-Operations Platform — dev/staging only.' },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        ApiOk: { type: 'object', properties: { ok: { type: 'boolean', enum: [true] }, data: {} }, required: ['ok', 'data'] },
        ApiErr: { type: 'object', properties: { ok: { type: 'boolean', enum: [false] }, error: { type: 'string' }, code: { type: 'string' } }, required: ['ok', 'error'] },
      },
    },
    paths,
  };
}
