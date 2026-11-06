#!/usr/bin/env bash
# VTID-05541 local curl proof of POST /api/v1/internal/gitlab/webhook (127.0.0.1 only; never staging or production).
#
#   bash curl-proof.sh <repository root>      (after `npm run build` in services/gateway)
#
# Starts curl-proof-server.cjs twice from a clean environment (env -i): server A with a freshly generated signing key,
# server B with no key. Each has its own local OASIS sink, so emitOasisEvent's INSERT stays on this machine. Signs like
# GitLab (Standard Webhooks: HMAC-SHA256 over "<webhook-id>.<webhook-timestamp>.<raw body>", key = base64 part of
# whsec_<base64>, header "webhook-signature: v1,<base64>") with Node's crypto, then sends each case with curl and prints
# the status, content type and reply. The key is generated here and never printed.
set -euo pipefail

REPO="${1:?usage: curl-proof.sh <repository root>}"
GW="$REPO/services/gateway"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$GW/dist/routes/internal-gitlab-webhook.js" ] || { echo "build first: (cd $GW && npm run build)" >&2; exit 2; }

KEY_B64=$(head -c 32 /dev/urandom | base64 -w0)
WORK=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$WORK"; }
trap cleanup EXIT

start() { # name route_port sink_port [key]
  local name=$1 rp=$2 sp=$3 key=${4:-}
  env -i PATH="$PATH" HOME="$WORK" NODE_ENV=production VITANA_ENV=staging \
    SUPABASE_URL="http://127.0.0.1:$sp" SUPABASE_SERVICE_ROLE="local-sink-not-a-key" \
    ${key:+GITLAB_WEBHOOK_SIGNING_TOKEN="whsec_$key"} \
    node "$HERE/curl-proof-server.cjs" "$GW" "$rp" "$sp" > "$WORK/$name.log" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 100); do curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:$sp/rows" && return 0; sleep 0.1; done
  echo "server $name did not start:"; cat "$WORK/$name.log"; exit 1
}
start A 18541 18542 "$KEY_B64"
start B 18543 18544
for _ in $(seq 1 100); do curl -s --noproxy '*' -o /dev/null -X POST "http://127.0.0.1:18541/" && curl -s --noproxy '*' -o /dev/null -X POST "http://127.0.0.1:18543/" && break; sleep 0.1; done

