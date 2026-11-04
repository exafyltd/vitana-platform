#!/usr/bin/env bash
# Mutation check for scripts/eng/gitlab-api.test.mjs and fake-fetch.test.mjs: break one behaviour of gitlab-api.mjs (or the
# fake) at a time in a scratch copy and require the tests to go red (or hang, which a timeout turns into red).
# usage: mutate-gitlab-client.sh <worktree containing scripts/eng>
set -u
SRC="${1:?worktree}"
WORK="$(mktemp -d /projects/sandbox/tools/mutc-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
survivors=0; total=0

run_mut() {   # name, file (relative to scripts/eng), perl expression
  local name="$1" file="$2" expr="$3"
  rm -rf "$WORK/t"; mkdir -p "$WORK/t"; cp -r "$SRC/scripts" "$WORK/t/"
  local f="$WORK/t/scripts/eng/$file" before after
  before="$(sha256sum "$f" | cut -c1-16)"
  perl -0pi -e "$expr" "$f"
  after="$(sha256sum "$f" | cut -c1-16)"
  total=$((total + 1))
  if [ "$before" = "$after" ]; then echo "NOOP     $name"; survivors=$((survivors + 1)); return; fi
  local out rc failed
  out="$(cd "$WORK/t" && timeout 90 node --test scripts/eng/gitlab-api.test.mjs scripts/eng/testing/fake-fetch.test.mjs 2>&1)"; rc=$?
  failed="$(grep -E '^not ok' <<<"$out" | sed -E 's/^not ok [0-9]+ - //' | cut -c1-60 | head -3 | paste -sd'|' -)"
  if [ "$rc" = 124 ]; then echo "caught   $name  <- (hung, timed out)"
  elif grep -q '^# fail 0' <<<"$out" && [ "$rc" = 0 ]; then echo "SURVIVED $name"; survivors=$((survivors + 1))
  else echo "caught   $name  <- $failed"; fi
}

