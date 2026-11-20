/**
 * VTID-05328 (ci-ecr-public-auth): every deploy job that builds a Dockerfile whose base image comes from
 * public.ecr.aws logs in to ECR Public first. Anonymous public.ecr.aws pulls from shared GitHub runner IPs hit the
 * 500 GB/month data cap ("429 Too Many Requests / Data limit exceeded", run 39421081117); an authenticated pull is
 * not subject to it. The login is fail-soft (warn + anonymous fallback), so the guard also pins the `else` branch.
 *
 * The guard grows on its own: any AWS-*-DEPLOY-*.yml job that `docker build`s a public.ecr.aws Dockerfile is checked.
 */
import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.join(__dirname, '../../..');
const WF_DIR = path.join(ROOT, '.github/workflows');
const LOGIN_NEEDLES = ['aws ecr-public get-login-password --region us-east-1', 'docker login', 'public.ecr.aws'];

interface Step { name?: string; uses?: string; run?: string; if?: string }
interface Job { steps?: Step[] }

/** The Dockerfile a `docker build` line builds: `-f <file>` (relative to the cwd) or `<context>/Dockerfile`. */
function dockerfileOf(run: string): string[] {
  let cwd = '.';
  const out: string[] = [];
  for (const raw of run.split('\n')) {
    const line = raw.trim();
    const cd = /^cd\s+(\S+)/.exec(line);
    if (cd) cwd = path.join(cwd, cd[1]);
    const i = line.indexOf('docker build');
    if (i < 0) continue;
    const tokens = line.slice(i).split(/\s+/).filter(Boolean);
    const f = tokens.indexOf('-f');
    const context = tokens[tokens.length - 1];
    out.push(f >= 0 ? path.join(cwd, tokens[f + 1]) : path.join(cwd, context, 'Dockerfile'));
  }
  return out;
}

function usesEcrPublic(dockerfile: string): boolean {
  const p = path.join(ROOT, dockerfile);
  if (!fs.existsSync(p)) return false;
  return fs.readFileSync(p, 'utf8').split('\n').some((l) => /^\s*FROM\s+(--\S+\s+)*public\.ecr\.aws\//i.test(l));
}

interface Checked { id: string; steps: Step[]; firstBuild: number }

function checkedJobs(): Checked[] {
  const files = fs.readdirSync(WF_DIR).filter((f) => /^AWS-.*-DEPLOY-.*\.yml$/.test(f)).sort();
  const out: Checked[] = [];
  for (const file of files) {
    const doc = yaml.load(fs.readFileSync(path.join(WF_DIR, file), 'utf8')) as { jobs?: Record<string, Job> };
    for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
      const steps = job.steps ?? [];
      const builds = steps
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => typeof s.run === 'string' && s.run.includes('docker build'))
        .filter(({ s }) => dockerfileOf(s.run as string).some(usesEcrPublic));
      if (builds.length) out.push({ id: `${file}:${jobId}`, steps, firstBuild: builds[0].i });
    }
  }
  return out;
}

describe('ECR Public login before public.ecr.aws builds (VTID-05328)', () => {
  const jobs = checkedJobs();

  it('checks every platform job that builds a public.ecr.aws Dockerfile', () => {
    expect(jobs.map((j) => j.id)).toEqual(expect.arrayContaining([
      'AWS-STAGE-DEPLOY-GATEWAY.yml:build-push-deploy',
      'AWS-PROD-DEPLOY-GATEWAY.yml:build-push-deploy',
      'AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml:build-push-register',
      'AWS-STAGE-DEPLOY-KIRO-RUNNER.yml:build',
      'AWS-STAGE-DEPLOY-KIRO-RUNNER.yml:build-push-deploy',
    ]));
  });

  it.each(jobs.map((j) => [j.id, j] as const))('%s: fail-soft ECR Public login after credentials, before the build', (_id, job) => {
    const login = job.steps.findIndex((s) => typeof s.run === 'string' && LOGIN_NEEDLES.every((n) => (s.run as string).includes(n)));
    const creds = job.steps.findIndex((s) => typeof s.uses === 'string' && s.uses.startsWith('aws-actions/configure-aws-credentials'));
    expect({ job: job.id, hasLogin: login >= 0 }).toEqual({ job: job.id, hasLogin: true });
    expect({ job: job.id, loginBeforeBuild: login < job.firstBuild }).toEqual({ job: job.id, loginBeforeBuild: true });
    expect({ job: job.id, loginAfterCreds: creds < 0 || login > creds }).toEqual({ job: job.id, loginAfterCreds: true });
    const run = job.steps[login].run as string;
    expect({ job: job.id, failSoft: /\n\s*else\n/.test(run) && run.includes('::warning') }).toEqual({ job: job.id, failSoft: true });
  });
});