# HMAC-SHA256 with Node's own crypto (not the gateway's code); the key reaches it through the environment.
sig() {
  printf '%s' "$1.$2.$3" | KEY_B64="$KEY_B64" node -e '
    const c = require("crypto");
    const msg = require("fs").readFileSync(0);
    process.stdout.write(c.createHmac("sha256", Buffer.from(process.env.KEY_B64, "base64")).update(msg).digest("base64"));'
}
now() { date +%s; }
N=0
show() { # case-name http_code+type file
  N=$((N + 1))
  local code=${2%% *} type=${2#* }
  local body; body=$(head -c 300 "$3")
  printf '%2d. %-62s -> %s %s %s\n' "$N" "$1" "$code" "$type" "$body"
}
# post <name> <port> <body-file> [extra curl args...]: POST with the headers given in the extra args
post() {
  local name=$1 port=$2 file=$3; shift 3
  local out; out=$(curl -s --noproxy '*' --max-time 15 -o "$WORK/reply" -w '%{http_code} %{content_type}' \
    -X POST "http://127.0.0.1:$port/api/v1/internal/gitlab/webhook" -H 'Content-Type: application/json' "$@" --data-binary "@$file")
  show "$name" "$out" "$WORK/reply"
}
signed() { # name port body-file id [ts] [signed-body-file]
  local name=$1 port=$2 file=$3 id=$4 ts=${5:-$(now)} sfile=${6:-$3}
  post "$name" "$port" "$file" -H "webhook-id: $id" -H "webhook-timestamp: $ts" -H "webhook-signature: v1,$(sig "$id" "$ts" "$(cat "$sfile")")"
}

printf '%s' '{"object_kind":"merge_request","project":{"id":42,"path_with_namespace":"vitana/rehearsal"},"user":{"name":"Agent Kiro","email":"agent@example.invalid"},"object_attributes":{"iid":12,"title":"VTID-05541 (eng-gitlab-m2/scm-webhook): GitLab webhook route","description":"not copied","action":"open","state":"opened","source_branch":"kiro/eng-gitlab-m2/scm-webhook","target_branch":"main","url":"https://gitlab.example/vitana/rehearsal/-/merge_requests/12","last_commit":{"id":"abc0000000000000000000000000000000000002"}}}' > "$WORK/mr-open.json"
sed 's/"action":"open"/"action":"merge"/; s/"state":"opened"/"state":"merged"/' "$WORK/mr-open.json" > "$WORK/mr-merge.json"
sed 's/VTID-05541/VTID-09999/' "$WORK/mr-open.json" > "$WORK/mr-altered.json"
sed 's/"title":"VTID-05541 (eng-gitlab-m2\/scm-webhook): GitLab webhook route"/"title":"chore: no ticket"/' "$WORK/mr-open.json" > "$WORK/mr-novtid.json"
printf '%s' '{"object_kind":"pipeline","project":{"id":42,"path_with_namespace":"vitana/rehearsal"},"object_attributes":{"id":31,"ref":"main","sha":"abc0000000000000000000000000000000000002","source":"push","status":"failed","duration":9,"variables":[{"key":"K","value":"not copied"}]},"merge_request":null,"commit":{"id":"abc0000000000000000000000000000000000002","title":"VTID-05541 (eng-gitlab-m2/scm-webhook): route","message":"not copied"}}' > "$WORK/pipe-failed.json"
printf '%s' '{"object_kind":"push","ref":"refs/heads/main"}' > "$WORK/push.json"
printf '%s' '{"object_kind": "merge_request",' > "$WORK/broken.json"
printf '%s' '{}' > "$WORK/empty-object.json"
{ printf '%s' '{"object_kind":"merge_request","pad":"'; head -c 3145728 /dev/zero | tr '\0' 'x'; printf '%s' '"}'; } > "$WORK/big.json"

echo "== server A: signing key configured"
post "unsigned POST, the STAGING-VERIFY probe (Bearer invalid, {})" 18541 "$WORK/empty-object.json" -H 'accept: application/json, text/html;q=0.9' -H 'authorization: Bearer staging-verify.invalid.probe'
signed "signed merge_request open" 18541 "$WORK/mr-open.json" msg_proof_1
signed "same webhook-id again, new timestamp (duplicate)" 18541 "$WORK/mr-open.json" msg_proof_1 "$(( $(now) + 1 ))"
signed "body altered after signing" 18541 "$WORK/mr-altered.json" msg_proof_2 "$(now)" "$WORK/mr-open.json"
signed "signed with a stale timestamp (now - 301 s)" 18541 "$WORK/mr-open.json" msg_proof_3 "$(( $(now) - 301 ))"
TS=$(now); post "correct signature in svix-* headers only" 18541 "$WORK/mr-open.json" -H "svix-id: msg_proof_4" -H "svix-timestamp: $TS" -H "svix-signature: v1,$(sig msg_proof_4 "$TS" "$(cat "$WORK/mr-open.json")")"
signed "signed merge_request merge" 18541 "$WORK/mr-merge.json" msg_proof_5
signed "signed pipeline failed" 18541 "$WORK/pipe-failed.json" msg_proof_6
signed "signed push event (unknown event)" 18541 "$WORK/push.json" msg_proof_7
signed "signed merge_request without a VTID in the title" 18541 "$WORK/mr-novtid.json" msg_proof_8
signed "signed body that is not JSON" 18541 "$WORK/broken.json" msg_proof_9
signed "signed body of 3 MiB (limit 2mb)" 18541 "$WORK/big.json" msg_proof_10
curl -s --noproxy '*' -X POST "http://127.0.0.1:18542/fail-next" -o /dev/null
signed "signed open while the OASIS table refuses the row" 18541 "$WORK/mr-open.json" msg_proof_11
signed "the same delivery retried (webhook-id msg_proof_11)" 18541 "$WORK/mr-open.json" msg_proof_11

echo "== server B: no signing key"
post "unsigned POST, the STAGING-VERIFY probe (Bearer invalid, {})" 18543 "$WORK/empty-object.json" -H 'accept: application/json, text/html;q=0.9' -H 'authorization: Bearer staging-verify.invalid.probe'
signed "signed merge_request open (no key to check it with)" 18543 "$WORK/mr-open.json" msg_proof_12

echo "== OASIS rows received by sink A (the INSERTs emitOasisEvent sent; selected columns)"
curl -s --noproxy '*' "http://127.0.0.1:18542/rows" | node -e '
let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
  const rows = JSON.parse(s);
  for (const r of rows) console.log(JSON.stringify({ vtid: r.vtid, topic: r.topic, service: r.service, status: r.status, task_stage: r.task_stage ?? null, message: r.message, metadata: r.metadata }));
  console.log(`rows: ${rows.length}`);
  const text = JSON.stringify(rows);
  for (const leak of ["not copied", "agent@example.invalid", "Agent Kiro"]) console.log(`contains ${JSON.stringify(leak)}: ${text.includes(leak)}`);
});'
echo "== OASIS rows received by sink B: $(curl -s --noproxy '*' "http://127.0.0.1:18544/rows" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).length))')"
echo "== server logs (A then B)"
cat "$WORK/A.log" "$WORK/B.log"
