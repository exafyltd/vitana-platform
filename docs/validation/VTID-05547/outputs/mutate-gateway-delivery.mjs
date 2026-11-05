#!/usr/bin/env node
// Mutation check for services/gateway/test/delivery/** (VTID-05547, lane agentic-delivery/gateway-delivery).
// One value of the lane's code is broken at a time in a scratch copy (a flag name, a topic, a status, a regex, a limit, a class,
// a mount order, an auth gate ...), and the six Jest suites must go red on a NAMED CASE. Classes:
//   caught    at least one case failed by its own assertion
//   SURVIVED  every case still passed: a property the tests do not pin (fix the test)
//   CRASH     a suite failed to run at all (a syntax error made by the mutation): proves nothing (fix the mutation)
//   NOOP      the text to replace was not found exactly once: fix the mutation
// Nothing touches the worktree: the mutated file lives only in each worker's scratch copy.
//
// usage: node mutate-gateway-delivery.mjs <worktree>          env: WORKERS (default 8), ONLY (regex on the id), TMPDIR
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WT = path.resolve(process.argv[2] || '');
const GW = path.join(WT, 'services/gateway');
if (!fs.existsSync(path.join(GW, 'test/delivery'))) { console.error('usage: mutate-gateway-delivery.mjs <worktree with services/gateway/test/delivery>'); process.exit(2); }
const WORKERS = Number(process.env.WORKERS || 8);
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mutgd-'));
const JEST_TMP = path.join(ROOT, 'jest-tmp');
fs.mkdirSync(JEST_TMP, { recursive: true });

const SRC = 'services/gateway/src';
const HUB = `${SRC}/frontend/command-hub`;
const GITLAB = `${SRC}/services/gitlab-events`;

