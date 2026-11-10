// The three negative controls of plan eng-gitlab-m2, acceptance A2, run inside the CI job (docker container on a throw-away fleet machine).
// Each control proves something is NOT possible from a job, and prints one line `NEGCTL <name> PASS` or `NEGCTL <name> FAIL`, which
// scripts/eng/rehearse.mjs reads from the job trace (the line before it, `negctl: <name>: <detail>`, says why and is shown in the report):
//   imds         no metadata token is issued to the job container and a plain read of the instance metadata service (169.254.169.254)
//                returns no data. FAIL only when the token request (PUT /latest/api/token) answers 2xx, that is a token was issued, or the
//                read without a token (GET /latest/meta-data/) answers 2xx. A timeout, a connection error, 401 and 403 are PASS: with tokens
//                required and hop limit 1 the answer to the token request never reaches the container and AWS answers a read without a
//                token with 401, which is the protection working. The statuses seen are printed. The body of an answer is never read.
//   gitlab-host  the private address of the GitLab machine (rehearsal.config.json, written by rehearse.mjs) accepts no connection on
//                22, 80, 443 or 8080 from a job. GitLab is reached through its public name and the load balancer only.
//   aws-env      no environment variable of the job starts with AWS_ (a job holds no AWS credential).
// A control that cannot be made (no address configured) is a FAIL, never a quiet pass. The controls never change the exit code of the
// job: a FAIL must not stop the rest of the rehearsal; the report decides. Only variable NAMES are ever printed, never values.
// A baseline, information only: `NEGCTL-INFO baseline gitlab: reachable|not reachable|not checked (...)` says whether the job can open a
// connection to GitLab (the host and port of CI_SERVER_URL) at all, so that a container with no network is not mistaken for isolation.
// It is not a control, has its own line prefix, and changes neither a control line nor the exit code.
// Dependency-free Node 20; the network is reached through stand-ins that tests pass in.
import http from 'node:http';
import net from 'node:net';

export const NAMES = Object.freeze(['imds', 'gitlab-host', 'aws-env']);
export const IMDS = Object.freeze({ host: '169.254.169.254', port: 80 });
export const HOST_PORTS = Object.freeze([22, 80, 443, 8080]);
export const DEFAULT_TIMEOUT_MS = 3000;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const code = (e) => String(e?.code ?? e?.name ?? 'error');

/**
 * One HTTP request to host:port. → { status, detail }: `status` is the HTTP status, or null when nothing answered (a timeout or an error).
 * The body of an answer is discarded unread, so a token in it is never kept or printed.
 */
export function httpProbe({ host, port, method, path, headers = {}, timeoutMs, request = http.request }) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req?.destroy(); } catch { /* already gone */ }
      resolve(value);
    };
    const silent = () => done({ status: null, detail: `${method} ${path}: no answer within ${timeoutMs} ms` });
    const timer = setTimeout(silent, timeoutMs + 250);
    try {
      req = request({ host, port, method, path, headers, timeout: timeoutMs }, (res) => {
        res.resume();
        done({ status: res.statusCode, detail: `${method} ${path}: HTTP ${res.statusCode}` });
      });
      req.on('timeout', silent);
      req.on('error', (e) => done({ status: null, detail: `${method} ${path}: failed (${code(e)})` }));
      req.end();
    } catch (e) {
      done({ status: null, detail: `${method} ${path}: failed (${code(e)})` });
    }
  });
}

/** Does host:port accept a TCP connection? → { connected, detail } */
export function tcpProbe({ host, port, timeoutMs, connect = net.connect }) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => done({ connected: false, detail: `${port}: no connection within ${timeoutMs} ms` }), timeoutMs);
    try {
      socket = connect({ host, port });
      socket.on('connect', () => done({ connected: true, detail: `${port}: connected` }));
      socket.on('error', (e) => done({ connected: false, detail: `${port}: ${code(e)}` }));
    } catch (e) {
      done({ connected: false, detail: `${port}: ${code(e)}` });
    }
  });
}

const is2xx = (probe) => Number.isInteger(probe.status) && probe.status >= 200 && probe.status < 300;

