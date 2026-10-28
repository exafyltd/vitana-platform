/**
 * Artifact collection for device-level runs: screenshots, screen outlines,
 * and a machine-readable summary. CI uploads the whole directory.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class RunReport {
  constructor(outDir) {
    this.outDir = outDir;
    this.steps = [];
    this.startedAt = new Date().toISOString();
    mkdirSync(outDir, { recursive: true });
  }

  stepName(label) {
    const n = String(this.steps.length + 1).padStart(2, '0');
    return `${n}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  }

  screenshotPath(label) {
    return join(this.outDir, `${this.stepName(label)}.png`);
  }

  /** Record one observe/act step, persisting the outline alongside. */
  record({ label, ok, outline, screenshot, detail }) {
    const name = this.stepName(label);
    if (outline) writeFileSync(join(this.outDir, `${name}.outline.txt`), outline + '\n');
    this.steps.push({ name, label, ok, screenshot, detail, at: new Date().toISOString() });
    const mark = ok ? '✓' : '✗';
    console.error(`${mark} ${label}${detail ? ` — ${detail}` : ''}`);
  }

  finish({ device, platform, url }) {
    const failed = this.steps.filter(s => !s.ok);
    const summary = {
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      device,
      platform,
      url,
      total: this.steps.length,
      failed: failed.length,
      steps: this.steps,
    };
    writeFileSync(join(this.outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.error(
      `\nRun complete: ${summary.total - summary.failed}/${summary.total} steps ok. ` +
      `Artifacts in ${this.outDir}`,
    );
    return summary;
  }
}
