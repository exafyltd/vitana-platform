#!/usr/bin/env bash
# Mutation check for scripts/eng/gitlab-settings.test.mjs (VTID-05542, lane eng-gitlab-m2/settings, part A).
# One plan value or property of the sync is broken at a time in a scratch copy, and the test must go red. A mutation counts as caught only when
#   - the mutated file still parses as what it is (node --check, a JSON parser), and
#   - the test fails on a named case (a crash before any case runs is CRASH, not a catch).
# A mutation that changes nothing (NOOP), breaks the syntax by accident (INVALID) or leaves the test green (SURVIVED) is reported as not caught:
# it proves nothing, or it shows a property the test does not pin.
#
# usage: a-mutate-settings.sh <worktree containing scripts/eng and infra/gitlab-engineering/settings>
# env:   NODE    node binary (default: node)      TMPDIR  where the scratch copies go (default /tmp)      ONLY  regex on the mutation name: run a subset
set -u
SRC="${1:?worktree}"
NODE="${NODE:-node}"
TEST=scripts/eng/gitlab-settings.test.mjs
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mutsettings-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
total=0; bad=0
FILES="scripts/eng/gitlab-settings.mjs scripts/eng/gitlab-settings.test.mjs scripts/eng/gitlab-api.mjs scripts/eng/testing/fake-fetch.mjs infra/gitlab-engineering/settings/gitlab-settings.json infra/gitlab-engineering/settings/README.md"

parses() {   # file -> exit 0 when the file still parses as its extension says
  case "$1" in
    *.mjs)  "$NODE" --check "$1" 2>/dev/null ;;
    *.json) "$NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1" 2>/dev/null ;;
    *)      return 0 ;;
  esac
}
fresh() {
  rm -rf "$WORK/t"; mkdir -p "$WORK/t/scripts/eng/testing" "$WORK/t/infra/gitlab-engineering/settings"
  for f in $FILES; do cp "$SRC/$f" "$WORK/t/$f"; done
}

# The unmutated tree must pass, or every "caught" below would be meaningless.
fresh
base="$(cd "$WORK/t" && "$NODE" --test "$TEST" 2>&1)"
if ! grep -q '^# fail 0' <<<"$base"; then echo "baseline: the test fails on the unmutated tree"; grep -E '^not ok' <<<"$base" | head; exit 2; fi
echo "baseline: $(grep -E '^# tests ' <<<"$base" | cut -c3-) and $(grep -E '^# pass ' <<<"$base" | cut -c3-) on the unmutated tree"

run_mut() {   # name, file (relative to the worktree), perl expression
  local name="$1" file="$2" expr="$3"
  if [ -n "${ONLY:-}" ] && ! [[ "$name" =~ $ONLY ]]; then return; fi
  fresh
  local f="$WORK/t/$file" before after
  before="$(sha256sum "$f" | cut -c1-16)"
  perl -0pi -e "$expr" "$f"
  after="$(sha256sum "$f" | cut -c1-16)"
  total=$((total + 1))
  if [ "$before" = "$after" ]; then echo "NOOP        $name (the mutation changed nothing: fix the mutation)"; bad=$((bad + 1)); return; fi
  if ! parses "$f"; then echo "INVALID     $name (the mutated file does not parse: it proves nothing)"; bad=$((bad + 1)); return; fi
  local out rc ntests failed
  out="$(cd "$WORK/t" && timeout 120 "$NODE" --test "$TEST" 2>&1)"; rc=$?
  ntests="$(grep -E '^# tests ' <<<"$out" | awk '{print $3}')"
  failed="$(grep -E '^not ok' <<<"$out" | sed -E 's/^not ok [0-9]+ - //' | cut -c1-58 | head -2 | paste -sd'|' -)"
  if [ "$rc" = 124 ]; then echo "HUNG        $name"; bad=$((bad + 1))
  elif [ "$rc" = 0 ] && grep -q '^# fail 0' <<<"$out"; then echo "SURVIVED    $name"; bad=$((bad + 1))
  elif [ "${ntests:-0}" -le 1 ]; then echo "CRASH       $name (the test file crashed before running a case: $failed)"; bad=$((bad + 1))
  else echo "caught      $name  <- $failed"; fi
}
# exact-string mutation, no regex escaping: name, file, old text, new text (the first occurrence is replaced)
run_str() { OLD="$3" NEW="$4" run_mut "$1" "$2" 's/\Q$ENV{OLD}\E/$ENV{NEW}/'; }

