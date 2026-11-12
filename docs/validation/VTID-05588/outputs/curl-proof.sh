#!/usr/bin/env bash
# VTID-05588 curl proof: the BUILT companion router (services/gateway/dist, `npm run build` of this branch) mounted at
# /api/v1/companion on 127.0.0.1 with the real requireAuth/requireExafyAdmin middleware. No Supabase, no network beyond
# localhost, no token: it proves the route is mounted and refuses an unauthenticated call before any work.
# Run from services/gateway after `npm run build`.
set -euo pipefail
PORT=18588
node -e "
const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/v1/companion', require('./dist/routes/companion').default);
app.listen($PORT, '127.0.0.1');
" &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for i in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/v1/companion/status" && break; sleep 0.2; done

echo '$ curl -s -X POST http://127.0.0.1:'$PORT'/api/v1/companion/test-card -H "Content-Type: application/json" -d "{}"'
curl -s -w '\nHTTP %{http_code}\n' -X POST "http://127.0.0.1:$PORT/api/v1/companion/test-card" -H 'Content-Type: application/json' -d '{}'
echo '$ curl -s -X POST .../test-card -H "Authorization: Bearer not-a-jwt" -d "{\"user_id\":\"x\"}"'
curl -s -w '\nHTTP %{http_code}\n' -X POST "http://127.0.0.1:$PORT/api/v1/companion/test-card" -H 'Content-Type: application/json' -H 'Authorization: Bearer not-a-jwt' -d '{"user_id":"x"}'
echo '$ curl -s -X GET .../test-card   (only POST is routed)'
curl -s -o /dev/null -w 'HTTP %{http_code}\n' "http://127.0.0.1:$PORT/api/v1/companion/test-card"
echo '$ curl -s .../status'
curl -s -w '\nHTTP %{http_code}\n' "http://127.0.0.1:$PORT/api/v1/companion/status"
