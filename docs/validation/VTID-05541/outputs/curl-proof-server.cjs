// VTID-05541 local curl proof: the BUILT route (services/gateway/dist, `npm run build` of this branch) mounted the way
// services/gateway/src/index.ts mounts it, on 127.0.0.1 only, with a local stand-in for the OASIS table.
//
//   node curl-proof-server.cjs <gateway dir> <route port> <sink port>
//
// Mount order copied from index.ts: express.raw + gitlabWebhookBodyErrors on /api/v1/internal/gitlab/webhook, then
// express.json({ limit: '2mb' }), then delegatedTokenGuard(), then mountRouterSync(app, '/api/v1/internal/gitlab', …).
// SUPABASE_URL points at the sink below, so emitOasisEvent's INSERT lands in this process and nowhere else. The sink
// answers 201, or 503 once after POST /fail-next. GET /rows lists what it received (no key or header is kept).
'use strict';
const http = require('http');
const path = require('path');

const [gw, routePort, sinkPort] = process.argv.slice(2);
if (!gw || !routePort || !sinkPort) throw new Error('usage: curl-proof-server.cjs <gateway dir> <route port> <sink port>');
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.SUPABASE_URL || '')) throw new Error('SUPABASE_URL must be the local sink');

const rows = [];
let failNext = false;
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/rows') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(rows));
      }
      if (req.method === 'POST' && req.url === '/fail-next') {
        failNext = true;
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'POST' && req.url.startsWith('/rest/v1/oasis_events')) {
        if (failNext) {
          failNext = false;
          res.writeHead(503, { 'content-type': 'text/plain' });
          return res.end('sink: refused once on purpose');
        }
        rows.push(JSON.parse(body));
        res.writeHead(201, { 'content-type': 'application/json' });
        return res.end('[]');
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('sink: unexpected request');
    });
  })
  .listen(Number(sinkPort), '127.0.0.1');

const express = require(path.join(gw, 'node_modules', 'express'));
const dist = (p) => require(path.join(gw, 'dist', p));
const { mountRouterSync } = dist('governance/route-guard');
const { delegatedTokenGuard } = dist('services/delegation-guard');
const {
  default: internalGitlabWebhookRouter,
  gitlabWebhookBodyErrors,
  GITLAB_WEBHOOK_BODY_LIMIT,
} = dist('routes/internal-gitlab-webhook');

const app = express();
app.use('/api/v1/internal/gitlab/webhook', express.raw({ type: '*/*', limit: GITLAB_WEBHOOK_BODY_LIMIT }), gitlabWebhookBodyErrors);
app.use(express.json({ limit: '2mb' }));
app.use(delegatedTokenGuard());
mountRouterSync(app, '/api/v1/internal/gitlab', internalGitlabWebhookRouter, { owner: 'internal-gitlab-webhook' });
app.listen(Number(routePort), '127.0.0.1', () => console.log(`route on 127.0.0.1:${routePort}, OASIS sink on 127.0.0.1:${sinkPort}`));