G=gitlab-api.mjs; F=testing/fake-fetch.mjs
run_mut "token in Authorization header"        $G "s/headers\['private-token'\] = secret;/headers['authorization'] = 'Bearer ' + secret;/"
run_mut "token also in the URL"                $G 's/const url = `\$\{apiRoot\}\$\{path\}\$\{qs \? `\?\$\{qs\}` : ..\}`;/const url = `\${apiRoot}\${path}?private_token=\${encodeURIComponent(secret)}\${qs ? "\&" + qs : ""}`;/'
run_mut "redirects followed"                   $G "s/redirect: 'manual'/redirect: 'follow'/"
run_mut "3xx accepted as success"              $G 's/\(status >= 200 && status < 300\) \|\| okStatuses/(status >= 200 \&\& status < 400) || okStatuses/'
run_mut "all 4xx retried"                      $G 's/const serverSide = status >= 500 && status !== 501;/const serverSide = status >= 400 \&\& status !== 501;/'
run_mut "404 retried"                          $G 's/const rateLimited = status === 429;/const rateLimited = status === 429 || status === 404;/'
run_mut "POST retried on 5xx"                  $G 's/const IDEMPOTENT = new Set\(\[.GET., .HEAD., .PUT., .DELETE.\]\);/const IDEMPOTENT = new Set(["GET","HEAD","PUT","DELETE","POST","PATCH"]);/'
run_mut "PUT not treated as idempotent"        $G 's/new Set\(\[.GET., .HEAD., .PUT., .DELETE.\]\)/new Set(["GET","HEAD","DELETE"])/'
run_mut "429 not retried for writes"           $G 's/if \(attempt <= retries && \(rateLimited \|\| \(serverSide/if (attempt <= retries \&\& ((rateLimited \&\& IDEMPOTENT.has(method)) || (serverSide/'
run_mut "retries never stop"                   $G 's/if \(attempt <= retries && \(rateLimited/if (true \&\& (rateLimited/'
run_mut "retry cap off by one"                 $G 's/if \(attempt <= retries && \(rateLimited/if (attempt < retries \&\& (rateLimited/'
run_mut "Retry-After ignored"                  $G 's/const delayMs = retryAfter === undefined \? backoff\(attempt\) : Math.min\(maxDelayMs, retryAfter\);/const delayMs = backoff(attempt);/'
run_mut "Retry-After not capped"               $G 's/Math.min\(maxDelayMs, retryAfter\)/retryAfter/'
run_mut "Retry-After date ignored"             $G 's/const when = Date.parse\(v\);/const when = NaN;/'
run_mut "back-off constant"                    $G 's/baseDelayMs \* 2 \*\* \(attempt - 1\)/baseDelayMs/'
run_mut "back-off not capped"                  $G 's/Math.min\(maxDelayMs, baseDelayMs \* 2 \*\* \(attempt - 1\)\)/baseDelayMs * 2 ** (attempt - 1)/'
run_mut "jitter ignored"                       $G 's/return Math.round\(exp \* \(0.5 \+ 0.5 \* random\(\)\)\);/return Math.round(exp);/'
run_mut "error path keeps the query"           $G 's/const \{ method, url \} = prepare\(methodIn, path, opts\);/const { method, url } = prepare(methodIn, path, opts); path = url.replace(apiRoot, "");/'
run_mut "token redaction removed"              $G "s/if \(token && String\(token\).length >= 8\) s = s.split\(String\(token\)\).join\('\[redacted\]'\);//"
run_mut "token shapes not redacted"            $G "s/\.replace\(TOKEN_SHAPE, '\[redacted\]'\)//"
run_mut "bearer not redacted"                  $G "s/\.replace\(BEARER, '\[redacted\]'\)//"
run_mut "body excerpt not redacted"            $G 's/const excerptOf = \(text\) => clean\(text\)/const excerptOf = (text) => String(text)/'
run_mut "message detail not redacted"          $G 's/detail = clean\(detail\)\.replace/detail = String(detail).replace/'
run_mut "excerpt not cut"                      $G 's/\.slice\(0, EXCERPT_MAX\)//'
run_mut "detail not cut"                       $G 's/\.slice\(0, DETAIL_MAX\)//'
run_mut "non-JSON success body returned as text" $G 's/    try \{\n      return JSON.parse\(text\);\n    \} catch \{\n      throw new GitLabApiError\(`GitLab API \$\{method\} \$\{path\} returned a body that is not JSON \(HTTP \$\{status\}\)`, \{\n        code: .invalid_json., status, method, path, bodyExcerpt: excerptOf\(text\),\n      \}\);\n    \}/    try { return JSON.parse(text); } catch { return text; }/'
run_mut "empty body returns empty string"      $G "s/if \(text.trim\(\) === ''\) return null;/if (text.trim() === '') return text;/"
run_mut "pagination stops after the first page" $G 's/target = prepare\(method, path, \{ query: \{ \.\.\.query, per_page: perPage, page: Number\(nextPage\) \} \}\);\n        continue;/return items;/'
run_mut "pagination ignores maxPages"          $G 's/pages < maxPages/pages < 1e9/'
run_mut "Link origin not checked"              $G 's/next.origin !== origin \|\| //'
run_mut "Link path prefix not checked"         $G 's/ \|\| !next.pathname.startsWith\(rootPath\)//'
run_mut "Link preferred over X-Next-Page"      $G 's/if \(nextPage && nextPage.trim\(\) !== ..\) \{/if (false) {/'
run_mut "non-array page accepted"              $G 's/if \(!Array.isArray\(data\)\) \{/if (false) {/'
run_mut "perPage not sent"                     $G 's/query: \{ \.\.\.query, per_page: perPage, page: 1 \}/query: { ...query, page: 1 }/'
run_mut "timeout never fires"                  $G 's/const timer = setTimeout\(\(\) => ac.abort\(\), limit\);/const timer = setTimeout(() => {}, limit);/'
run_mut "signal not passed to fetch"           $G 's/signal: ac.signal, //'
run_mut "per-call timeout ignored"             $G 's/const limit = perCall === undefined \? timeoutMs : checkNumber\(.timeoutMs., perCall, \{ min: 1 \}\);/const limit = timeoutMs;/'
run_mut "timeouts retried for POST"            $G 's/if \(attempt <= retries && \(retryUnsafe \|\| IDEMPOTENT.has\(method\)\)\) \{\n          const delayMs = backoff\(attempt\);/if (attempt <= retries) {\n          const delayMs = backoff(attempt);/'
run_mut "network errors not retried"           $G 's/if \(attempt <= retries && \(retryUnsafe \|\| IDEMPOTENT.has\(method\)\)\) \{\n          const delayMs = backoff\(attempt\);/if (false) {\n          const delayMs = backoff(attempt);/'
run_mut "every fetch error treated as network" $G 's/if \(!net\) throw err;[^\n]*\n//'
run_mut "network code lost"                    $G "s/networkCode: net.code/networkCode: undefined/"
run_mut "caller overrides the token header"    $G "s/const FORBIDDEN_HEADERS = new Set\(\['private-token', 'authorization',/const FORBIDDEN_HEADERS = new Set([/"
run_mut "caller sets Authorization"            $G "s/'authorization', 'job-token'/'job-token'/"
run_mut "absolute URL accepted as path"        $G 's/const PATH_OK = \/\^\\\/\[/const PATH_OK = \/^[a-z:]*\\\/[/'
run_mut "dot segments accepted"                $G 's/ \|\| \/\(\^\|\\\/\)\\\.\\\.\?\(\\\/\|\$\)\/.test\(path\)//'
run_mut "double slash accepted"                $G 's/ \|\| path.startsWith\(.\/\/.\)//'
run_mut "http allowed for any host"            $G 's/if \(u.protocol !== .https:. && !local\)/if (false)/'
run_mut "credentials in baseUrl allowed"       $G 's/if \(u.username \|\| u.password\) throw bad\([^\n]*\n//'
run_mut "short token accepted"                  $G 's/\/\^\[\\x21-\\x7E\]\{8,\}\$\//\/^[\\x21-\\x7E]{1,}$\//'
run_mut "token with spaces accepted"           $G 's/\/\^\[\\x21-\\x7E\]\{8,\}\$\//\/^.{8,}$\//'
run_mut "GET with a body accepted"             $G "s/if \(opts.body !== undefined && \(method === 'GET' \|\| method === 'HEAD'\)\) \{/if (false) {/"
run_mut "unknown method accepted"              $G 's/if \(!METHODS.has\(method\)\)/if (false)/'
run_mut "query arrays without []"              $G "s/const k = key.endsWith\('\[\]'\) \? key : \`\\$\{key\}\[\]\`;/const k = key;/"
run_mut "null query values sent"               $G 's/if \(value === undefined \|\| value === null\) continue;/if (value === undefined) continue;/'
run_mut "object query values sent"             $G "s/  throw new GitLabApiError\(\`query parameter/  return String(v); throw new GitLabApiError(\`query parameter/"
run_mut "dates sent as local text"             $G 's/if \(v instanceof Date\) return v.toISOString\(\);/if (v instanceof Date) return String(v);/'
run_mut "projectId not encoded"                $G 's/return encodeURIComponent\(idOrPath.trim\(\)\);/return idOrPath.trim();/'
run_mut "baseUrl without api prefix"           $G "s/if \(!p.endsWith\(API_PREFIX\)\) p \+= API_PREFIX;//"
run_mut "api prefix doubled"                   $G "s/if \(!p.endsWith\(API_PREFIX\)\) p \+= API_PREFIX;/p += API_PREFIX;/"
run_mut "user agent missing"                   $G "s/, 'user-agent': USER_AGENT//"
run_mut "no accept header"                     $G "s/accept: 'application\/json', //"
run_mut "content type missing"                 $G "s/headers\['content-type'\] = 'application\/json';//"
run_mut "log carries the full URL"             $G 's/log\?\.\(\{ event: .retry., method, path, status, code: .http., attempt, delayMs \}\);/log?.({ event: "retry", method, path: url, status, code: "http", attempt, delayMs });/'
run_mut "log carries the headers"              $G 's/log\?\.\(\{ event: .retry., method, path, status: 0, code: problem.code, attempt, delayMs \}\);/log?.({ event: "retry", method, path, status: 0, code: problem.code, attempt, delayMs, headers });/'
run_mut "okStatuses ignored by raw"            $G 's/const ok = \(status >= 200 && status < 300\) \|\| okStatuses.includes\(status\);/const ok = (status >= 200 \&\& status < 300);/'
run_mut "request honours okStatuses"           $G 's/return \(await raw\(method, path, \{ \.\.\.opts, okStatuses: \[\] \}\)\)\.data;/return (await raw(method, path, opts)).data;/'
run_mut "expect text ignored"                  $G "s/if \(expect === 'text'\) return text;//"
run_mut "attempts not reported"                $G 's/code: .http., status, method, path, attempts, bodyExcerpt: excerptOf\(text\),/code: "http", status, method, path, attempts: 1, bodyExcerpt: excerptOf(text),/'
run_mut "bad config not checked (retries)"     $G "s/checkNumber\('retries', retries, \{ min: 0, max: 10, integer: true \}\);//"
run_mut "bad config not checked (timeout)"     $G "s/checkNumber\('timeoutMs', timeoutMs, \{ min: 1 \}\);//"
run_mut "sleep not injectable"                 $G 's/if \(!isFn\(sleep\)\) throw bad\([^\n]*\n//'

