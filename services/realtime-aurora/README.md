# realtime-aurora — self-hosted Supabase Realtime on Aurora (VTID-05023, part 7a)

The owner chose plan part **7a** on 2026-10-10 (`docs/validation/VTID-05023/plan-sparring.md`,
Gate 1): before the Aurora cutover, members' `postgres_changes`, broadcast and
presence move from Supabase's hosted Realtime to the open-source Supabase
Realtime server, run by us on ECS against Aurora `vitana-aurora-prod`. This
supersedes the 2026-08-29 "option (b) only" addendum in
`docs/AURORA-B5-REALTIME-INVENTORY.md`.

```
browser (realtime-js) ──wss──> Cloudflare (proxied, WAF skip) ──> vitana-alb-prod
   rule priority 9: Host realtime.vitanaland.com AND path /socket, /socket/*,
                    /api/broadcast, /api/broadcast/*  ──> vitana-tg-realtime-prod (HTTP 4000)
──> ECS service vitana-realtime-aurora-prod (1 task, family vitana-realtime-aurora-prod)
──TLS, login role realtime_admin──> Aurora vitana-aurora-prod, database `vitana`
     postgres_changes: temporary logical slot, plugin wal2json, publication supabase_realtime (33 tables)
     broadcast-from-database: temporary slot, pgoutput, publication supabase_realtime_messages_publication
```

| What | Where |
|---|---|
| Image | `Dockerfile` (this directory) → ECR `vitana/realtime-aurora:prod-<sha12>`, task definition pins the digest |
| Database setup | `scripts/aws/aurora-realtime-setup.sql` (+ `aurora-realtime-set-password.sh`, `scram_verifier.py`) |
| Deploy + edge | `.github/workflows/AWS-PROD-DEPLOY-REALTIME-AURORA.yml` (dispatch-only, `phase=secrets` then `phase=deploy`) |
| Test | `test/local-delivery.sh` — `npm run test:realtime-local` |

## Image: `supabase/realtime:v2.134.10`, pinned by digest

`supabase/realtime:v2.134.10@sha256:cbcc6a7986fc28b6dcffa798b077d5fb9c69cd25500371ab49147a86d7edbb03`
(amd64 manifest `sha256:c1d078d9…`), published on Docker Hub 2026-09-07.

Why this one: it is the version Supabase's own self-host stack pins
(`supabase/supabase` → `docker/docker-compose.yml` on master, read 2026-10-10),
so it is the release Supabase ships for exactly this use, and it is a month
old. Realtime releases several times a week (v2.143.3 on 2026-10-09). Newer
tags were not chosen because nothing here needs them, and the current
release has not been in the field long. Bump it only together with a green
`npm run test:realtime-local`. The Dockerfile replaces one file in it,
`priv/repo/seeds.exs` (see "Two secrets, not one").

## Which tenant `realtime.vitanaland.com` is

Realtime is multi-tenant. It finds the tenant of every connection **from the
Host header**. `RealtimeWeb.UserSocket.connect/3` calls
`Realtime.Database.get_external_id(host)`, and in v2.134.10 that is
`String.split(host, ".", parts: 2)`, which takes **the first DNS label**:

