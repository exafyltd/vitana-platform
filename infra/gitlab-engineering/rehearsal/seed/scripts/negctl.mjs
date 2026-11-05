// The three negative controls of plan eng-gitlab-m2, acceptance A2, run inside the CI job (docker container on a throw-away fleet machine).
// Each control proves something is NOT possible from a job, and prints one line `NEGCTL <name> PASS` or `NEGCTL <name> FAIL`, which
// scripts/eng/rehearse.mjs reads from the job trace:
//   imds         the instance metadata service (169.254.169.254) does not answer from a job container (IMDSv2 hop limit 1). Any HTTP
//                answer, whatever its status, is a FAIL: a job must not be able to ask the machine for its role credentials.
//   gitlab-host  the private address of the GitLab machine (rehearsal.config.json, written by rehearse.mjs) accepts no connection on
//                22, 80, 443 or 8080 from a job. GitLab is reached through its public name and the load balancer only.
//   aws-env      no environment variable of the job starts with AWS_ (a job holds no AWS credential).
// A control that cannot be made (no address configured) is a FAIL, never a quiet pass. The controls never change the exit code of the
// job: a FAIL must not stop the rest of the rehearsal; the report decides. Only variable NAMES are ever printed, never values.
// Dependency-free Node 20; the network is reached through stand-ins that tests pass in.
import http from 'node:http';
import net from 'node:net';

export const NAMES = Object.freeze(['imds', 'gitlab-host', 'aws-env']);
export const IMDS = Object.freeze({ host: '169.254.169.254', port: 80 });
export const HOST_PORTS = Object.freeze([22, 80, 443, 8080]);
export const DEFAULT_TIMEOUT_MS = 3000;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const code = (e) => String(e?.code ?? e?.name ?? 'error');

/** Did anything answer an HTTP request sent to host:port? Any status counts as an answer. → { answered, detail } */
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
    const timer = setTimeout(() => done({ answered: false, detail: `no answer within ${timeoutMs} ms` }), timeoutMs + 250);
    try {
      req = request({ host, port, method, path, headers, timeout: timeoutMs }, (res) => {
        res.resume();
        done({ answered: true, detail: `${method} ${path} answered HTTP ${res.statusCode}` });
      });
      req.on('timeout', () => done({ answered: false, detail: `no answer within ${timeoutMs} ms` }));
      req.on('error', (e) => done({ answered: false, detail: `${method} ${path} failed (${code(e)})` }));
      req.end();
    } catch (e) {
      done({ answered: false, detail: `${method} ${path} failed (${code(e)})` });
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

export async function checkImds({ timeoutMs = DEFAULT_TIMEOUT_MS, request, address = IMDS } = {}) {
  const probes = await Promise.all([
    httpProbe({ ...address, method: 'PUT', path: '/latest/api/token', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, timeoutMs, request }),
    httpProbe({ ...address, method: 'GET', path: '/latest/meta-data/', headers: {}, timeoutMs, request }),
  ]);
  const answered = probes.filter((p) => p.answered);
  if (answered.length > 0) return { name: 'imds', pass: false, detail: `the instance metadata service answered a job: ${answered.map((p) => p.detail).join('; ')}` };
  return { name: 'imds', pass: true, detail: `no answer from ${address.host}:${address.port} (${probes.map((p) => p.detail).join('; ')})` };
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

/** The three controls, in the order of NAMES. `config` is the parsed rehearsal.config.json ({} when absent). */
export async function runAll({ env = process.env, config = {}, timeoutMs = DEFAULT_TIMEOUT_MS, request, connect } = {}) {
  const [imds, host] = await Promise.all([
    checkImds({ timeoutMs, request }),
    checkGitlabHost({ ip: config.gitlabPrivateIp, timeoutMs, connect }),
  ]);
  return [imds, host, checkAwsEnv(env)];
}
