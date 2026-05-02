/**
 * Three-way diff: spec.json ↔ extracted/vertex.json ↔ extracted/livekit.json.
 * Output: extracted/diff.json + a markdown summary on stdout.
 *
 * Six drift categories produced:
 *   missing_in_vertex       — spec declares it, Vertex source doesn't
 *   missing_in_livekit      — spec declares it, LiveKit source doesn't
 *   value_mismatch          — same name, different values (watchdogs)
 *   undeclared              — implementation has it, spec doesn't
 *   signature_mismatch      — system_instruction_signatures diverge
 *   static_runtime_drift    — (placeholder for runtime self-report layer)
 *
 * Run: npm run diff
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(__dirname, '..', 'spec.json');
const VERTEX = resolve(__dirname, '..', 'extracted', 'vertex.json');
const LIVEKIT = resolve(__dirname, '..', 'extracted', 'livekit.json');
const OUT = resolve(__dirname, '..', 'extracted', 'diff.json');

interface Spec {
  tools: { name: string; implementations: string[]; safety_critical: boolean; owner_vtid?: string | null }[];
  oasis_topics: { topic: string; implementations: string[] }[];
  watchdogs: { name: string; value: number; implementations: string[] }[];
  system_instruction_params: { authenticated_signature: string[]; anonymous_signature: string[] };
}

interface Extracted {
  source: string;
  extracted_at: string;
  status?: string;
  tools: { name: string }[];
  oasis_topics: { topic: string }[];
  watchdogs: { name: string; value: number }[];
  system_instruction_signatures: { authenticated: string[] | null; anonymous: string[] | null };
}

interface DriftEntry {
  category:
    | 'missing_in_vertex'
    | 'missing_in_livekit'
    | 'value_mismatch'
    | 'undeclared'
    | 'signature_mismatch';
  kind: 'tool' | 'oasis_topic' | 'watchdog' | 'system_instruction';
  name: string;
  detail?: string;
  severity: 'safety_critical' | 'high' | 'low';
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function diff(spec: Spec, vertex: Extracted, livekit: Extracted): DriftEntry[] {
  const entries: DriftEntry[] = [];

  // Tools
  const vertexToolNames = new Set(vertex.tools.map((t) => t.name));
  const livekitToolNames = new Set(livekit.tools.map((t) => t.name));
  const specToolNames = new Set(spec.tools.map((t) => t.name));
  const safetyCriticalNames = new Set(spec.tools.filter((t) => t.safety_critical).map((t) => t.name));

  for (const t of spec.tools) {
    const sev: DriftEntry['severity'] = t.safety_critical ? 'safety_critical' : 'high';
    if (t.implementations.includes('vertex') && !vertexToolNames.has(t.name)) {
      entries.push({ category: 'missing_in_vertex', kind: 'tool', name: t.name, severity: sev });
    }
    if (t.implementations.includes('livekit') && !livekitToolNames.has(t.name) && livekit.status !== 'not_yet_implemented') {
      entries.push({ category: 'missing_in_livekit', kind: 'tool', name: t.name, severity: sev });
    }
  }
  for (const name of vertexToolNames) {
    if (!specToolNames.has(name)) {
      entries.push({
        category: 'undeclared',
        kind: 'tool',
        name,
        detail: 'Vertex implements this tool but spec.json does not declare it. Add to spec.',
        severity: safetyCriticalNames.has(name) ? 'safety_critical' : 'low',
      });
    }
  }
  for (const name of livekitToolNames) {
    if (!specToolNames.has(name)) {
      entries.push({
        category: 'undeclared',
        kind: 'tool',
        name,
        detail: 'LiveKit implements this tool but spec.json does not declare it. Add to spec.',
        severity: 'low',
      });
    }
  }

  // OASIS topics
  const vertexTopics = new Set(vertex.oasis_topics.map((t) => t.topic));
  const livekitTopics = new Set(livekit.oasis_topics.map((t) => t.topic));
  const specTopics = new Set(spec.oasis_topics.map((t) => t.topic));

  for (const t of spec.oasis_topics) {
    if (t.implementations.includes('vertex') && !vertexTopics.has(t.topic)) {
      entries.push({ category: 'missing_in_vertex', kind: 'oasis_topic', name: t.topic, severity: 'high' });
    }
    if (t.implementations.includes('livekit') && !livekitTopics.has(t.topic) && livekit.status !== 'not_yet_implemented') {
      entries.push({ category: 'missing_in_livekit', kind: 'oasis_topic', name: t.topic, severity: 'high' });
    }
  }
  for (const topic of vertexTopics) {
    if (!specTopics.has(topic)) {
      entries.push({ category: 'undeclared', kind: 'oasis_topic', name: topic, severity: 'low' });
    }
  }
  for (const topic of livekitTopics) {
    if (!specTopics.has(topic)) {
      entries.push({ category: 'undeclared', kind: 'oasis_topic', name: topic, severity: 'low' });
    }
  }

  // Watchdogs (value-equality matters)
  const vertexWds = new Map(vertex.watchdogs.map((w) => [w.name, w.value]));
  const livekitWds = new Map(livekit.watchdogs.map((w) => [w.name, w.value]));
  const specWdMap = new Map(spec.watchdogs.map((w) => [w.name, w.value]));

  for (const w of spec.watchdogs) {
    if (w.implementations.includes('vertex')) {
      const v = vertexWds.get(w.name);
      if (v === undefined) {
        entries.push({ category: 'missing_in_vertex', kind: 'watchdog', name: w.name, severity: 'high' });
      } else if (v !== w.value) {
        entries.push({
          category: 'value_mismatch',
          kind: 'watchdog',
          name: w.name,
          detail: `spec=${w.value}, vertex=${v}`,
          severity: 'high',
        });
      }
    }
    if (w.implementations.includes('livekit') && livekit.status !== 'not_yet_implemented') {
      const v = livekitWds.get(w.name);
      if (v === undefined) {
        entries.push({ category: 'missing_in_livekit', kind: 'watchdog', name: w.name, severity: 'high' });
      } else if (v !== w.value) {
        entries.push({
          category: 'value_mismatch',
          kind: 'watchdog',
          name: w.name,
          detail: `spec=${w.value}, livekit=${v}`,
          severity: 'high',
        });
      }
    }
  }
  for (const [name, value] of vertexWds) {
    if (!specWdMap.has(name)) {
      entries.push({
        category: 'undeclared',
        kind: 'watchdog',
        name,
        detail: `vertex value=${value}`,
        severity: 'low',
      });
    }
  }

  // System instruction signatures
  const expectedAuth = spec.system_instruction_params.authenticated_signature;
  const expectedAnon = spec.system_instruction_params.anonymous_signature;

  if (vertex.system_instruction_signatures.authenticated) {
    if (!arraysEqual(vertex.system_instruction_signatures.authenticated, expectedAuth)) {
      entries.push({
        category: 'signature_mismatch',
        kind: 'system_instruction',
        name: 'authenticated_signature (vertex)',
        detail: `spec=${JSON.stringify(expectedAuth)} vertex=${JSON.stringify(vertex.system_instruction_signatures.authenticated)}`,
        severity: 'safety_critical',
      });
    }
  }
  if (vertex.system_instruction_signatures.anonymous) {
    if (!arraysEqual(vertex.system_instruction_signatures.anonymous, expectedAnon)) {
      entries.push({
        category: 'signature_mismatch',
        kind: 'system_instruction',
        name: 'anonymous_signature (vertex)',
        detail: `spec=${JSON.stringify(expectedAnon)} vertex=${JSON.stringify(vertex.system_instruction_signatures.anonymous)}`,
        severity: 'safety_critical',
      });
    }
  }
  if (livekit.system_instruction_signatures.authenticated && livekit.status !== 'not_yet_implemented') {
    if (!arraysEqual(livekit.system_instruction_signatures.authenticated, expectedAuth)) {
      entries.push({
        category: 'signature_mismatch',
        kind: 'system_instruction',
        name: 'authenticated_signature (livekit)',
        detail: `spec=${JSON.stringify(expectedAuth)} livekit=${JSON.stringify(livekit.system_instruction_signatures.authenticated)}`,
        severity: 'safety_critical',
      });
    }
  }

  return entries;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function renderMarkdown(drifts: DriftEntry[], vertex: Extracted, livekit: Extracted): string {
  const lines: string[] = [];
  lines.push('## Voice Pipeline Parity Scan');
  lines.push('');
  lines.push(`- vertex extracted at: \`${vertex.extracted_at}\``);
  lines.push(
    `- livekit status: \`${livekit.status ?? 'extracted'}\`` +
      (livekit.status === 'not_yet_implemented'
        ? ' (orb-agent service not present yet — LiveKit-side checks are no-op)'
        : ''),
  );
  lines.push('');

  if (drifts.length === 0) {
    lines.push('**No drift detected.** Spec, Vertex source, and LiveKit source are in sync.');
    return lines.join('\n') + '\n';
  }

  const bySeverity = {
    safety_critical: drifts.filter((d) => d.severity === 'safety_critical'),
    high: drifts.filter((d) => d.severity === 'high'),
    low: drifts.filter((d) => d.severity === 'low'),
  };
  lines.push(
    `**${drifts.length} drift item(s)** ` +
      `(safety_critical: ${bySeverity.safety_critical.length}, ` +
      `high: ${bySeverity.high.length}, ` +
      `low: ${bySeverity.low.length})`,
  );
  lines.push('');
  lines.push('Note: this scanner is **report-only** today. It does not block merges yet.');
  lines.push('');
  lines.push('| Severity | Category | Kind | Name | Detail |');
  lines.push('|---|---|---|---|---|');
  for (const d of drifts) {
    lines.push(`| ${d.severity} | ${d.category} | ${d.kind} | \`${d.name}\` | ${d.detail ?? ''} |`);
  }
  return lines.join('\n') + '\n';
}

function main(): void {
  const spec = readJson<Spec>(SPEC);
  const vertex = readJson<Extracted>(VERTEX);
  const livekit = readJson<Extracted>(LIVEKIT);

  const drifts = diff(spec, vertex, livekit);

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        drift_count: drifts.length,
        by_severity: {
          safety_critical: drifts.filter((d) => d.severity === 'safety_critical').length,
          high: drifts.filter((d) => d.severity === 'high').length,
          low: drifts.filter((d) => d.severity === 'low').length,
        },
        drifts,
      },
      null,
      2,
    ) + '\n',
  );

  const md = renderMarkdown(drifts, vertex, livekit);
  console.log(md);
}

main();
