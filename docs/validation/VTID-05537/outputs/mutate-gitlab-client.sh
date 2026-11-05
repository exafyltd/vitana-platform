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
  if [ -n "${ONLY:-}" ] && ! [[ "$name" =~ $ONLY ]]; then return; fi
  rm -rf "$WORK/t"; mkdir -p "$WORK/t"; cp -r "$SRC/scripts" "$WORK/t/"
  local f="$WORK/t/scripts/eng/$file" before after
  before="$(sha256sum "$f" | cut -c1-16)"
  perl -0pi -e "$expr" "$f"
  after="$(sha256sum "$f" | cut -c1-16)"
  total=$((total + 1))
  if [ "$before" = "$after" ]; then echo "NOOP     $name"; survivors=$((survivors + 1)); return; fi
  if ! node --check "$f" 2>/dev/null; then echo "INVALID  $name (the mutated file does not parse: fix the mutation, it proves nothing)"; survivors=$((survivors + 1)); return; fi
  local out rc failed
  out="$(cd "$WORK/t" && timeout 90 node --test scripts/eng/gitlab-api.test.mjs scripts/eng/testing/fake-fetch.test.mjs 2>&1)"; rc=$?
  failed="$(grep -E '^not ok' <<<"$out" | sed -E 's/^not ok [0-9]+ - //' | cut -c1-60 | head -3 | paste -sd'|' -)"
  if [ "$rc" = 124 ]; then echo "caught   $name  <- (hung, timed out)"
  elif grep -q '^# fail 0' <<<"$out" && [ "$rc" = 0 ]; then echo "SURVIVED $name"; survivors=$((survivors + 1))
  else echo "caught   $name  <- $failed"; fi
}

# run_str: exact-string mutation (no regex escaping): name, file, old text, new text [, old2, new2]
run_str() {
  OLD="$3" NEW="$4" OLD2="${5:-}" NEW2="${6:-}" run_mut "$1" "$2" 's/\Q$ENV{OLD}\E/$ENV{NEW}/; if (length $ENV{OLD2}) { s/\Q$ENV{OLD2}\E/$ENV{NEW2}/ }'
}
# run_equiv: a mutation that cannot change behaviour because another layer enforces the same property. It must still parse,
# change the file and leave the tests GREEN; the reason is printed. If a test goes red the mutant is not equivalent.
equiv=0
run_equiv() {   # name, file, old, new, reason
  local name="$1" file="$2" f="$WORK/t/scripts/eng/$2"
  if [ -n "${ONLY:-}" ] && ! [[ "$name" =~ $ONLY ]]; then return; fi
  rm -rf "$WORK/t"; mkdir -p "$WORK/t"; cp -r "$SRC/scripts" "$WORK/t/"
  total=$((total + 1))
  OLD="$3" NEW="$4" perl -0pi -e 's/\Q$ENV{OLD}\E/$ENV{NEW}/' "$f"
  if ! node --check "$f" 2>/dev/null; then echo "INVALID  $name"; survivors=$((survivors + 1)); return; fi
  if (cd "$WORK/t" && timeout 90 node --test scripts/eng/gitlab-api.test.mjs scripts/eng/testing/fake-fetch.test.mjs >/dev/null 2>&1); then
    echo "equiv    $name  <- $5"; equiv=$((equiv + 1))
  else echo "SURVIVED-AS-RED $name (the tests fail, so it is not equivalent: treat as caught)"; fi
}

