// Faithful simulation of the Kiro agent shell-permission glob engine (VTID-05407 evidence).
// Semantics (from the existing rules, e.g. "git -C * diff*"): a pattern is a shell-style glob matched against the
// WHOLE command string, anchored start-to-end. `*` matches any run of characters (including spaces), `?` matches one
// char. A `capability: shell` ALLOW rule admits a command iff some `match` glob matches AND no `exclude` glob matches
// (the metachar guard). A `capability: shell` DENY rule denies a command iff no `exclude` glob matches it (i.e. the
// command is NOT on the allow-mirrored list). Net: a command is permitted iff (allow.match hits) && (no allow.exclude
// metachar hit) && (deny.exclude hits == command is on the allow list). The deny.exclude mirrors allow.match, so the
// two agree: a command runs iff it matches an allow pattern and trips no metachar guard.
// NOTE: this is a model of the engine for narrowness reasoning; the AUTHORITATIVE check is the live reviewer-agent
// dispatch recorded in live-demonstration.md.
function globToRe(glob) {
  let re = '';
  for (const ch of String(glob)) {
    if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const anyMatch = (cmd, globs) => globs.some((g) => globToRe(g).test(cmd));

// The pattern this lane ships, added to BOTH the allow match[] and the deny exclude[].
const PATTERN = '*scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer';
const ALLOW_MATCH = ["git -C * diff*", "git -C * log*", "git -C * show*", "git -C * fetch origin*", "git -C * merge-base*", "git -C * rev-parse*", "gh pr view*", "gh pr checks*", "gh run view*", PATTERN];
const METACHAR = ["*;*", "*&*", "*|*", "*>*", "*<*", "*`*", "*$(*"];
const DENY_EXCLUDE = ALLOW_MATCH; // the deny rule's exclude[] mirrors the allow match-list

function permitted(cmd, allowMatch = ALLOW_MATCH, denyExclude = DENY_EXCLUDE) {
  const allowHit = anyMatch(cmd, allowMatch) && !anyMatch(cmd, METACHAR);
  const denyMirrored = anyMatch(cmd, denyExclude); // on the allow list → the deny rule does NOT fire
  return allowHit && denyMirrored;
}

const P = '/projects/sandbox/vitana-platform';
const cases = [
  // MUST BE ADMITTED
  [`node ${P}/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer`, true, 'exact session-id (this checkout)'],
  [`node /some/other/ide/path/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer`, true, 'exact session-id (different <path>)'],
  // MUST BE DENIED
  [`node ${P}/scripts/collab/queue.mjs claim reviewer-session-id-permission/reviewer-perm --session x`, false, 'queue.mjs claim'],
  [`node ${P}/scripts/collab/queue.mjs release cards/card-01 --session x`, false, 'queue.mjs release'],
  [`node ${P}/scripts/collab/queue.mjs validate --repo ${P}`, false, 'queue.mjs validate'],
  [`node ${P}/scripts/collab/queue.mjs scope-check --repo ${P}`, false, 'queue.mjs scope-check'],
  [`node ${P}/scripts/collab/queue.mjs session-id --agent kiro --seat exafy`, false, 'session-id for kiro seat (not the reviewer agent)'],
  [`node ${P}/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer --seat exafy`, false, 'session-id + appended --seat (not exact)'],
  [`node ${P}/scripts/collab/queue.mjs session-id --agent agent:other`, false, 'session-id for another agent'],
  [`ls`, false, 'arbitrary shell: ls'],
  [`cat ${P}/.kiro/agents/vitana-lane-reviewer.md`, false, 'arbitrary shell: cat'],
  [`node -e "require('child_process').execSync('rm -rf /')"`, false, 'arbitrary node eval'],
  // metachar chaining attempts on the admitted command (must stay denied by the allow.exclude guard)
  [`node ${P}/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer; rm -rf /`, false, 'session-id ; chained'],
  [`node ${P}/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer && ls`, false, 'session-id && chained'],
  [`node ${P}/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer | cat`, false, 'session-id | piped'],
  [`node ${P}/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer > /tmp/x`, false, 'session-id > redirect'],
  [`node ${P}/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer $(whoami)`, false, 'session-id $() subshell'],
  // existing allowed reads still work (nothing regressed)
  [`git -C ${P} diff origin/main...HEAD`, true, 'git diff (existing)'],
  [`gh pr view 123 --json headRefOid`, true, 'gh pr view (existing)'],
];

// Also compare the chosen pattern against two broader alternatives, to show the chosen one is narrower.
const ALT_BROAD1 = ['node *'];            // would admit ANY node command — far too broad
const ALT_BROAD2 = ['*queue.mjs *'];      // would admit claim/release/validate/scope-check — too broad

function showAltBroadness(label, allow) {
  const probe = `node ${P}/scripts/collab/queue.mjs claim x/y --session z`;
  const admits = permitted(probe, allow, allow);
  console.log(`  ${label}: admits "queue.mjs claim …"? ${admits ? 'YES (too broad — rejected)' : 'no'}`);
}

let ok = 0, bad = 0;
console.log(`PATTERN UNDER TEST: ${PATTERN}`);
console.log('='.repeat(100));
for (const [cmd, expect, label] of cases) {
  const got = permitted(cmd);
  const pass = got === expect;
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  expect ${expect ? 'ADMIT' : 'DENY '}  got ${got ? 'ADMIT' : 'DENY '}  | ${label}`);
  if (!pass) console.log(`        cmd: ${cmd}`);
}
console.log('='.repeat(100));
console.log('Narrowness comparison against rejected broader candidates:');
showAltBroadness('node *       ', ALT_BROAD1);
showAltBroadness('*queue.mjs * ', ALT_BROAD2);
console.log(`chosen *scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer: admits "queue.mjs claim …"? ${permitted(`node ${P}/scripts/collab/queue.mjs claim x/y --session z`) ? 'YES' : 'no'}`);
console.log('='.repeat(100));
console.log(`${ok} pass, ${bad} fail`);
process.exit(bad ? 1 : 0);