/** [id, file, find, replace] — or { id, file, apply(text) } for a change that is not one replacement. */
const M = (id, file, find, replace) => ({ id, file, find, replace });
const MUTATIONS = [
  // ---- the cut flag and the guard (services/delivery-host.ts) ----
  M('flag value not trimmed', `${SRC}/services/delivery-host.ts`, ".trim().toLowerCase() === 'gitlab' ? 'gitlab' : 'github'", ".toLowerCase() === 'gitlab' ? 'gitlab' : 'github'"),
  M('flag value case sensitive', `${SRC}/services/delivery-host.ts`, ".trim().toLowerCase() === 'gitlab'", ".trim() === 'gitlab'"),
  M('flag name prefix changed', `${SRC}/services/delivery-host.ts`, 'return `DELIVERY_HOST_${name', 'return `DELIVERY_HOSTS_${name'),
  M('refusal event renamed', `${SRC}/services/delivery-host.ts`, "type: 'delivery.merge.refused',", "type: 'delivery.merge.blocked' as never,"),
  M('refusal event status error', `${SRC}/services/delivery-host.ts`, "source: 'gateway-delivery-guard',\n      status: 'warning',", "source: 'gateway-delivery-guard',\n      status: 'error',"),
  M('refusal event loses its stage', `${SRC}/services/delivery-host.ts`, "      task_stage: 'VALIDATOR',\n      surface: 'cicd',", "      surface: 'cicd',"),
  M('refusal key ignores the operation', `${SRC}/services/delivery-host.ts`, 'refused_${operation}', 'refused'),
  M('refusal ignores the title VTID', `${SRC}/services/delivery-host.ts`, 'vtid: firstVtid(ctx.commitTitle) ?? DELIVERY_VTID,', 'vtid: DELIVERY_VTID,'),
  M('guard does not refuse', `${SRC}/services/delivery-host.ts`, '  throw new MergeMovedToGitlabError(repo, operation, pr);\n}', '  return;\n}'),
  M('guard inverted', `${SRC}/services/delivery-host.ts`, '  if (verdict.allowed) return;', '  if (!verdict.allowed) return;'),
  M('refusal code renamed', `${SRC}/services/delivery-host.ts`, "export const MERGE_MOVED_TO_GITLAB = 'merge_moved_to_gitlab' as const;", "export const MERGE_MOVED_TO_GITLAB = 'merge_moved' as never;"),
  M('guard writes no event', `${SRC}/services/delivery-host.ts`, '    await emit({', '    void ({'),
  M('a failing event write stops the refusal', `${SRC}/services/delivery-host.ts`, '  } catch {\n    console.error(`[delivery-host]', '  } catch (e) {\n    throw e;\n    console.error(`[delivery-host]'),
  M('any error counts as a refusal', `${SRC}/services/delivery-host.ts`, '(err as { code?: unknown }).code === MERGE_MOVED_TO_GITLAB;', 'true;'),
  M('refusal marked shadow', `${SRC}/services/delivery-host.ts`, "mode: 'live',\n        repo: repoShortName(repo),", "mode: 'shadow',\n        repo: repoShortName(repo),"),

  // ---- the two guarded calls (services/github-service.ts) ----
  M('merge unguarded', `${SRC}/services/github-service.ts`, "  await assertGithubMergeAllowed(repo, 'merge', { prNumber, commitTitle });\n", ''),
  M('update-branch unguarded', `${SRC}/services/github-service.ts`, "  await assertGithubMergeAllowed(repo, 'update_branch', { prNumber });\n", ''),
  M('merge guard labelled update_branch', `${SRC}/services/github-service.ts`, "assertGithubMergeAllowed(repo, 'merge', { prNumber, commitTitle })", "assertGithubMergeAllowed(repo, 'update_branch', { prNumber, commitTitle })"),
  M('merge guard drops the commit title', `${SRC}/services/github-service.ts`, "assertGithubMergeAllowed(repo, 'merge', { prNumber, commitTitle })", "assertGithubMergeAllowed(repo, 'merge', { prNumber })"),

  // ---- the mapping (services/gitlab-events/delivery-mapper.ts) ----
  M('landing without the trailer', `${GITLAB}/delivery-mapper.ts`, '  if (!mrRef) return null;\n', ''),
  M('accept-to-land reversed', `${GITLAB}/delivery-mapper.ts`, 'const s = Math.round((b - a) / 1000);', 'const s = Math.round((a - b) / 1000);'),
  M('every run is live', `${GITLAB}/delivery-mapper.ts`, "deliveryHostFor(ctx.repo, ctx.env) === 'gitlab' ? 'live' : 'shadow';", "deliveryHostFor(ctx.repo, ctx.env) === 'gitlab' ? 'live' : 'live';"),
  M('a shadow run writes deploy rows', `${GITLAB}/delivery-mapper.ts`, "if (mode === 'live' && ref === 'main' && attrs.tag !== true) {", "if (ref === 'main' && attrs.tag !== true) {"),
  M('landing on any ref', `${GITLAB}/delivery-mapper.ts`, "if (mode === 'live' && ref === 'main' && attrs.tag !== true) {", "if (mode === 'live' && attrs.tag !== true) {"),
  M('landing on a tag pipeline', `${GITLAB}/delivery-mapper.ts`, "if (mode === 'live' && ref === 'main' && attrs.tag !== true) {", "if (mode === 'live' && ref === 'main') {"),
  M('failed deploy written as error', `${GITLAB}/delivery-mapper.ts`, "type = DELIVERY_TOPICS.stagingDeployFailed; status = 'warning'", "type = DELIVERY_TOPICS.stagingDeployFailed; status = 'error'"),
  M('rollback written as success', `${GITLAB}/delivery-mapper.ts`, "type = DELIVERY_TOPICS.stagingDeployRolledBack; status = 'warning'", "type = DELIVERY_TOPICS.stagingDeployRolledBack; status = 'success'"),
  M('a canceled deploy job counts', `${GITLAB}/delivery-mapper.ts`, "if (deploy && jobStatus === 'success') {", "if (deploy && jobStatus !== 'failed') {"),
  M('claude branches ignored', `${GITLAB}/delivery-mapper.ts`, '/^(kiro|claude|assist|pm-agent)\\//', '/^(kiro|assist|pm-agent)\\//'),
  M('cutover topic renamed', `${GITLAB}/delivery-mapper.ts`, "cutover: 'scm.migration.cutover',", "cutover: 'scm.migration.cutover_done' as never,"),
  M('a tag of any repository counts', `${GITLAB}/delivery-mapper.ts`, '(vitana-platform|vitana-v1))$/.exec(ref)', '([a-z0-9-]+))$/.exec(ref)'),
  M('any host counts as moved from', `${GITLAB}/delivery-mapper.ts`, 'https:\\/\\/github\\.com\\/exafyltd\\/', 'https:\\/\\/[a-z.]+\\/exafyltd\\/'),
  M('lane files matched under any specs dir', `${GITLAB}/delivery-mapper.ts`, 'const LANE_FILE_RE = /^\\.kiro\\/specs\\/', 'const LANE_FILE_RE = /^.*specs\\/'),
  M('any verdict recorded', `${GITLAB}/delivery-mapper.ts`, "if (verdict === 'accept' || verdict === 'changes') {", 'if (verdict !== null) {'),
  M('reviewed head not validated', `${GITLAB}/delivery-mapper.ts`, "t['Collab-Reviewed-Head'] && SHA40_RE.test(t['Collab-Reviewed-Head']) ? t['Collab-Reviewed-Head'] : null", "t['Collab-Reviewed-Head']"),
  M('commit cap raised', `${GITLAB}/delivery-mapper.ts`, 'export const MAX_COMMITS = 20;', 'export const MAX_COMMITS = 200;'),
  M('landing key per pipeline', `${GITLAB}/delivery-mapper.ts`, "key: `gitlab:${ctx.scope}:landed:${mergeSha ?? pipelineId ?? '?'}`,", "key: `gitlab:${ctx.scope}:landed:${pipelineId ?? '?'}`,"),
  M('paused is not a queue label', `${GITLAB}/delivery-mapper.ts`, '(ready|updating|waiting|blocked|paused)', '(ready|updating|waiting|blocked)'),
  M('a queue label change is not an update', `${GITLAB}/delivery-mapper.ts`, 'if (queueChanged || previousHead) {', 'if (previousHead) {'),
  M('a new head is not an update', `${GITLAB}/delivery-mapper.ts`, 'if (queueChanged || previousHead) {', 'if (queueChanged) {'),
  M('nightly VTID changed', `${GITLAB}/delivery-mapper.ts`, 'const vtid = firstVtid(mr.title, commit.title) ?? DELIVERY_VTID;', "const vtid = firstVtid(mr.title, commit.title) ?? 'VTID-00000';"),
  M('job wait key renamed', `${GITLAB}/delivery-mapper.ts`, 'wait_s: num(b.queued_duration), run_s: num(b.duration) }));', 'wait_s: num(b.queued_s), run_s: num(b.duration) }));'),
  M('shadow pipeline variable ignored', `${GITLAB}/delivery-mapper.ts`, "o.key === 'DELIVERY_MODE' && typeof o.value === 'string' && o.value.trim().toLowerCase() === 'shadow'", 'false'),
  M('moved pull request leaks the description', `${GITLAB}/delivery-mapper.ts`, 'github_pr_url: moved[1],', 'github_pr_url: attrs.description,'),
  M('merge request key without the time', `${GITLAB}/delivery-mapper.ts`, "const stamp = updatedAt ?? headSha ?? '';", "const stamp = '';"),
  M('branch not remembered', `${GITLAB}/delivery-mapper.ts`, '  if (vtid && sourceBranch) branches.remember(ctx.projectPath, sourceBranch, vtid);\n', ''),
  M('queue label not read', `${GITLAB}/delivery-mapper.ts`, 'const queue = queueLabel(payload.labels);', 'const queue = null;'),
  M('push key without the head', `${GITLAB}/delivery-mapper.ts`, 'key: `gitlab:${ctx.scope}:push:${branch}:${after}`,', 'key: `gitlab:${ctx.scope}:push:${branch}`,'),
  M('pipeline key without the status', `${GITLAB}/delivery-mapper.ts`, 'const key = `gitlab:${ctx.scope}:pipeline:${pipelineId ?? \'?\'}:${status}`;', 'const key = `gitlab:${ctx.scope}:pipeline:${pipelineId ?? \'?\'}`;'),
  M('repo is the project path', `${GITLAB}/delivery-mapper.ts`, 'repo: repoShortName(projectPath),', 'repo: projectPath,'),
  M('landing source branch from the wrong trailer', `${GITLAB}/delivery-mapper.ts`, "source_branch: t['Source-Branch'],", "source_branch: t['Reviewed-Head'],"),
  M('deleted branch recorded', `${GITLAB}/delivery-mapper.ts`, "if (!after || ZERO_SHA_RE.test(after)) return { kind: 'ignore', reason: 'unmapped_action' };", "if (!after) return { kind: 'ignore', reason: 'unmapped_action' };"),
  M('update event loses the stage', `${GITLAB}/delivery-mapper.ts`, "            task_stage: 'VALIDATOR',\n            message: `GitLab merge request !${iid ?? '?'} updated", "            message: `GitLab merge request !${iid ?? '?'} updated"),
  M('deploy rows lose the commit', `${GITLAB}/delivery-mapper.ts`, '          git_commit: sha,\n          branch: \'main\',', '          branch: \'main\','),
  M('mapper.ts events not kept (event rebuilt)', `${GITLAB}/delivery-mapper.ts`, 'events.push(enrich(ctx, mode, base.event, { lane_key: laneKey, queue_label: queue }, mrKey(action)));', "events.push(enrich(ctx, mode, { ...base.event, message: 'x' }, { lane_key: laneKey, queue_label: queue }, mrKey(action)));"),

  // ---- the webhook stage (services/gitlab-events/delivery-stage.ts) ----
  M('webhook-id not remembered', `${GITLAB}/delivery-stage.ts`, '      await deliveries.once(id, async () => true);\n', ''),
  M('no per-fact dedupe', `${GITLAB}/delivery-stage.ts`, 'facts.once(event.payload.dedupe_key,', 'facts.once(String(Math.random()),'),
  M('emit failure answers 500', `${GITLAB}/delivery-stage.ts`, "return reply(res, 502, { ok: false, error: 'oasis_emit_failed' });", "return reply(res, 500, { ok: false, error: 'oasis_emit_failed' });"),
  M('GET handled by the stage', `${GITLAB}/delivery-stage.ts`, "if (req.method !== 'POST' || (req.path !== '/' && req.path !== '')) return next();", "if (req.path !== '/' && req.path !== '') return next();"),
  M('duplicate webhook-id re-processed', `${GITLAB}/delivery-stage.ts`, "      if (deliveries.seen(id)) return reply(res, 200, { ok: true, duplicate: true });\n", ''),
  M('signature gate skipped', `${GITLAB}/delivery-stage.ts`, '    requireGitlabSignature(req, res, () => {\n      void handle(res);\n    });', '    void handle(res);'),
  M('branch lookup returns many rows', `${GITLAB}/delivery-stage.ts`, '&order=created_at.desc&limit=1', '&limit=5'),
  M('branch lookup accepts any VTID', `${GITLAB}/delivery-stage.ts`, '/^VTID-\\d{5}$/.test(vtid)', 'true'),
  M('reply lists no events', `${GITLAB}/delivery-stage.ts`, 'event_id: recorded[0].event_id, events: recorded }', 'event_id: recorded[0].event_id, events: [] }'),
  M('lookup reads the wrong topics', `${GITLAB}/delivery-stage.ts`, "'scm.gitlab.merge_request.opened',\n  'scm.gitlab.merge_request.updated',", "'scm.gitlab.merge_request.opened',"),

  // ---- the summary builders (services/gitlab-events/delivery-summary.ts) ----
  { id: 'dedupe keeps the last row', file: `${GITLAB}/delivery-summary.ts`, apply: (t) => t.replace('for (const r of [...rows].sort(byTimeAsc)) {\n    const key = s(meta(r).dedupe_key);', 'for (const r of [...rows].sort((a, b) => byTimeAsc(b, a))) {\n    const key = s(meta(r).dedupe_key);') },
  M('shadow rows shown', `${GITLAB}/delivery-summary.ts`, 'return includeShadow ? deduped : deduped.filter((r) => !isShadow(r));', 'return deduped;'),
  M('queue rank swapped', `${GITLAB}/delivery-summary.ts`, "{ 'queue-updating': 0, 'queue-ready': 1,", "{ 'queue-updating': 1, 'queue-ready': 0,"),
  M('blocked gets a position', `${GITLAB}/delivery-summary.ts`, '(QUEUE_RANK[item.state_label] ?? 9) <= 2 ? ++pos : null', '(QUEUE_RANK[item.state_label] ?? 9) <= 3 ? ++pos : null'),
  M('waiting time from the last event', `${GITLAB}/delivery-summary.ts`, '    for (let i = list.length - 2; i >= 0 && s(meta(list[i]).queue_label) === label; i--) sinceRow = list[i];\n', ''),
  M('merged merge request stays queued', `${GITLAB}/delivery-summary.ts`, "    if (last.topic !== 'scm.gitlab.merge_request.opened' && last.topic !== 'scm.gitlab.merge_request.updated') continue; // merged or closed: off the queue\n", ''),
  M('red main looks backwards', `${GITLAB}/delivery-summary.ts`, 's(meta(r).repo) === s(lm.repo) && t(r) >= t(l)', 's(meta(r).repo) === s(lm.repo) && t(r) <= t(l)'),
  M('p95 rank rounds down', `${GITLAB}/delivery-summary.ts`, 'Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))', 'Math.min(v.length - 1, Math.max(0, Math.floor(p * v.length)))'),
  M('pass rate denominator', `${GITLAB}/delivery-summary.ts`, 'passed / verifyRows.length', 'passed / (verifyRows.length + 1)'),
  M('cost per day is 0', `${GITLAB}/delivery-summary.ts`, 'cost_per_day: null,\n  };', 'cost_per_day: 0 as never,\n  };'),
  M('landing to verify matches any verification', `${GITLAB}/delivery-summary.ts`, "Array.isArray(meta(r).vtids) && (meta(r).vtids as unknown[]).includes(v)) : undefined;", "Array.isArray(meta(r).vtids) && (meta(r).vtids as unknown[]).length > 0) : undefined;"),
  M('main green and red swapped', `${GITLAB}/delivery-summary.ts`, "      ? 'green'", "      ? 'red'"),
  M('every deploy is a GitHub deploy', `${GITLAB}/delivery-summary.ts`, "host: m.host === 'gitlab' ? 'gitlab' : 'github',", "host: 'github',"),
  M('time to restore ignores the red start', `${GITLAB}/delivery-summary.ts`, "if (r.topic === 'scm.gitlab.pipeline.failed' && !redSince.has(repo)) redSince.set(repo, t(r));", "if (r.topic === 'scm.gitlab.pipeline.failed') redSince.set(repo, t(r));"),

  // ---- the routes (routes/delivery.ts) ----
  M('summary without auth', `${SRC}/routes/delivery.ts`, "router.get('/summary', requireServiceOrAdmin, async", "router.get('/summary', async"),
  M('metrics without auth', `${SRC}/routes/delivery.ts`, "router.get('/metrics', requireServiceOrAdmin, async", "router.get('/metrics', async"),
  M('window cap raised', `${SRC}/routes/delivery.ts`, 'Math.min(MAX_WINDOW_HOURS, Math.max(1, h))', 'Math.min(MAX_WINDOW_HOURS * 2, Math.max(1, h))'),
  M('unreachable source answers 500', `${SRC}/routes/delivery.ts`, "res.status(502).json({ ok: false, error: 'delivery_source_unavailable' });", "res.status(500).json({ ok: false, error: 'delivery_source_unavailable' });"),
  M('shadow shown by default', `${SRC}/routes/delivery.ts`, 'const includeShadow = flag(req.query.include_shadow);', 'const includeShadow = true;'),
  M('hosts read from the process env', `${SRC}/routes/delivery.ts`, 'deliveryHostFor(repo, env)]', 'deliveryHostFor(repo)]'),
  M('another source named', `${SRC}/routes/delivery.ts`, "sources: ['vtid_ledger', 'oasis_events'],", "sources: ['vtid_ledger', 'oasis_events', 'github'],"),
  M('reader writes', `${SRC}/routes/delivery.ts`, 'fetch(`${url}/rest/v1/${path}`, { headers:', "fetch(`${url}/rest/v1/${path}`, { method: 'POST', headers:"),
  M('metrics include shadow rows', `${SRC}/routes/delivery.ts`, 'metrics: buildMetrics(prepareRows(raw, false), now, hours),', 'metrics: buildMetrics(prepareRows(raw, true), now, hours),'),
  M('missing credentials do not fail', `${SRC}/routes/delivery.ts`, "if (!url || !key) throw new Error('not_configured');", "if (!url || !key) return [] as unknown as T;"),
  M('read limit changed', `${SRC}/routes/delivery.ts`, 'export const EVENT_READ_LIMIT = 3000;', 'export const EVENT_READ_LIMIT = 5000;'),

  // ---- the mounts (index.ts) ----
  { id: 'stage mounted after the router', file: `${SRC}/index.ts`, apply: (t) => {
    const stage = /  app\.use\('\/api\/v1\/internal\/gitlab\/webhook', createGitlabDeliveryStage\(.*\)\);\n/.exec(t);
    if (!stage) return t;
    const router = "  mountRouterSync(app, '/api/v1/internal/gitlab', internalGitlabWebhookRouter, { owner: 'internal-gitlab-webhook' });\n";
    return t.replace(stage[0], '').replace(router, router + stage[0]);
  } },
  M('Delivery routes not mounted', `${SRC}/index.ts`, "  mountRouterSync(app, '/api/v1/delivery', deliveryRouter, { owner: 'delivery' });\n", ''),
  M('stage without the branch lookup', `${SRC}/index.ts`, 'createGitlabDeliveryStage({ map: { lookupBranchVtid: oasisBranchVtidLookup() } })', 'createGitlabDeliveryStage()'),
  M('Delivery route mounted at another path', `${SRC}/index.ts`, "mountRouterSync(app, '/api/v1/delivery', deliveryRouter,", "mountRouterSync(app, '/api/v1/deliveries', deliveryRouter,"),

  // ---- the topics (types/cicd.ts) ----
  M('pipeline.started topic missing', `${SRC}/types/cicd.ts`, "  | 'scm.gitlab.pipeline.started'\n", ''),
  M('delivery.merge.refused topic missing', `${SRC}/types/cicd.ts`, "  | 'delivery.merge.refused'\n", ''),
  M('rolled_back topic missing', `${SRC}/types/cicd.ts`, "  | 'staging.deploy.rolled_back';", ';'),

  // ---- the Delivery screen (delivery.js) ----
  M('http links clickable', `${HUB}/delivery.js`, "/^https:\\/\\//.test(url)", "/^https?:\\/\\//.test(url)"),
  M('link rel dropped', `${HUB}/delivery.js`, "        a.rel = 'noopener noreferrer';\n", ''),
  M('stale window shortened', `${HUB}/delivery.js`, 'var STALE_MS = 30000;', 'var STALE_MS = 3000;'),
  M('shadow query renamed', `${HUB}/delivery.js`, "'?include_shadow=1'", "'?shadow=1'"),
  M('failed pipeline drawn green', `${HUB}/delivery.js`, "failed: ['Failed', PILL.bad], canceled: ['Canceled', PILL.neutral]", "failed: ['Failed', PILL.ok], canceled: ['Canceled', PILL.neutral]"),
  M('column scope dropped', `${HUB}/delivery.js`, "            th.setAttribute('scope', 'col');\n", ''),
  M('table unnamed', `${HUB}/delivery.js`, "        t.setAttribute('aria-label', label);\n", ''),
  M('button type dropped', `${HUB}/delivery.js`, "        refresh.type = 'button';\n", ''),
  M('no retry on a re-render after an error', `${HUB}/delivery.js`, 'if (!st.data || st.error || nowMs() - st.loadedAt > STALE_MS) load();', 'if (!st.data || nowMs() - st.loadedAt > STALE_MS) load();'),
  M('pill replaced by a failing badge', `${HUB}/delivery.js`, "ok: 'tq-pill tq-pill-ok'", "ok: 'status-badge status-success'"),
  M('title tooltip dropped', `${HUB}/delivery.js`, "return t ? cell(t, CLIP, t) : '—';", "return t ? cell(t, CLIP) : '—';"),
  M('lane unclipped', `${HUB}/delivery.js`, 'cell(i.lane_key, MONO_CLIP, i.lane_key),', 'cell(i.lane_key, MONO),'),
  M('innerHTML introduced', `${HUB}/delivery.js`, 'while (box.firstChild) box.removeChild(box.firstChild);', "box.innerHTML = '';"),
  M('request without the auth headers', `${HUB}/delivery.js`, 'var headers = st.getHeaders ? st.getHeaders({}) : {};', 'var headers = {};'),
  M('unknown tab not the merge queue', `${HUB}/delivery.js`, "st.tab = TAB_TITLES[opts.tab] ? opts.tab : 'merge-queue';", "st.tab = opts.tab;"),
  M('queue positions hidden', `${HUB}/delivery.js`, "i.position === null || i.position === undefined ? '—' : i.position,", "'—',"),
  M('PUBLISH hint removed', `${HUB}/delivery.js`, "box.appendChild(note('Production stays the PUBLISH button in the header: it promotes the build that passed STAGING-VERIFY.'));", ''),
  M('error alert role dropped', `${HUB}/delivery.js`, "note('Could not load delivery data: ' + st.error, 'alert')", "note('Could not load delivery data: ' + st.error)"),

  // ---- the Command Hub shell (app.js, index.html, navigation-config.js, the inventory) ----
  M('Delivery tab not dispatched', `${HUB}/app.js`, "    if (moduleKey === 'delivery') {", '    if (false) {'),
  M('Delivery script path wrong', `${HUB}/app.js`, "script.src = '/command-hub/delivery.js?v=20261105-vtid-05547';", "script.src = '/command-hub/delivery2.js?v=20261105-vtid-05547';"),
  M('Delivery loader adds a script per view', `${HUB}/app.js`, '        if (deliveryModule.loading) return deliveryModule.loading;\n', ''),
  M('Delivery loader ignores a loaded screen', `${HUB}/app.js`, '        if (window.DeliveryScreen) return Promise.resolve(window.DeliveryScreen);\n', ''),
  M('Delivery load failure is cached', `${HUB}/app.js`, '                deliveryModule.loading = null;\n                reject(', '                reject('),
  M('Delivery load failure is not an alert', `${HUB}/app.js`, "            status.setAttribute('role', 'alert');\n", ''),
  M('Delivery screen gets no auth headers', `${HUB}/app.js`, 'screen.render({ tab: tab, headers: buildContextHeaders })', 'screen.render({ tab: tab })'),
  M('Delivery glue back to top-level functions', `${HUB}/app.js`, '\nvar deliveryModule = {\n    loading: null,', '\nfunction renderDeliveryView() {}\nvar deliveryModule = {\n    loading: null,'),
  M('Delivery section label missing', `${HUB}/app.js`, "    'delivery': 'Delivery',\n", ''),
  M('merge-queue tab key renamed', `${HUB}/app.js`, '{ "key": "merge-queue", "path": "/command-hub/delivery/merge-queue/" }', '{ "key": "merge_queue", "path": "/command-hub/delivery/merge-queue/" }'),
  M('Delivery loaded from an inline-capable tag', `${HUB}/index.html`, '  <script src="/command-hub/app.js?v=20261121-vtid-05082-vtid-05547"></script>', '  <script>window.__delivery = 1;</script>\n  <script src="/command-hub/app.js?v=20261121-vtid-05082-vtid-05547"></script>'),
  M('app.js version not bumped', `${HUB}/index.html`, 'app.js?v=20261121-vtid-05082-vtid-05547', 'app.js?v=20261121-vtid-05082'),
  M('styles.css version not bumped', `${HUB}/index.html`, 'styles.css?v=20261121-vtid-05082-vtid-05547', 'styles.css?v=20261121-vtid-05082'),
  M('delivery.js added to index.html', `${HUB}/index.html`, '  <script src="/command-hub/app.js?v=', '  <script src="/command-hub/delivery.js?v=1"></script>\n  <script src="/command-hub/app.js?v='),
  { id: 'Delivery removed from navigation-config.js', file: `${HUB}/navigation-config.js`, apply: (t) => t.replace(/  \{\n    module: "delivery",[\s\S]*?\n  \},\n/, '') },
  M('inventory screen id renamed', 'services/gateway/specs/dev-screen-inventory-v1.json', '"screen_id": "DEV-PIPELINE_RUNS"', '"screen_id": "DEV-PIPELINES"'),
  M('inventory module list missing delivery', 'services/gateway/specs/dev-screen-inventory-v1.json', '    "delivery": [\n      "merge-queue",', '    "deliveryx": [\n      "merge-queue",'),
];