G=gitlab-api.mjs; F=testing/fake-fetch.mjs
# ---- where the token goes
run_mut "token in Authorization header"          $G "s/headers\['private-token'\] = secret;/headers['authorization'] = 'Bearer ' + secret;/"
run_mut "token also in the URL"                  $G 's/const url = `\$\{apiRoot\}\$\{path\}\$\{qs \? `\?\$\{qs\}` : ..\}`;/const url = `\${apiRoot}\${path}?private_token=\${encodeURIComponent(secret)}\${qs ? "\&" + qs : ""}`;/'
run_mut "redirects followed"                     $G "s/redirect: 'manual'/redirect: 'follow'/"
run_mut "3xx band starts at 301"                 $G 's/if \(status >= 300 && status < 400\) \{/if (status >= 301 \&\& status < 400) {/'
run_mut "caller sets Authorization"              $G "s/'private-token', 'authorization', 'proxy-authorization'/'private-token', 'proxy-authorization'/"
run_mut "caller sets Proxy-Authorization"        $G "s/'authorization', 'proxy-authorization', /'authorization', /"
run_mut "caller sets Job-Token"                  $G "s/'job-token', 'deploy-token'/'deploy-token'/"
run_mut "caller sets Cookie"                     $G "s/'deploy-token', 'cookie', 'host'/'deploy-token', 'host'/"
run_mut "caller sets Host"                       $G "s/'cookie', 'host', 'content-length'/'cookie', 'content-length'/"
run_mut "caller sets X-HTTP-Method-Override"     $G "s/'x-http-method-override', 'x-http-method', /'x-http-method', /"
run_mut "caller sets X-Forwarded-Host"           $G "s/'x-forwarded-host', //"
run_mut "caller sets Forwarded"                  $G "s/'content-length',\n  'x-http-method-override', 'x-http-method', 'x-method-override', 'forwarded', /'content-length',\n  'x-http-method-override', 'x-http-method', 'x-method-override', /"
run_mut "query private_token allowed"            $G "s/const FORBIDDEN_QUERY = new Set\(\['private_token', /const FORBIDDEN_QUERY = new Set([/"
run_mut "query access_token allowed"            $G "s/'private_token', 'access_token', /'private_token', /"
run_mut "query check not case-insensitive"       $G 's/FORBIDDEN_QUERY.has\(key.toLowerCase\(\)\)/FORBIDDEN_QUERY.has(key)/'
run_mut "http allowed for any host"              $G 's/if \(u.protocol !== .https:. && !local\)/if (false)/'
run_mut "credentials in baseUrl allowed"         $G 's/  if \(u.username \|\| u.password\) throw bad\([^\n]*\n//'
run_mut "query string in baseUrl allowed"        $G 's/  if \(u.search \|\| u.hash\) throw bad\([^\n]*\n//'
# ---- paths