S=scripts/eng/gitlab-settings.mjs; J=infra/gitlab-engineering/settings/gitlab-settings.json; R=infra/gitlab-engineering/settings/README.md

# ---- plan values: thresholds and lifetimes
run_str "admin token rotated below 1 day"           $S 'ADMIN_ROTATE_BELOW_DAYS = 10' 'ADMIN_ROTATE_BELOW_DAYS = 1'
run_str "admin token rotated below 30 days"         $S 'ADMIN_ROTATE_BELOW_DAYS = 10' 'ADMIN_ROTATE_BELOW_DAYS = 30'
run_str "cap warning from 90"                       $S 'SERVICE_ACCOUNT_WARN_AT = 80' 'SERVICE_ACCOUNT_WARN_AT = 90'
run_str "cap warning needs more than 80"            $S 'if (used >= SERVICE_ACCOUNT_WARN_AT)' 'if (used > SERVICE_ACCOUNT_WARN_AT)'
run_str "token rotated at 30 days left too"         $S 'if (left < rotateBelowDays)' 'if (left <= rotateBelowDays)'
run_str "token lifetime check off by one"           $S 'daysLeft(t.expires_at, nowMs) > lifetimeDays' 'daysLeft(t.expires_at, nowMs) >= lifetimeDays'
run_str "token lifetime limit raised to 365"        $S 'life > 90)' 'life > 365)'
run_str "new tokens live 365 days"                  $S 'const expires = plusDays(ctx.nowMs, ctx.config.tokens.lifetime_days);' 'const expires = plusDays(ctx.nowMs, 365);'
run_str "admin token rotated for 7 days"            $S "send(ctx, 'POST', \`/personal_access_tokens/\${meta.id}/rotate\`, { expires_at: plusDays(ctx.nowMs, ctx.config.tokens.lifetime_days) })" "send(ctx, 'POST', \`/personal_access_tokens/\${meta.id}/rotate\`, { expires_at: plusDays(ctx.nowMs, 7) })"
# ---- plan values: roles and levels
run_str "Developer becomes Maintainer"              $S 'reporter: 20, developer: 30, maintainer: 40 }' 'reporter: 20, developer: 40, maintainer: 40 }'
run_str "Reporter becomes Guest"                    $S 'reporter: 20, developer: 30' 'reporter: 10, developer: 30'
run_str "ci-config readers become Developers"       $S 'CI_READER_LEVEL = 20' 'CI_READER_LEVEL = 30'
run_str "Developers no longer read ci-config"       $S "if (a.role !== 'reporter') desired.set(a.username, CI_READER_LEVEL)" "if (a.role === 'maintainer') desired.set(a.username, CI_READER_LEVEL)"
run_str "default scopes of a Developer"             $S "developer: ['api', 'write_repository']" "developer: ['api']"
run_str "default scopes of a Reporter"              $S "reporter: ['read_api']" "reporter: ['api']"
# ---- profiles
run_str "native: push open to Maintainers"          $S 'protect: Object.freeze({ push: 0, merge: 40, forcePush: false })' 'protect: Object.freeze({ push: 40, merge: 40, forcePush: false })'
run_str "native: merge open to Developers"          $S 'protect: Object.freeze({ push: 0, merge: 40, forcePush: false })' 'protect: Object.freeze({ push: 0, merge: 30, forcePush: false })'
run_str "native: force push allowed"                $S 'protect: Object.freeze({ push: 0, merge: 40, forcePush: false })' 'protect: Object.freeze({ push: 0, merge: 40, forcePush: true })'
run_str "mirror: force push off"                    $S 'protect: Object.freeze({ push: 40, merge: 40, forcePush: true })' 'protect: Object.freeze({ push: 40, merge: 40, forcePush: false })'
run_str "mirror: push to No one"                    $S 'protect: Object.freeze({ push: 40, merge: 40, forcePush: true })' 'protect: Object.freeze({ push: 0, merge: 40, forcePush: true })'
run_str "native: merge method merge"                $S "merge_method: 'ff'" "merge_method: 'merge'"
run_str "native: squash only encouraged"            $S "squash_option: 'always'" "squash_option: 'default_on'"
run_str "native: pipelines not required"            $S 'only_allow_merge_if_pipeline_succeeds: true' 'only_allow_merge_if_pipeline_succeeds: false'
run_str "native: discussions not required"          $S 'only_allow_merge_if_all_discussions_are_resolved: true' 'only_allow_merge_if_all_discussions_are_resolved: false'
run_str "native: source branch kept"                $S 'remove_source_branch_after_merge: true' 'remove_source_branch_after_merge: false'
run_str "native: automatic rebase on"               $S 'automatic_rebase_enabled: false' 'automatic_rebase_enabled: true'
run_str "native: squash template changed"          $S "squash_commit_template: '%{title}'" "squash_commit_template: '%{description}'"
run_str "native: merge template changed"           $S "merge_commit_template: '%{title}'" "merge_commit_template: '%{description}'"
# ---- names and secrets of plan 3
run_str "token name changed"                        $S "TOKEN_NAME = 'vitana-settings'" "TOKEN_NAME = 'sync'"
run_str "webhook name changed"                      $S "WEBHOOK_NAME = 'vitana-gateway'" "WEBHOOK_NAME = 'gateway'"
run_str "fleet secret renamed"                      $S "fleet: 'vitana/engineering/gitlab/fleet-runner-token'" "fleet: 'vitana/engineering/gitlab/fleet-token'"
run_str "webhook secret renamed"                    $S "webhook: 'vitana/engineering/gitlab/webhook-signing-token'" "webhook: 'vitana/engineering/gitlab/hook-token'"
run_str "agent secret path renamed"                 $S 'vitana/engineering/gitlab/agents/${username}' 'vitana/engineering/gitlab/agent/${username}'
run_str "central CI branch changed"                 $S "MAIN_BRANCH = 'main'" "MAIN_BRANCH = 'master'"
# ---- order and dependencies
run_str "tokens before the memberships"             $S $'  planMembers(ctx, S, plan);\n  planFleetRunner(ctx, S, plan);\n  planTokens(ctx, S, plan);' $'  planTokens(ctx, S, plan);\n  planMembers(ctx, S, plan);\n  planFleetRunner(ctx, S, plan);'
run_str "tokens before the projects"                $S $'  planProjects(ctx, S, plan);\n  planMembers(ctx, S, plan);\n  planFleetRunner(ctx, S, plan);\n  planTokens(ctx, S, plan);' $'  planTokens(ctx, S, plan);\n  planProjects(ctx, S, plan);\n  planMembers(ctx, S, plan);\n  planFleetRunner(ctx, S, plan);'
run_str "legacy retag after the accounts"           $S $'  planLegacyRunner(ctx, S, plan);\n  planAccounts(ctx, S, plan);' $'  planAccounts(ctx, S, plan);\n  planLegacyRunner(ctx, S, plan);'
run_str "tokens do not wait for the legacy retag"   $S "...(plan.has('runner:legacy:update') ? ['runner:legacy:update'] : [])," '...[],'
run_str "tokens do not wait for the protections"    $S '      ...protections,' '      ...[],'
run_str "tokens do not wait for the memberships"    $S "...plan.changes.filter((c) => c.id.startsWith('member:') && c.id.endsWith(\`:\${a.username}\`)).map((c) => c.id)," '...[],'
run_str "memberships do not wait for the account"   $S "const requires = [...(P.exists ? [] : [\`project:\${name}:create\`]), ...(plan.has(\`account:\${u}\`) ? [\`account:\${u}\`] : [])];" "const requires = [...(P.exists ? [] : [\`project:\${name}:create\`])];"
# ---- writes are never retried
run_str "writes may be retried (send)"              $S 'ctx.client.request(method, p, { body, retries: 0 })' 'ctx.client.request(method, p, { body })'
run_str "token revocation may be retried"           $S "await ctx.client.raw('DELETE', \`/personal_access_tokens/\${r.id}\`, { okStatuses: [404], retries: 0 });" "await ctx.client.raw('DELETE', \`/personal_access_tokens/\${r.id}\`, { okStatuses: [404] });"
run_str "member removal may be retried"             $S "{ okStatuses: [404], retries: 0 }) });
    }
  }
  const allowedMaintainers" "{ okStatuses: [404] }) });
    }
  }
  const allowedMaintainers"