// ---------------------------------------------------------------------------------------------------------------------------

const COPY = ['services/gateway/src', 'services/gateway/scripts', 'services/gateway/specs', 'services/gateway/package.json', 'services/gateway/jest.config.js', 'services/gateway/tsconfig.json', 'services/gateway/test/__mocks__', 'services/gateway/test/delivery', 'services/gateway/test/command-hub/fixtures', 'config'];

function makeTree(i) {
  const dir = path.join(ROOT, `w${i}`);
  for (const rel of COPY) {
    if (!fs.existsSync(path.join(WT, rel))) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.cpSync(path.join(WT, rel), path.join(dir, rel), { recursive: true });
  }
  fs.symlinkSync(path.join(GW, 'node_modules'), path.join(dir, 'services/gateway/node_modules'));
  return dir;
}

function jest(dir, tag) {
  return new Promise((resolve) => {
    const out = path.join(dir, `out-${tag}.json`);
    const p = spawn('npx', ['jest', 'test/delivery', '--silent', '--json', `--outputFile=${out}`, '--maxWorkers=3'], {
      cwd: path.join(dir, 'services/gateway'),
      env: { ...process.env, TMPDIR: JEST_TMP, CI: '1' },
      stdio: 'ignore',
    });
    p.on('close', () => {
      try {
        const r = JSON.parse(fs.readFileSync(out, 'utf8'));
        const failed = r.testResults.flatMap((s) => s.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName));
        const crashed = r.testResults.filter((s) => s.status === 'failed' && s.assertionResults.length === 0).map((s) => path.basename(s.name));
        resolve({ total: r.numTotalTests, passed: r.numPassedTests, failed, crashed });
      } catch (e) {
        resolve({ total: 0, passed: 0, failed: [], crashed: ['no result'] });
      }
    });
  });
}