run_str "3xx accepted as success"               $G "if ((status >= 200 && status < 300) || okStatuses.includes(status)) return" "if ((status >= 200 && status < 400) || okStatuses.includes(status)) return"
run_str "okStatuses ignored by raw"             $G "if ((status >= 200 && status < 300) || okStatuses.includes(status)) return" "if ((status >= 200 && status < 300)) return"
run_str "caller overrides the token header (both layers)" $G "  'private-token', 'authorization', 'proxy-authorization'," "  'authorization', 'proxy-authorization'," "    headers['private-token'] = secret;
" ""
run_equiv "absolute URL accepted by the character class" $G "const PATH_OK = /^\\/" "const PATH_OK = /^(?:https?:\\/)?\\/" "an https://host/x path then fails the final URL check (it would leave /api/v4); two independent layers refuse it"
run_str "path with space accepted"              $G "const PATH_OK = /^\\/[A-Za-z0-9._~!\$&'()*+,;=:@%/-]*\$/;" "const PATH_OK = /^\\/[A-Za-z0-9._~!\$&'()*+,;=:@%/ -]*\$/;"
run_str "encoded dot segments accepted"         $G "const DOT_SEGMENT = /(^|\\/)(?:\\.|%2e){1,2}(?:\\/|\$)/i;" "const DOT_SEGMENT = /(^|\\/)\\.{1,2}(?:\\/|\$)/;"
run_str "token charset widened to any print"    $G "const TOKEN_OK = /^[A-Za-z0-9_.~=-]{8,}\$/;" "const TOKEN_OK = /^[\\x21-\\x7E]{8,}\$/;"
run_str "short token accepted"                  $G "const TOKEN_OK = /^[A-Za-z0-9_.~=-]{8,}\$/;" "const TOKEN_OK = /^[A-Za-z0-9_.~=-]{1,}\$/;"
run_str "unexpected fetch error swallowed"      $G "          if (!net) throw err; // not a network failure: a bug of the caller or of a test double; do not hide it" "          if (!net) { /* swallowed */ }"
run_str "body limit applies to 3xx bodies too"  $G "const ok = (res.status >= 200 && res.status < 300) || okStatuses.includes(res.status);" "const ok = true;"
run_equiv "caller header deny list lacks private-token" $G "  'private-token', 'authorization', 'proxy-authorization'," "  'authorization', 'proxy-authorization'," "the client assigns its own PRIVATE-TOKEN after the caller's headers, so a caller value is overwritten anyway"
run_equiv "final URL check removed"             $G "if (u.origin !== origin || !(u.pathname === rootPath || u.pathname.startsWith(\`\${rootPath}/\`))) {" "if (false) {" "checkPath rejects every input that could leave /api/v4; the check re-reads the built URL as defence in depth"
run_equiv "GitLabApiError rethrow in the catch removed" $G "        if (err instanceof GitLabApiError) throw err;
" "" "networkInfo() returns null for a GitLabApiError, and the generic rethrow of a non-network error handles it"
run_mut "dot segments accepted"                  $G 's/ \|\| DOT_SEGMENT.test\(path\)//'
run_mut "double slash accepted"                  $G 's/ \|\| path.startsWith\(.\/\/.\)//'
run_mut "path may be a non-string"               $G "s/typeof path !== 'string' \|\| //"
# ---- token and configuration
run_mut "token not validated"                    $G 's/if \(typeof token !== .string. \|\| !TOKEN_OK.test\(token.trim\(\)\)\) \{/if (false) {/'
run_mut "token not trimmed"                      $G 's/const secret = token.trim\(\);/const secret = token;/'
run_mut "fetch not validated"                    $G 's/  if \(!isFn\(fetch\)\) throw bad\([^\n]*\n//'
run_mut "sleep not validated"                    $G 's/  if \(!isFn\(sleep\)\) throw bad\([^\n]*\n//'
run_mut "random not validated"                   $G 's/  if \(!isFn\(random\)\) throw bad\([^\n]*\n//'
run_mut "now not validated"                      $G 's/  if \(!isFn\(now\)\) throw bad\([^\n]*\n//'
run_mut "log not validated"                      $G 's/  if \(log !== undefined && !isFn\(log\)\) throw bad\([^\n]*\n//'
run_mut "retries not validated"                  $G "s/  checkNumber\('retries', retries, \{ min: 0, max: 10, integer: true \}\);\n//"
run_mut "baseDelayMs not validated"              $G "s/  checkNumber\('baseDelayMs', baseDelayMs, \{ min: 0, max: TIMER_MAX \}\);\n//"
run_mut "maxDelayMs not validated"               $G "s/  checkNumber\('maxDelayMs', maxDelayMs, \{ min: 0, max: TIMER_MAX \}\);\n//"
run_mut "timeoutMs not validated"                $G "s/  checkNumber\('timeoutMs', timeoutMs, \{ min: 1, max: TIMER_MAX \}\);\n//"
run_mut "maxBodyBytes not validated"             $G "s/  checkNumber\('maxBodyBytes', maxBodyBytes, \{ min: 1, integer: true \}\);\n//"
run_mut "retryUnsafe not validated"              $G "s/  if \(typeof retryUnsafe !== 'boolean'\) throw bad\([^\n]*\n//"
run_mut "timer limit removed (timeoutMs)"        $G "s/\{ min: 1, max: TIMER_MAX \}\);\n  checkNumber\('maxBodyBytes'/{ min: 1 });\n  checkNumber('maxBodyBytes'/"
run_mut "baseUrl without api prefix"             $G "s/  if \(!p.endsWith\(API_PREFIX\)\) p \+= API_PREFIX;\n//"
run_mut "api prefix doubled"                     $G "s/if \(!p.endsWith\(API_PREFIX\)\) p \+= API_PREFIX;/p += API_PREFIX;/"
run_mut "baseUrl trailing slash kept"            $G "s/let p = u.pathname.replace\(\/\\\\\/\+\\\$\/, ''\);/let p = u.pathname;/"
# ---- retry
run_mut "all 4xx retried"                        $G 's/const serverSide = status >= 500 && status !== 501;/const serverSide = status >= 400 \&\& status !== 501;/'
run_mut "404 retried"                            $G 's/const rateLimited = status === 429;/const rateLimited = status === 429 || status === 404;/'
run_mut "501 retried"                            $G 's/const serverSide = status >= 500 && status !== 501;/const serverSide = status >= 500;/'
run_mut "POST retried on 5xx"                    $G 's/const IDEMPOTENT = new Set\(\[.GET., .HEAD., .PUT., .DELETE.\]\);/const IDEMPOTENT = new Set(["GET","HEAD","PUT","DELETE","POST","PATCH"]);/'
run_mut "PATCH treated as idempotent"            $G 's/new Set\(\[.GET., .HEAD., .PUT., .DELETE.\]\)/new Set(["GET","HEAD","PUT","DELETE","PATCH"])/'
run_mut "HEAD not idempotent"                    $G 's/new Set\(\[.GET., .HEAD., .PUT., .DELETE.\]\)/new Set(["GET","PUT","DELETE"])/'
run_mut "PUT not treated as idempotent"          $G 's/new Set\(\[.GET., .HEAD., .PUT., .DELETE.\]\)/new Set(["GET","HEAD","DELETE"])/'
run_mut "DELETE not idempotent"                  $G 's/new Set\(\[.GET., .HEAD., .PUT., .DELETE.\]\)/new Set(["GET","HEAD","PUT"])/'
run_mut "429 not retried for writes"             $G 's/if \(attempt <= maxRetries && \(rateLimited \|\| \(serverSide/if (attempt <= maxRetries \&\& ((rateLimited \&\& IDEMPOTENT.has(method)) || (serverSide/'
run_mut "429 never retried"                      $G 's/if \(attempt <= maxRetries && \(rateLimited \|\| \(serverSide/if (attempt <= maxRetries \&\& (false || (serverSide/'
run_mut "retries never stop (status)"            $G 's/if \(attempt <= maxRetries && \(rateLimited/if (true \&\& (rateLimited/'
run_mut "retry cap off by one (status)"          $G 's/if \(attempt <= maxRetries && \(rateLimited/if (attempt < maxRetries \&\& (rateLimited/'
run_mut "retries never stop (network)"           $G 's/if \(attempt <= maxRetries && \(retryUnsafe \|\| IDEMPOTENT.has\(method\)\)\) \{/if (true \&\& (retryUnsafe || IDEMPOTENT.has(method))) {/'
run_mut "retry cap off by one (network)"         $G 's/if \(attempt <= maxRetries && \(retryUnsafe \|\| IDEMPOTENT.has\(method\)\)\) \{/if (attempt < maxRetries \&\& (retryUnsafe || IDEMPOTENT.has(method))) {/'
run_mut "network/timeout retried for POST"       $G 's/if \(attempt <= maxRetries && \(retryUnsafe \|\| IDEMPOTENT.has\(method\)\)\) \{/if (attempt <= maxRetries) {/'
run_mut "network/timeout never retried"          $G 's/if \(attempt <= maxRetries && \(retryUnsafe \|\| IDEMPOTENT.has\(method\)\)\) \{/if (false) {/'
run_mut "retryUnsafe ignored (network)"          $G 's/if \(attempt <= maxRetries && \(retryUnsafe \|\| IDEMPOTENT.has\(method\)\)\) \{/if (attempt <= maxRetries \&\& IDEMPOTENT.has(method)) {/'
run_mut "retryUnsafe ignored (5xx)"              $G 's/\(serverSide && \(retryUnsafe \|\| IDEMPOTENT.has\(method\)\)\)/(serverSide \&\& IDEMPOTENT.has(method))/'
run_mut "per-call retries ignored"               $G "s/retries: opts.retries === undefined \? retries : checkNumber\('retries', opts.retries, \{ min: 0, max: 10, integer: true \}, make\),/retries,/"
run_mut "per-call retries not validated"         $G "s/checkNumber\('retries', opts.retries, \{ min: 0, max: 10, integer: true \}, make\)/opts.retries/"
run_mut "Retry-After ignored"                    $G 's/const delayMs = retryAfter === undefined \? backoff\(attempt\) : retryAfter;/const delayMs = backoff(attempt);/'
run_mut "Retry-After not limited by maxDelayMs"  $G 's/if \(retryAfter !== undefined && retryAfter > maxDelayMs\) \{/if (false) {/'
run_mut "Retry-After limit off by one"           $G 's/retryAfter > maxDelayMs/retryAfter >= maxDelayMs/'
run_mut "Retry-After only on 429"                $G 's/rateLimited \|\| unavailable \? parseRetryAfter/rateLimited ? parseRetryAfter/'
run_mut "Retry-After on every status"            $G 's/rateLimited \|\| unavailable \? parseRetryAfter/true ? parseRetryAfter/'
run_mut "Retry-After date ignored"               $G 's/const when = Date.parse\(v\);/const when = NaN;/'
run_mut "Retry-After seconds ignored"            $G 's/if \(\/\^\\d\+\(\\.\\d\+\)\?\$\/.test\(v\)\) return Math.round\(Number\(v\) \* 1000\);//'
run_mut "Retry-After letterless value parsed"    $G 's/  if \(!\/\[A-Za-z\]\/.test\(v\)\) return undefined;[^\n]*\n//'
run_mut "Retry-After in the past is negative"    $G 's/return Number.isNaN\(when\) \? undefined : Math.max\(0, when - now\(\)\);/return Number.isNaN(when) ? undefined : when - now();/'
run_mut "rate_limited drops retryAfterMs"        $G 's/attempts: attempt, retryAfterMs: retryAfter,/attempts: attempt,/'
run_mut "back-off constant"                      $G 's/baseDelayMs \* 2 \*\* \(attempt - 1\)/baseDelayMs/'
run_mut "back-off not capped"                    $G 's/Math.min\(maxDelayMs, baseDelayMs \* 2 \*\* \(attempt - 1\)\)/baseDelayMs * 2 ** (attempt - 1)/'
run_mut "jitter ignored"                         $G 's/return Math.round\(exp \* \(0.5 \+ 0.5 \* random\(\)\)\);/return Math.round(exp);/'
run_mut "jitter can exceed the cap"              $G 's/return Math.round\(exp \* \(0.5 \+ 0.5 \* random\(\)\)\);/return Math.round(exp * (1 + random()));/'
run_mut "body not resent on retry"               $G 's/res = await Promise.race\(\[fetch\(url, \{ method, headers, body: payload,/res = await Promise.race([fetch(url, { method, headers, body: attempt === 1 ? payload : undefined,/'
run_mut "headers dropped on retry"               $G 's/res = await Promise.race\(\[fetch\(url, \{ method, headers, body: payload,/res = await Promise.race([fetch(url, { method, headers: attempt === 1 ? headers : { "private-token": secret }, body: payload,/'
# ---- timeouts and bodies
run_mut "timeout never fires"                    $G 's/          ac.abort\(\);\n          reject\(new DOMException\(.The operation timed out., .AbortError.\)\);/          \/\/ never/'
run_mut "deadline not raced against fetch"       $G 's/res = await Promise.race\(\[fetch\(url, \{ method, headers, body: payload, signal: ac.signal, redirect: .manual. \}\), deadline\]\);/res = await fetch(url, { method, headers, body: payload, signal: ac.signal, redirect: "manual" });/'
run_mut "deadline not raced against the body"    $G 's/const read = await Promise.race\(\[readBody\(res, ok \? bodyLimit : ERROR_BODY_MAX\), deadline\]\);/const read = await readBody(res, ok ? bodyLimit : ERROR_BODY_MAX);/'
run_mut "signal not passed to fetch"             $G 's/signal: ac.signal, //'
run_mut "timer never cleared"                    $G 's/        clearTimeout\(timer\);\n//'
run_mut "timer cleared before the body is read"  $G 's/        res = await Promise.race\(\[fetch\(url, \{ method, headers, body: payload, signal: ac.signal, redirect: .manual. \}\), deadline\]\);/        res = await Promise.race([fetch(url, { method, headers, body: payload, signal: ac.signal, redirect: "manual" }), deadline]); clearTimeout(timer);/'
run_mut "per-call timeout ignored"               $G "s/timeoutMs: opts.timeoutMs === undefined \? timeoutMs : checkNumber\('timeoutMs', opts.timeoutMs, \{ min: 1, max: TIMER_MAX \}, make\),/timeoutMs,/"
run_mut "per-call timeout not limited"           $G "s/checkNumber\('timeoutMs', opts.timeoutMs, \{ min: 1, max: TIMER_MAX \}, make\)/checkNumber('timeoutMs', opts.timeoutMs, { min: 1 }, make)/"
run_mut "per-call maxBodyBytes ignored"          $G "s/maxBodyBytes: opts.maxBodyBytes === undefined \? maxBodyBytes : checkNumber\('maxBodyBytes', opts.maxBodyBytes, \{ min: 1, integer: true \}, make\),/maxBodyBytes,/"
run_mut "body limit ignored"                     $G 's/    if \(total > maxBytes\) \{/    if (false) {/'
run_mut "body limit off by one"                  $G 's/    if \(total > maxBytes\) \{/    if (total >= maxBytes) {/'
run_mut "oversize body accepted"                 $G 's/if \(read.truncated && ok\) \{/if (false) {/'
run_mut "error body read to the end"             $G 's/ok \? bodyLimit : ERROR_BODY_MAX/bodyLimit/'
run_mut "timeout error loses the attempt count"  $G 's/\{ code: .timeout., method, path, attempts: attempt \}/{ code: "timeout", method, path }/'
run_mut "response status lost on a cut body"     $G 's/\.\.\.\(res \? \{ responseStatus: res.status \} : \{\}\),//'
run_mut "cut body message lacks the warning"     $G 's/; the request may have been processed//'
run_mut "network code lost"                      $G "s/networkCode: net.code/networkCode: undefined/"
run_mut "NETWORK_CODE narrowed"                  $G 's/const NETWORK_CODE = \/\^\(ECONN\|ENOTFOUND\|EAI_AGAIN\|ETIMEDOUT\|EPIPE\|EHOSTUNREACH\|ENETUNREACH\|UND_ERR\|ERR_SSL\|CERT_\|DEPTH_ZERO\|UNABLE_TO\)\//const NETWORK_CODE = \/^(ECONN|ENOTFOUND)\//'
run_mut "fetch failed not a network error"       $G "s/if \(err instanceof TypeError && err.message === 'fetch failed'\) return/if (false) return/"
# ---- bodies and errors
run_mut "token redaction removed"                $G "s/if \(token && String\(token\).length >= 8\) s = s.split\(String\(token\)\).join\('\[redacted\]'\);//"
run_mut "token shapes not redacted"              $G "s/\.replace\(TOKEN_SHAPE, '\[redacted\]'\)//"
run_mut "bearer not redacted"                    $G "s/\.replace\(BEARER, '\[redacted\]'\)//"
run_mut "body excerpt not redacted"              $G 's/const excerptOf = \(text\) => clean\(text\)/const excerptOf = (text) => String(text)/'
run_mut "message detail not redacted"            $G 's/detail = clean\(detail\)\.replace/detail = String(detail).replace/'
run_mut "excerpt not cut"                        $G 's/\.slice\(0, EXCERPT_MAX\)//'
run_mut "detail not cut"                         $G 's/\.slice\(0, DETAIL_MAX\)//'
run_mut "excerpt whitespace kept"                $G "s/const excerptOf = \(text\) => clean\(text\)\.replace\(\/\\\\s\+\/g, ' '\)\.trim\(\)/const excerptOf = (text) => clean(text).trim()/"
run_mut "error path keeps the query"             $G 's/    const url = `\$\{apiRoot\}\$\{path\}\$\{qs \? `\?\$\{qs\}` : ..\}`;/    const url = `${apiRoot}${path}${qs ? `?${qs}` : ""}`; path = path + (qs ? `?${qs}` : "");/'
run_mut "non-JSON success body returned as text" $G 's/    try \{\n      return JSON.parse\(text\);\n    \} catch \{\n      throw new GitLabApiError\(`GitLab API \$\{method\} \$\{path\} returned a body that is not JSON \(HTTP \$\{status\}\)`, \{\n        code: .invalid_json., status, method, path, bodyExcerpt: excerptOf\(text\),\n      \}\);\n    \}/    try { return JSON.parse(text); } catch { return text; }/'
run_mut "empty body returns empty string"        $G "s/if \(text.trim\(\) === ''\) return null;/if (text.trim() === '') return text;/"
run_mut "expect text ignored"                    $G "s/if \(expect === 'text'\) return text;//"
run_mut "expect not validated"                   $G 's/    if \(!EXPECTS.has\(expect\)\) throw badRequest\([^\n]*\n//'
run_mut "okStatuses not validated"               $G 's/    if \(!Array.isArray\(okStatuses\) [^\n]*\n//'
run_mut "request accepts okStatuses silently"    $G 's/    if \(opts.okStatuses !== undefined\) \{\n      throw badRequest\([^\n]*\n    \}\n//'
run_mut "attempts not reported"                  $G 's/code: .http., status, method, path, attempts, bodyExcerpt: excerptOf\(text\),/code: "http", status, method, path, attempts: 1, bodyExcerpt: excerptOf(text),/'
run_mut "GET with a body accepted"               $G "s/if \(opts.body !== undefined && \(method === 'GET' \|\| method === 'HEAD'\)\) throw/if (false) throw/"
run_mut "HEAD with a body accepted"              $G "s/\(method === 'GET' \|\| method === 'HEAD'\)\) throw/(method === 'GET')) throw/"
run_mut "unknown method accepted"                $G 's/if \(!METHODS.has\(method\)\)/if (false)/'
run_mut "PATCH not a known method"               $G "s/const METHODS = new Set\(\['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'\]\);/const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE']);/"
run_mut "patch shortcut sends PUT"               $G "s/patch: \(path, opts\) => request\('PATCH'/patch: (path, opts) => request('PUT'/"
run_mut "del shortcut sends GET"                 $G "s/del: \(path, opts\) => request\('DELETE'/del: (path, opts) => request('GET'/"
run_mut "content type missing"                   $G "s/headers\['content-type'\] = 'application\/json';//"
run_mut "no accept header"                       $G "s/accept: 'application\/json', //"
run_mut "user agent missing"                     $G "s/, 'user-agent': USER_AGENT//"
run_mut "log carries the full URL"               $G 's/log\?\.\(\{ event: .retry., method, path, status, code: .http., attempt, delayMs \}\);/log?.({ event: "retry", method, path: url, status, code: "http", attempt, delayMs });/'
run_mut "log carries the headers"                $G 's/log\?\.\(\{ event: .retry., method, path, status: 0, code: problem.code, attempt, delayMs \}\);/log?.({ event: "retry", method, path, status: 0, code: problem.code, attempt, delayMs, headers });/'
# ---- query
run_mut "query arrays without []"                $G "s/const k = key.endsWith\('\[\]'\) \? key : \`\\$\{key\}\[\]\`;/const k = key;/"
run_mut "query arrays doubled []"                $G "s/const k = key.endsWith\('\[\]'\) \? key : /const k = /"
run_mut "null query values sent"                 $G 's/if \(value === undefined \|\| value === null\) continue;/if (value === undefined) continue;/'
run_mut "undefined query values sent"            $G 's/if \(value === undefined \|\| value === null\) continue;/if (value === null) continue;/'
run_mut "object query values sent"               $G "s/  throw badRequest\(\`query parameter/  return String(v); throw badRequest(\`query parameter/"
run_mut "dates sent as local text"               $G 's/if \(v instanceof Date\) return v.toISOString\(\);/if (v instanceof Date) return String(v);/'
run_mut "projectId not encoded"                  $G 's/return encodeURIComponent\(idOrPath.trim\(\)\);/return idOrPath.trim();/'
run_mut "projectId accepts negative numbers"     $G 's/Number.isInteger\(idOrPath\) && idOrPath >= 0/Number.isInteger(idOrPath)/'
# ---- pagination
run_mut "pagination stops after the first page"  $G 's/        page = n;\n        target = prepare\(method, path, \{ \.\.\.common, query: \{ \.\.\.query, per_page: perPage, page \} \}\);\n        continue;/        return items;/'
run_mut "pagination ignores maxPages"            $G 's/pages < maxPages/pages < 1e9/'
run_mut "maxPages off by one"                    $G 's/pages < maxPages/pages <= maxPages/'
run_mut "maxPages not validated"                 $G "s/    checkNumber\('maxPages', maxPages, \{ min: 1, integer: true \}, \(m\) => badRequest\(m, method, path\)\);\n//"
run_mut "perPage not validated"                  $G "s/    checkNumber\('perPage', perPage, \{ min: 1, max: 100, integer: true \}, \(m\) => badRequest\(m, method, path\)\);\n//"
run_mut "perPage not sent"                       $G 's/query: \{ \.\.\.query, per_page: perPage, page \}/query: { ...query, page }/g'
run_mut "page parameter not sent"                $G 's/query: \{ \.\.\.query, per_page: perPage, page \}/query: { ...query, per_page: perPage }/g'
run_mut "non-array page accepted"                $G 's/      if \(!Array.isArray\(data\)\) \{/      if (false) {/'
run_mut "pages built with spread"                $G 's/      for \(const item of data\) items.push\(item\);/      items.push(...data);/'
run_mut "next page may be NaN or backwards"      $G 's/        if \(!\/\^\\d\+\$\/.test\(nextPage.trim\(\)\) \|\| n <= page\) \{/        if (false) {/'
run_mut "next page only checked as number"       $G 's/ \|\| n <= page\) \{/) {/'
run_mut "next page not checked as digits"        $G 's/\!\/\^\\d\+\$\/.test\(nextPage.trim\(\)\) \|\| n <= page/n <= page/'
run_mut "Link origin not checked"                $G 's/!next \|\| next.origin !== origin \|\| /!next || /'
run_mut "Link userinfo not checked"              $G 's/ next.username \|\| next.password \|\|//'
run_mut "Link path prefix not checked"           $G 's/ \|\| !\(next.pathname === rootPath \|\| next.pathname.startsWith\(`\$\{rootPath\}\/`\)\)//'
run_mut "Link path boundary missing"             $G 's/next.pathname.startsWith\(`\$\{rootPath\}\/`\)/next.pathname.startsWith(rootPath)/'
run_mut "Link rel anywhere not found"            $G 's/const rel = \/;\\s\*rel\\s\*=\\s\*"\?\(\[\^";\]\*\)"\?\/i.exec\(m\[2\]\);/const rel = \/^\\s*;\\s*rel\\s*=\\s*"?([^";]*)"?\/i.exec(m[2]);/'
run_mut "Link entries not split"                 $G 's/split\(\/,\(\?=\\s\*<\)\/\)/split("\\u0000")/'
run_mut "Link rel case sensitive"                $G 's/rel\[1\].toLowerCase\(\).split/rel[1].split/'
run_mut "Link rel prefix match"                  $G "s/rel\[1\].toLowerCase\(\).split\(\/\\\\s\+\/\).includes\('next'\)/rel[1].toLowerCase().includes('nex')/"
run_mut "X-Next-Page wins over Link (reversed)"  $G 's/      if \(nextPage && nextPage.trim\(\) !== ..\) \{/      if (false) {/'
run_mut "pagination drops caller headers"        $G 's/      const res = await execute\(\{ \.\.\.target, headers \}\);/      const res = await execute({ ...target });/'
run_mut "pagination drops per-call timeout"      $G 's/const common = \{ timeoutMs: opts.timeoutMs, retries: opts.retries, maxBodyBytes: opts.maxBodyBytes \};/const common = { retries: opts.retries, maxBodyBytes: opts.maxBodyBytes };/'
run_mut "pagination drops per-call retries"      $G 's/const common = \{ timeoutMs: opts.timeoutMs, retries: opts.retries, maxBodyBytes: opts.maxBodyBytes \};/const common = { timeoutMs: opts.timeoutMs, maxBodyBytes: opts.maxBodyBytes };/'
run_mut "pagination drops per-call body limit"   $G 's/const common = \{ timeoutMs: opts.timeoutMs, retries: opts.retries, maxBodyBytes: opts.maxBodyBytes \};/const common = { timeoutMs: opts.timeoutMs, retries: opts.retries };/'