# ---- licence guard, unreachable GitLab, failures
run_str "licence never found"                       $S 'result.licence = lic.status !== 404 && hasLicence(lic.data);' 'result.licence = false;'
run_str "an empty licence list is a licence"        $S 'Array.isArray(d) ? d.length > 0' 'Array.isArray(d) ? d.length >= 0'
run_str "one server error ends the run"            $S 'infraInARow >= 3' 'infraInARow >= 1'
run_str "server errors never end the run"          $S 'infraInARow >= 3' 'infraInARow >= 3000'
run_str "a network error does not end the run"     $S "if (e.code === 'network' || e.code === 'timeout' || infraInARow >= 3)" 'if (infraInARow >= 3)'
run_str "failures do not change the exit code"     $S 'result.exitCode = done.failed.length > 0 || done.aborted ? 1 : 0;' 'result.exitCode = 0;'
run_str "a skipped change does not hold others"    $S 'const blockers = ch.requires.filter((id) => held.has(id));' 'const blockers = [];'
run_str "check ignores findings that need a person" $S 'result.exitCode = driftCount > 0 ? 3 : 0;' 'result.exitCode = plan.changes.length > 0 ? 3 : 0;'
run_str "check exits 1 on drift"                   $S 'result.exitCode = driftCount > 0 ? 3 : 0;' 'result.exitCode = driftCount > 0 ? 1 : 0;'
run_str "dry-run writes"                           $S 'if (opts.dryRun === true) {' 'if (opts.dryRun === "never") {'
run_str "reads fail but the run goes on"           $S "return stop(1, \`GitLab, Secrets Manager or the files could not be read, so nothing was written: \${error}\${hint}\`);" 'void hint;'
run_str "no hint for a rejected admin token"        $S "e.status === 401 ? ' (GitLab does not accept the admin token; if it was lost or has expired, m2.sh install mints a new one)' : ''" "false ? '' : ''"
# ---- the admin token
run_str "admin token rotated without a preflight"   $S 'try { await ctx.deps.fs.preflight(file); } catch (e) {' 'try { await 0; } catch (e) {'
run_str "admin token file written 0644"            $S "await ctx.deps.fs.writeAtomic(file, \`\${token}\\n\`, { mode: 0o600 }); } catch (e) {" "await ctx.deps.fs.writeAtomic(file, \`\${token}\\n\`, { mode: 0o644 }); } catch (e) {"
run_str "the new admin token is not used"          $S '  ctx.useToken(token);
  const me = await' '  const me = await'