const jobs = MUTATIONS.filter((m) => !ONLY || ONLY.test(m.id));
const results = new Array(jobs.length);

async function worker(i, queue) {
  const dir = makeTree(i);
  if (i === 0) {
    const base = await jest(dir, 'base');
    if (base.failed.length || base.crashed.length || base.total === 0) {
      console.log(`baseline: the suites fail on the unmutated tree (${base.failed.length} failed, ${base.crashed.join(',')})`);
      console.log(base.failed.slice(0, 5).join('\n'));
      process.exit(2);
    }
    console.log(`baseline: ${base.total} cases, ${base.passed} pass on the unmutated tree`);
  }
  for (;;) {
    const k = queue.next();
    if (k === undefined) return;
    const m = jobs[k];
    const target = path.join(dir, m.file);
    const original = fs.readFileSync(path.join(WT, m.file), 'utf8');
    let mutated;
    if (m.apply) mutated = m.apply(original);
    else {
      const n = original.split(m.find).length - 1;
      mutated = n === 1 ? original.replace(m.find, () => m.replace) : original;
    }
    if (mutated === original) { results[k] = { m, cls: 'NOOP' }; continue; }
    fs.writeFileSync(target, mutated);
    const r = await jest(dir, `m${k}`);
    fs.writeFileSync(target, original);
    results[k] = { m, cls: r.failed.length ? 'caught' : r.crashed.length ? 'CRASH' : 'SURVIVED', r };
  }
}

const baselineGate = (async () => {
  // Worker 0 runs the baseline first; the others start at once but the run is only trusted if the baseline passes.
  const it = { n: 0, next() { return this.n < jobs.length ? this.n++ : undefined; } };
  await Promise.all(Array.from({ length: Math.min(WORKERS, jobs.length) }, (_v, i) => worker(i, it)));
})();

await baselineGate;
let bad = 0;
for (const { m, cls, r } of results) {
  if (cls === 'caught') console.log(`caught      ${m.id}  <- ${r.failed[0].replace(/^VTID-05547 /, '').slice(0, 118)}${r.failed.length > 1 ? `  [+${r.failed.length - 1}]` : ''}`);
  else { bad++; console.log(`${cls.padEnd(11)} ${m.id}${cls === 'CRASH' ? `  (${r.crashed.join(',')})` : ''}`); }
}
console.log(`\n${results.length - bad}/${results.length} mutations caught, ${bad} not caught`);
fs.rmSync(ROOT, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