# the fake itself
run_mut "fake: first route wins"               $F 's/\[\.\.\.routes\]\.reverse\(\)\.find/routes.find/'
run_mut "fake: exhausted sequence repeats"     $F 's/        throw new FakeFetchError\(`fakeFetch: responses for[^\n]*\n/        spec = spec[spec.length - 1];\n/'
run_mut "fake: unmatched answers 404"          $F 's/if \(strict\) throw new FakeFetchError/if (false) throw new FakeFetchError/'
run_mut "fake: query not matched"              $F 's/  if \(r.query\) \{/  if (false) {/'
run_mut "fake: PUT counted as safe"            $F "s/const SAFE_METHODS = new Set\(\['GET', 'HEAD'\]\);/const SAFE_METHODS = new Set(['GET', 'HEAD', 'PUT']);/"
run_mut "fake: hang ignores abort"             $F 's/else signal.addEventListener\(.abort., abort, \{ once: true \}\);//'
run_mut "fake: network error not a TypeError"  $F "s/Object.assign\(new TypeError\('fetch failed'\), \{ cause \}\)/Object.assign(new Error('fetch failed'), { cause })/"
run_mut "fake: headers not lower-cased"        $F 's/headers\[String\(k\).toLowerCase\(\)\] = String\(v\);/headers[String(k)] = String(v);/'
run_mut "fake: JSON body not parsed"           $F 's/try \{ body = JSON.parse\(body\); \}/try { body = body; }/'
run_mut "fake: calls not recorded when unmatched" $F 's/    calls.push\(call\);\n//'
run_mut "fake: 204 keeps a body"               $F 's/if \(NO_BODY_STATUS.has\(status\)\) body = null;//'

echo; echo "mutations: $total   not caught: $survivors"
[ "$survivors" -eq 0 ]