# ---- the fake
run_mut "fake: first route wins"                 $F 's/\[\.\.\.routes\]\.reverse\(\)\.find/routes.find/'
run_mut "fake: exhausted sequence repeats"       $F 's/        throw new FakeFetchError\(`fakeFetch: responses for[^\n]*\n/        spec = spec[spec.length - 1];\n/'
run_mut "fake: repeatLast ignored"               $F 's/      \} else if \(route.repeatLast\) \{/      } else if (false) {/'
run_mut "fake: unmatched answers 404"            $F 's/if \(strict\) throw new FakeFetchError/if (false) throw new FakeFetchError/'
run_mut "fake: query not matched"                $F 's/  if \(r.query\) \{/  if (false) {/'
run_mut "fake: query value compared loosely"     $F 's/if \(want.length !== got.length \|\| want.some\(\(w, i\) => w !== got\[i\]\)\) return false;/if (got.length === 0) return false;/'
run_mut "fake: method ignored"                   $F "s/if \(r.method !== '\*' && r.method !== call.method\) return false;//"
run_mut "fake: PUT counted as safe"              $F "s/const SAFE_METHODS = new Set\(\['GET', 'HEAD'\]\);/const SAFE_METHODS = new Set(['GET', 'HEAD', 'PUT']);/"
run_mut "fake: hang ignores abort"               $F 's/else signal.addEventListener\(.abort., abort, \{ once: true \}\);//'
run_mut "fake: hang ignores an aborted signal"   $F 's/if \(signal.aborted\) abort\(\);\n        else //'
run_mut "fake: network error not a TypeError"    $F "s/Object.assign\(new TypeError\('fetch failed'\), \{ cause \}\)/Object.assign(new Error('fetch failed'), { cause })/"
run_mut "fake: headers not lower-cased"          $F 's/headers\[String\(k\).toLowerCase\(\)\] = String\(v\);/headers[String(k)] = String(v);/'
run_mut "fake: JSON body not parsed"             $F 's/try \{ body = JSON.parse\(body\); \}/try { body = body; }/'
run_mut "fake: calls not recorded"               $F 's/    calls.push\(call\);\n//'
run_mut "fake: 204 keeps a body"                 $F 's/if \(NO_BODY_STATUS.has\(status\)\) body = null;//'
run_mut "fake: async handler not awaited"        $F 's/spec = await spec\(call\);/spec = spec(call);/'
run_mut "fake: bad match accepted"               $F "s/    if \(typeof match !== 'string' && !\(match instanceof RegExp\) && typeof match !== 'function'\) \{/    if (false) {/"
run_mut "fake: hangBody never stalls"            $F 's/    pull\(\) \{ return new Promise\(\(\) => \{\}\); \},/    pull(controller) { controller.close(); },/'
run_mut "fake: hangBody ignores abort"           $F 's/      else signal.addEventListener\(.abort., fail, \{ once: true \}\);//'
run_mut "fake: cutBody keeps the connection"     $F 's/      controller.error\(Object.assign\(new TypeError\(.terminated.\), \{ cause \}\)\);/      controller.close();/'
run_mut "fake: reset keeps routes"               $F 's/    routes.length = 0;\n  \};/  };/'
run_mut "fake: since ignores mark"               $F 's/fetchImpl.since = \(mark = 0\) => calls.slice\(mark\);/fetchImpl.since = () => calls.slice(0);/'
run_mut "fake: assertNoWrites never throws"      $F 's/    if \(w.length\) throw new FakeFetchError/    if (false) throw new FakeFetchError/'
run_mut "fake: spec not an object accepted"      $F "s/    if \(!spec \|\| typeof spec !== 'object'\) throw[^\n]*\n//"

echo; echo "mutations: $total   caught: $((total - survivors - equiv))   equivalent (tests green by design, reason printed): $equiv   not caught: $survivors"
[ "$survivors" -eq 0 ]