export async function checkImds({ timeoutMs = DEFAULT_TIMEOUT_MS, request, address = IMDS } = {}) {
  const [token, read] = await Promise.all([
    httpProbe({ ...address, method: 'PUT', path: '/latest/api/token', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, timeoutMs, request }),
    httpProbe({ ...address, method: 'GET', path: '/latest/meta-data/', headers: {}, timeoutMs, request }),
  ]);
  const seen = `${token.detail}; ${read.detail}`;
  const leaks = [];
  if (is2xx(token)) leaks.push('a metadata token was issued');
  if (is2xx(read)) leaks.push('metadata was read without a token');
  if (leaks.length > 0) return { name: 'imds', pass: false, detail: `${leaks.join(' and ')} to a job (${seen})` };
  return { name: 'imds', pass: true, detail: `no token and no data reached a job (${seen})` };
}

export async function checkGitlabHost({ ip, ports = HOST_PORTS, timeoutMs = DEFAULT_TIMEOUT_MS, connect } = {}) {
  if (typeof ip !== 'string' || !IPV4.test(ip)) return { name: 'gitlab-host', pass: false, detail: 'no address of the GitLab machine is configured (rehearsal.config.json), so nothing was proven' };
  const probes = await Promise.all(ports.map((port) => tcpProbe({ host: ip, port, timeoutMs, connect })));
  const open = probes.filter((p) => p.connected);
  if (open.length > 0) return { name: 'gitlab-host', pass: false, detail: `the GitLab machine ${ip} accepted a connection from a job: ${open.map((p) => p.detail).join(', ')}` };
  return { name: 'gitlab-host', pass: true, detail: `${ip} accepted no connection (${probes.map((p) => p.detail).join('; ')})` };
}

export function checkAwsEnv(env = process.env) {
  const names = Object.keys(env).filter((k) => /^AWS_/.test(k)).sort();
  if (names.length > 0) return { name: 'aws-env', pass: false, detail: `the job environment has AWS variable(s): ${names.join(', ')}` };
  return { name: 'aws-env', pass: true, detail: 'no variable starting with AWS_ in the job environment' };
}

export const formatLine = ({ name, pass }) => `NEGCTL ${name} ${pass ? 'PASS' : 'FAIL'}`;

/**
 * The baseline, information only (never a control): can this job open a TCP connection to GitLab, at the host and port of CI_SERVER_URL?
 * → { name: 'gitlab', state: 'reachable' | 'not reachable' | 'not checked', detail }. Only the host and the port are named, never the URL.
 */
export async function checkBaseline({ env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, connect } = {}) {
  const raw = typeof env.CI_SERVER_URL === 'string' ? env.CI_SERVER_URL.trim() : '';
  if (raw === '') return { name: 'gitlab', state: 'not checked', detail: 'CI_SERVER_URL is not set' };
  let target = null;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (/^https?:$/.test(url.protocol) && host !== '') target = { host, port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80 };
  } catch { /* not a URL */ }
  if (target === null) return { name: 'gitlab', state: 'not checked', detail: 'CI_SERVER_URL is not an http(s) URL' };
  const probe = await tcpProbe({ ...target, timeoutMs, connect });
  const where = `${target.host}:${target.port}`;
  if (probe.connected) return { name: 'gitlab', state: 'reachable', detail: `${where} accepted a connection` };
  return { name: 'gitlab', state: 'not reachable', detail: `${where} ${probe.detail.replace(/^\d+: /, '')}` };
}

export const formatInfo = ({ name, state, detail }) => `NEGCTL-INFO baseline ${name}: ${state} (${detail})`;

/** The three controls, in the order of NAMES. `config` is the parsed rehearsal.config.json ({} when absent). */
export async function runAll({ env = process.env, config = {}, timeoutMs = DEFAULT_TIMEOUT_MS, request, connect } = {}) {
  const [imds, host] = await Promise.all([
    checkImds({ timeoutMs, request }),
    checkGitlabHost({ ip: config.gitlabPrivateIp, timeoutMs, connect }),
  ]);
  return [imds, host, checkAwsEnv(env)];
}