run_str "no re-read before the admin rotation"     $S "if (!cur || cur.active !== true) throw new Error('the admin token is no longer active; not rotating it');" 'void cur;'
run_str "no re-read before a token rotation"       $S "if (!cur || cur.active !== true) throw new Error(\`the token \${t.primary.id}" "if (false) throw new Error(\`the token \${t.primary.id}"
# ---- tokens and secrets
run_str "bot token file written 0644"              $S "if (acc.token_file) await ctx.deps.fs.writeAtomic(acc.token_file, \`\${value}\\n\`, { mode: 0o600 });" "if (acc.token_file) await ctx.deps.fs.writeAtomic(acc.token_file, \`\${value}\\n\`, { mode: 0o644 });"
run_str "secret passed as an argument"             $S "'--secret-id', id, '--secret-string', 'file:///dev/stdin', '--region', region], { input: value }" "'--secret-id', id, '--secret-string', value, '--region', region], { input: value }"
run_str "redactor forgets the secrets it saw"      $S "for (const v of secrets) s = s.split(v).join('[redacted]');" ''
run_str "a lost secret is not recovered"           $S "if (secret?.id !== primary.id) return { action: 'rotate'" "if (false) return { action: 'rotate'"
run_str "scope changes are ignored"                $S "if (!sameSet(primary.scopes ?? [], want)) return { action: 'replace'" "if (false) return { action: 'replace'"
run_str "the old token is revoked before the new one is stored" $S "    await ctx.secrets.put(SECRETS.agent(acc.username), value);
    if (acc.token_file) await ctx.deps.fs.writeAtomic(acc.token_file, \`\${value}\\n\`, { mode: 0o600 });
    if (t.action === 'replace') await ctx.client.raw('DELETE', \`/personal_access_tokens/\${t.primary.id}\`, { okStatuses: [404], retries: 0 });" "    if (t.action === 'replace') await ctx.client.raw('DELETE', \`/personal_access_tokens/\${t.primary.id}\`, { okStatuses: [404], retries: 0 });
    await ctx.secrets.put(SECRETS.agent(acc.username), value);
    if (acc.token_file) await ctx.deps.fs.writeAtomic(acc.token_file, \`\${value}\\n\`, { mode: 0o600 });"
run_str "stray tokens are never revoked"           $S "const revoke = active.filter((t) => t.name !== TOKEN_NAME && tooLong(t))" "const revoke = active.filter((t) => false && tooLong(t))"
run_str "a second managed token is kept"           $S "for (const t of managed) if (t !== primary) revoke.push" "for (const t of []) if (t !== primary) revoke.push"
run_str "the token file is never repaired"         $S "if (a.token_file && (!T.file || T.file.text.trim() !== T.secret || T.file.mode !== 0o600)) {" "if (false) {"
run_str "the token file mode is not compared"      $S "|| T.file.mode !== 0o600)) {" ')) {'
# ---- projects, membership, runners, webhook, central CI
run_str "protection is not removed before re-creating" $S "  await send(ctx, 'DELETE', \`\${base}/\${MAIN_BRANCH}\`);
  try {" '  try {'
run_str "force push uses DELETE and POST"          $S "if (cur.allow_force_push !== want.forcePush) await send(ctx, 'PATCH'" "if (false) await send(ctx, 'PATCH'"
run_str "a failed re-creation is not retried"      $S "    ctx.log({ event: 'protection_retry'" "    throw first; ctx.log({ event: 'protection_retry'"
run_str "the audit of native projects is off"      $S "if (m.access_level >= ROLES.maintainer && !allowedMaintainers.has(m.username)) {" 'if (false) {'
run_str "mirror projects are audited too"          $S "if (p.profile !== 'native') continue;" ''
run_str "the audit ignores Maintainers at 40"      $S "if (m.access_level >= ROLES.maintainer && !allowedMaintainers" "if (m.access_level > ROLES.maintainer && !allowedMaintainers"
run_str "unmanaged members are removed"            $S "if (!managed.has(u) || desired.has(u)) continue;" "if (desired.has(u)) continue;"
run_str "owners are not made Maintainer"           $S "if ((effective.get(o) ?? 0) >= ROLES.maintainer) continue;" 'continue;'
run_str "legacy runner keeps untagged jobs"        $S "if (d.run_untagged !== false) body.run_untagged = false;" ''
run_str "legacy runner is never paused"            $S "if (Boolean(d.paused) !== L.paused) body.paused = L.paused;" ''
run_str "legacy runner keeps the fleet tag"        $S "if (!sameSet(d.tag_list ?? [], L.tags)) body.tag_list = L.tags.join(',');" ''
run_str "fleet runner takes untagged jobs"         $S "const want = { tag_list: F.tags.join(','), run_untagged: false," "const want = { tag_list: F.tags.join(','), run_untagged: true,"
run_str "fleet runner is protected-only"           $S "locked: false, access_level: 'not_protected', paused: false };" "locked: false, access_level: 'ref_protected', paused: false };"
run_str "any fleet secret value is accepted"       $S 'const GLRT = /^glrt-[A-Za-z0-9_.-]{8,}$/;' 'const GLRT = /^.*$/;'
run_str "fleet token never reset"                  $S "if (!S.fleetSecret || !GLRT.test(S.fleetSecret)) {" 'if (false) {'
run_str "webhook has no fingerprint of the token"  $S 'signing token fingerprint ${sha12(signing)}' 'signing token'
run_str "webhook keeps push events"                $S 'Object.fromEntries(HOOK_FLAGS.map((f) => [f, false]))' "Object.fromEntries(HOOK_FLAGS.map((f) => [f, f === 'push_events']))"
run_str "webhook without ssl verification"         $S 'description: `Managed by gitlab-settings; signing token fingerprint ${sha12(signing)}`, enable_ssl_verification: true' 'description: `Managed by gitlab-settings; signing token fingerprint ${sha12(signing)}`, enable_ssl_verification: false'
run_str "any signing token is accepted"            $S 'const SIGNING_OK = /^whsec_[A-Za-z0-9+/]{43}=$/;' 'const SIGNING_OK = /^.*$/;'
run_str "our webhook is not removed"               $S '    } else if (mine) {' '    } else if (false) {'
run_str "central CI files are never updated"       $S "else if (remote !== text) actions.push" "else if (false) actions.push"
run_str "central CI files are always written"      $S "else if (remote !== text) actions.push" "else if (true) actions.push"
run_str "domain mismatch is not reported"          $S "if (domain && host && domain !== host)" 'if (false)'
run_str "a licence read error is not an error"     $S "const lic = await ctx.client.raw('GET', '/license', { okStatuses: [404] });" "const lic = await ctx.client.raw('GET', '/license', { okStatuses: [403, 404] });"
# ---- the machine
run_str "file writer keeps the temp file"          $S 'await fs.promises.rename(tmp, p);' 'await fs.promises.copyFile(tmp, p);'
run_str "file writer ignores the mode"             $S "fh = await fs.promises.open(tmp, 'wx', mode);
        await fh.chmod(mode); // the umask can only remove bits: make the mode exact before any content is written" "fh = await fs.promises.open(tmp, 'wx', 0o644);"
run_str "directory listing includes symlinks"      $S 'entries.filter((e) => e.isFile() && e.name.endsWith' 'entries.filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith'
run_str "aws stdin is not written"                 $S 'child.stdin.end(input ?? '"''"');' 'child.stdin.end();'
# ---- validation
run_str "overlapping runner tags accepted"         $S 'if (legacy.tags.some((t) => fleet.tags.includes(t)))' 'if (false)'
run_str "landing on a mirror project accepted"     $S "if (out.landing && out.profile !== 'native')" 'if (false)'
run_str "rehearsal webhook accepted"               $S "if (out.rehearsal) bad(wwhere" "if (false) bad(wwhere"
run_str "token files anywhere"                     $S 'const TOKEN_FILE_OK = /^\/etc\/vitana\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;' 'const TOKEN_FILE_OK = /^\/.*$/;'
run_str "sudo scope accepted"                      $S "export const SCOPES = Object.freeze(['api', 'read_api', 'read_repository', 'write_repository']);" "export const SCOPES = Object.freeze(['api', 'read_api', 'read_repository', 'write_repository', 'sudo']);"
run_str "duplicate usernames accepted"             $S 'if (seen.has(username))' 'if (false)'
run_str "unknown keys accepted"                    $S 'for (const k of Object.keys(o)) if (!allowed.includes(k))' 'for (const k of []) if (!allowed.includes(k))'
run_str "schema version not checked"               $S 'if (raw.schema_version !== SCHEMA_VERSION)' 'if (false)'
# ---- the shipped file and its README
run_str "file: token lifetime 365"                 $J '"lifetime_days": 90' '"lifetime_days": 365'
run_str "file: rotation below 60"                  $J '"rotate_below_days": 30' '"rotate_below_days": 60'
run_str "file: legacy runner keeps the fleet tag"  $J '"tags": ["vitana-legacy"]' '"tags": ["vitana-eng"]'
run_str "file: fleet tag changed"                  $J '"tags": ["vitana-eng"]' '"tags": ["vitana-fleet"]'
run_str "file: rehearsal is mirror"                $J '"profile": "native"' '"profile": "mirror"'
run_str "file: rehearsal not landing"              $J '"landing": true' '"landing": false'
run_str "file: required job removed"               $J '"required_jobs": ["unit"]' '"required_jobs": []'
run_str "file: bot-land is Developer"              $J '"role": "maintainer"' '"role": "developer"'
run_str "file: bot-metrics may write"              $J '"scopes": ["read_api"]' '"scopes": ["api"]'
run_str "file: bot-land token file moved"          $J '"/etc/vitana/bot-land-token"' '"/etc/vitana/land-token"'
run_str "file: bot-metrics token file moved"       $J '"/etc/vitana/bot-metrics-token"' '"/etc/vitana/metrics-token"'
run_str "file: a seat on a mirror project"         $J '"projects": ["rehearsal"],
      "scopes": ["api", "write_repository"]
    },
    {
      "username": "agent-kiro-exafyltd"' '"projects": ["rehearsal", "vitana-v1"],
      "scopes": ["api", "write_repository"]
    },
    {
      "username": "agent-kiro-exafyltd"'
run_str "file: reviewer account renamed"           $J '"username": "agent-reviewer"' '"username": "reviewer"'
run_str "file: owners changed"                     $J '"owners": ["root"]' '"owners": ["admin"]'
run_str "file: legacy runner paused at the start"  $J '"paused": false' '"paused": true'
run_str "README forgets a key"                     $R '`rotate_below_days`' 'rotate_below_days'
run_str "README forgets the exit code"             $R 'exit 3 drift' 'drift'

echo "mutations: $total, not caught: $bad"
[ "$bad" = 0 ]
