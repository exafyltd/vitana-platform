/**
 * VTID-05017: the gateway and kiro-runner images build from AWS's mirror of the
 * official Docker Hub library images (public.ecr.aws/docker/library), not from
 * Docker Hub. Anonymous Docker Hub pulls from shared GitHub runners hit its rate
 * limit (429) and auth outages (504), which stopped the staging deploy outright.
 * Every Dockerfile* in both service directories is checked, so a new one is too.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '../../..');
const DIRS = ['services/gateway', 'services/kiro-runner'];
const MIRROR = 'public.ecr.aws/docker/library/';

function dockerfiles(): string[] {
  return DIRS.flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => /^Dockerfile/.test(f)).map((f) => path.join(d, f)));
}

describe('base images come from the ECR Public mirror (VTID-05017)', () => {
  const files = dockerfiles();

  it('finds the four Dockerfiles', () => {
    expect(files.sort()).toEqual(expect.arrayContaining([
      'services/gateway/Dockerfile', 'services/gateway/Dockerfile.auto-logger', 'services/gateway/Dockerfile.job', 'services/kiro-runner/Dockerfile',
    ]));
  });

  it.each(dockerfiles())('%s: every FROM is the mirror or an earlier build stage', (file) => {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    const stages = new Set<string>();
    const froms = lines.map((l) => l.trim()).filter((l) => /^FROM\s/i.test(l));
    expect(froms.length).toBeGreaterThan(0);
    for (const line of froms) {
      const [, image, , alias] = line.split(/\s+/);
      const ok = image.startsWith(MIRROR) || stages.has(image);
      expect([file, line, ok]).toEqual([file, line, true]);
      if (alias) stages.add(alias);
    }
  });
});