| Host the browser connects to | Tenant `external_id` |
|---|---|
| `realtime.vitanaland.com` | **`realtime`** |
| `realtime-dev.supabase-realtime` (Supabase's compose file) | `realtime-dev` |
| `127.0.0.1` | `127` |

So the tenant must be called `realtime`. With `SEED_SELF_HOST=true` the image's
`run.sh` runs `/app/bin/migrate` (Realtime's own tables in `_realtime`), then
`Realtime.Release.seeds/1`, which evaluates `priv/repo/seeds.exs`. Ours creates
the tenant `SELF_HOST_TENANT_NAME` (`realtime`), or updates it if it exists,
with one `postgres_cdc_rls` extension that points at the same Aurora database,
and then runs the tenant migrations (the `realtime` schema). The workflow
derives `SELF_HOST_TENANT_NAME` from the host input's first label, so the two
cannot drift. Cloudflare and the ALB pass the Host header through unchanged.

Checked in the source of the pinned tag (`lib/realtime/database.ex`,
`lib/realtime_web/channels/user_socket.ex`) and by the local test: Host
`realtime.vitanaland.com` → 101 Switching Protocols, Host
`other.vitanaland.com` → 404 (tenant not found). **The app must connect to
exactly `wss://realtime.vitanaland.com/socket`.** Another hostname, even a
CNAME to the same ALB, is a different tenant and gets 404.

## Two secrets, not one (security)

Upstream `seeds.exs` copies `API_JWT_SECRET` into the tenant's `jwt_secret`,
and Supabase's compose file sets `API_JWT_SECRET` to the project JWT secret.
`API_JWT_SECRET` is also the credential of the **management API**
(`/api/tenants`: list, create, update, delete tenants, `reload`, `shutdown`).
`RealtimeWeb.Router.check_auth/2` checks only the token's signature, not its
role. If we followed upstream, every member token and the **public anon key**
would be a valid management credential. Anyone could delete the tenant, or
create one that points the server at any host.

So:

| Env | Value | Used for |
|---|---|---|
| `TENANT_JWT_SECRET` | `vitana/supabase/prod/jwt-secret` (the same secret Supabase Auth signs member tokens with) | the tenant's `jwt_secret`: validates `apikey` on connect and each channel's `access_token` |
| `API_JWT_SECRET`, `METRICS_JWT_SECRET` | `vitana/realtime/prod/api-jwt-secret` (random, generated once) | `/api/tenants*`, `/metrics` — operator only |

`seeds.exs` refuses to start if the two are equal. The local test proves that
the anon key and a `service_role` token both get **403** on `/api/tenants`,
and the separate secret gets 200. On top of that, the ALB routes only
`/socket*` and `/api/broadcast*` to Realtime, so the management API, `/metrics`,
`/admin` (LiveDashboard) and the inspector are never reachable from the
internet. Requests for other paths on the realtime host fall through to the
listener's other rules and never reach Realtime.

## Environment (task definition `vitana-realtime-aurora-prod`)

| Variable | Value | Why |
|---|---|---|
| `DB_HOST` / `DB_PORT` | Aurora writer endpoint / port, resolved by the workflow (`aws rds describe-db-clusters`) | Realtime's own state (`_realtime`) and the tenant's CDC connection, both on the writer |
| `DB_NAME` | `vitana` | the application database (not `postgres`) |
| `DB_USER` / `DB_PASSWORD` | `realtime_admin` / secret `vitana/aurora/prod/realtime-admin-password` | dedicated non-superuser role (below) |
| `DB_SSL`, `TENANT_DB_SSL` | `true` | TLS to Aurora for both connections (`verify_none`: the image has no RDS CA bundle). Upstream seeds hardcode `ssl_enforced=false` for the tenant connection; ours reads `TENANT_DB_SSL`. The test's Postgres rejects non-TLS logins. |
| `DB_AFTER_CONNECT_QUERY` | `SET search_path TO _realtime` | as upstream self-host: Realtime's own tables live in `_realtime` |
| `DB_ENC_KEY` | secret `vitana/realtime/prod/db-enc-key` (16 chars) | AES key for tenant settings (DB password, JWT secret) stored in `_realtime`. **Never rotate** without re-seeding (a restart re-seeds). |
| `SECRET_KEY_BASE` | secret `vitana/realtime/prod/secret-key-base` (64 chars) | Phoenix |
| `API_JWT_SECRET`, `METRICS_JWT_SECRET` | secret `vitana/realtime/prod/api-jwt-secret` | management API (above) |
| `TENANT_JWT_SECRET` | secret `vitana/supabase/prod/jwt-secret` | member tokens (above) |
| `APP_NAME` | `realtime` | required in prod; also the Erlang node basename |
| `SEED_SELF_HOST` / `SELF_HOST_TENANT_NAME` | `true` / `realtime` | single-tenant self-host (above) |
| `ERL_AFLAGS`, `ECTO_IPV6`, `DB_IP_VERSION`, `REALTIME_IP_VERSION` | `-proto_dist inet_tcp`, `false`, `ipv4`, `ipv4` | the image defaults to IPv6 distribution. The VPC subnets and the Aurora endpoint are IPv4. |
| `CLUSTER_STRATEGIES`, `DNS_NODES` | `POSTGRES`, `''` | clustering (below). `DNS_NODES` is only read by the `DNS` strategy. It is set as in Supabase's compose file. |
| `RLIMIT_NOFILE` + task `ulimits nofile` | `100000` | one file descriptor per websocket. `run.sh` raises the soft limit, which must stay ≤ the hard limit. |
| `MAX_CONNECTIONS` | `16384` | HTTP/websocket connections per node (default 1000) |
| `TENANT_MAX_CONCURRENT_USERS` / `_EVENTS_PER_SECOND` / `_JOINS_PER_SECOND` / `_CHANNELS_PER_CLIENT` / `_BYTES_PER_SECOND` | 10000 / 1000 / 500 / 100 / 1000000 | tenant limits applied when the tenant row is written. The defaults (200 concurrent users, 100 events/s) are far below Vitana's member count. **Review these against Supabase's project limits before the switch.** |
| `RUN_JANITOR`, `DISABLE_HEALTHCHECK_LOGGING`, `LOG_LEVEL` | `true`, `true`, `info` | as upstream self-host |

Health: `GET /healthcheck` → `200 ok` without auth. Both the container
health check (`curl`) and the target group use it. Note that the seed step
boots the whole app, so `/healthcheck` already answers while seeds run. A
seed failure exits the container (our `seeds.exs` raises), and the circuit
breaker then stops the rollout.

## Database setup on Aurora (`scripts/aws/aurora-realtime-setup.sql`)

Run it as the master user through the Data API, **after** the approved reboot
that makes `rds.logical_replication=1` take effect. It is idempotent.

| Statement | Why |
|---|---|
| `wal_level = logical` check | Realtime needs logical decoding. Without it the file refuses to run. |
| `output_plugin_libraries` check + a temporary `wal2json` probe slot, dropped in the same statement | postgres_changes decodes WAL with **wal2json** (`pg_create_logical_replication_slot(…, 'wal2json', true)`). Newer PostgreSQL minors (PG 17.11 in the test) let non-superuser REPLICATION roles use only plugins listed in `output_plugin_libraries` (default `pgoutput, test_decoding`). Where that parameter exists, the cluster parameter group must add `wal2json`. |
| refuse a `realtime`/`_realtime` schema not owned by `realtime_admin` | a copy of Supabase's own `realtime` schema from the data load would clash with Realtime's migration bookkeeping |
| role `realtime_admin`: LOGIN, INHERIT, no superuser, no CREATEROLE, no BYPASSRLS, 60 connections, **no password** | the password is set by `aurora-realtime-set-password.sh` as a SCRAM verifier. The plaintext never appears in SQL, Aurora logs or the repo. |
| `GRANT rds_replication` | logical slots and the replication protocol (Aurora's equivalent of the REPLICATION attribute) |
| `GRANT CONNECT, CREATE ON DATABASE vitana` | Realtime creates `supabase_realtime_messages_publication` for broadcast-from-database |
| schemas `_realtime`, `realtime` owned by `realtime_admin` | Realtime's state, and the tenant schema its migrations fill |
| roles `supabase_realtime_admin` (realtime_admin holds it WITH ADMIN, INHERIT), `postgres` and `dashboard_user` (NOLOGIN, only if missing) | the tenant migrations create/grant `supabase_realtime_admin` (that needs CREATEROLE, so we pre-create it), `GRANT … TO postgres`, and `REVOKE … FROM dashboard_user` |
| `GRANT anon, authenticated, service_role TO realtime_admin WITH INHERIT FALSE, SET TRUE` | `realtime.apply_rls` switches to each subscriber's role to evaluate RLS. With SET only and no inherit, realtime_admin never gains service_role's table privileges. |
| `GRANT SET ON PARAMETER log_min_messages` | `realtime.list_changes` is created with `SET log_min_messages TO 'fatal'`, a superuser parameter. The local test proved a non-superuser cannot create it without this grant. |
| REPLICA IDENTITY FULL for 29 tables, then publication `supabase_realtime` = exactly the 33 tables, then a verify block (33 / 29 FULL / 4 DEFAULT) | mirrors Supabase (`pg_publication_tables` read 2026-10-10). Identities are set before publishing. The 4 DEFAULT tables must have a primary key, otherwise their UPDATE/DELETE would fail once published, and the file checks this first. |

Realtime's replication slots are **temporary**: they disappear when its
connection closes. A stopped Realtime therefore never makes Aurora retain WAL.
The slot-lag alarm from sparring finding R3 is still needed for the
**permanent** slots of the DMS CDC tasks (parts 8b and 12), not for these.

## Order of operations

1. Owner-approved: set `rds.logical_replication=1` in the cluster parameter
   group and reboot. Where the engine has `output_plugin_libraries`, add
   `wal2json` to it in the same change.
2. `AWS-PROD-DEPLOY-REALTIME-AURORA.yml`, `phase=secrets`.
3. CloudShell: `bash scripts/aws/aurora-run-sql.sh scripts/aws/aurora-realtime-setup.sql`,
   then `bash scripts/aws/aurora-realtime-set-password.sh`. **Run both on the
   Aurora clone first** (plan part 10).
4. Add the security-group rule if the workflow printed one (TCP 4000 from the
   ALB SG to the service SG).
5. `phase=deploy` with a pinned `commit_sha`, `logical_replication_confirmed=true`,
   `setup_sql_applied=true` and a fresh part-0 `parity_report`.
6. vitana-v1 (separate PR): `RealtimeClient('wss://realtime.vitanaland.com/socket',
   { params: { apikey: <anon key> } })`, `setAuth(session.access_token)` from
   `onAuthStateChange`, every channel through `realtimeChannel()`.

## Scaling: one task, on purpose

The service runs **one** task. Deployments use `maximumPercent=100` and
`minimumHealthyPercent=0`: the old task stops before the new one starts, and
clients reconnect by themselves (realtime-js retries with backoff), with a gap
of about 1–2 minutes.

Two Realtime nodes that are not clustered would both start the tenant. Both
would try to use the same replication slot name, and presence would split. To
cluster, nodes must find each other (`CLUSTER_STRATEGIES=POSTGRES` uses
LISTEN/NOTIFY on the same database, or `DNS` with a Cloud Map name in
`DNS_NODES`). They must also reach each other: Erlang distribution (epmd 4369
plus the dist port) and gen_rpc 5369, which means a self-referencing SG rule.
Each node also needs a distinct, routable node name. **On Fargate the image's
`env.sh` takes the node IP from the task's IPv6 address and falls back to
`127.0.0.1` when the subnet has no IPv6**, so every task would be
`realtime@127.0.0.1`. Multi-task needs that fixed (for example by setting the
node name from the IPv4 address in the task metadata) and its own test. One
node handled the member counts in `AURORA-B5-REALTIME-INVENTORY.md` with room
to spare: 1 vCPU, 2 GB, 16k connections.

The ALB idle timeout (60 s default) is longer than realtime-js's 25 s
heartbeat, so idle sockets stay open. No stickiness is needed with one target.

## Tests

`npm run test:realtime-local` (`test/local-delivery.sh`, about 2 minutes, needs
docker, node, python3, openssl):

- Postgres 17 (Aurora's major) with `wal_level=logical`, wal2json, TLS-only
  password logins, the API roles, `auth.uid()` and a stub `rds_replication`;
- the setup SQL **unchanged** except its `-- @tables` lines, run twice, as
  non-superuser `realtime_admin`, password set through `scram_verifier.py`;
- the `@tables` part applied twice in a scratch database holding the 33 table
  names, and the primary-key precondition refusing a keyless table;
- this directory's image with the production env shape;
- management API: 403 for the anon and service_role tokens, 200 for the
  separate secret; REST broadcast 202; websocket upgrade 101 (anon key,
  `Host: realtime.vitanaland.com`) / 401 (forged token) / 404 (other host);
- `@supabase/realtime-js` (default 2.80.0, the gateway's; `REALTIME_JS_VERSION=2.15.1`,
  the app's current version, also passes): an RLS-filtered INSERT reaches the
  owner and the other user's row does not, UPDATE carries the old row,
  broadcast with ack, presence;
- container restart (seeds upsert on an existing tenant), then delivery again.

Clients must wait for the channel's `system` message
`{extension: 'postgres_changes', status: 'ok'}` before relying on delivery.
`SUBSCRIBED` arrives before the server has registered the subscription, and
Supabase's hosted Realtime behaves the same way. The first run of the test,
written without this wait, missed an INSERT made during that window.

## IAM and network the workflow needs

- **Deploy role** (`AWS_PROD_ROLE_ARN`): `secretsmanager:DescribeSecret`,
  `GetRandomPassword`, `CreateSecret`, `TagResource` on `vitana/realtime/prod/*`
  and `vitana/aurora/prod/realtime-admin-password`; `GetSecretValue` on
  `vitana/supabase/prod/anon-key` (verification); `ecr:CreateRepository`,
  `DescribeRepositories`, `DescribeImages` + push; `ecs:RegisterTaskDefinition`,
  `CreateService`, `UpdateService`, `Describe*`, `ListTasks`;
  `iam:PassRole` on the execution role; `iam:SimulatePrincipalPolicy` (optional);
  `elasticloadbalancing:CreateTargetGroup`, `ModifyTargetGroup(Attributes)`,
  `CreateRule`, `Describe*`, `AddTags`; `ec2:DescribeSecurityGroups`;
  `rds:DescribeDBClusters`, `rds:DescribeDBClusterParameters`;
  `logs:CreateLogGroup`, `PutRetentionPolicy`; `s3:GetObject` on the parity
  report.
- **Execution role**: the one `vitana-postgrest-aurora-prod` uses. It needs
  `secretsmanager:GetSecretValue` on the four new secrets, in addition to
  `vitana/supabase/prod/jwt-secret`. The workflow checks this and lists what
  is missing. No task role: Realtime calls no AWS API here.
- **Security groups**: the service uses the same subnets and SG as
  `vitana-postgrest-aurora-proxy-prod`. That SG already reaches Aurora on
  5432. It must also allow **TCP 4000 from the ALB's SG**. The workflow
  checks, prints the exact `authorize-security-group-ingress` command and
  stops if the rule is missing.
- **Cloudflare**: proxied CNAME (Cloudflare proxies websockets; Network →
  WebSockets must be on) and the WAF/bot skip rule. A challenge page cannot
  be answered inside a websocket handshake.

## Open points

- **`GRANT SET ON PARAMETER log_min_messages` on Aurora is unverified.** The
  master user is `rds_superuser`, not a superuser. If Aurora refuses the
  grant, stop and decide by review. Never run Realtime as the master user.
- **wal2json on Aurora PostgreSQL 17.4** is expected (Aurora lists it as a
  supported decoding plugin) but unverified. The setup SQL's temporary probe
  slot proves it, or fails loudly.
- **Roles `anon`/`authenticated`/`service_role` on Aurora**: the master must
  hold ADMIN on them for statement 8. That holds if the master created them.
- **Whether a `realtime` schema came across in the data load**: the setup SQL
  refuses to adopt it. Remove it by review.
- **Tenant limits** above versus Supabase's plan limits; **one node's
  capacity** under real load: measure on the Aurora clone (plan part 10).
- **`rds.force_ssl`**: both connections use TLS anyway.
