/**
 * Validates voice-pipeline-spec/spec.json against an inline schema.
 * Run: npm run validate-spec
 *
 * Catches malformed entries (missing required fields, bad enum values) before
 * the scanner runs. Cheap, fast, fails CI loudly if someone hand-edits spec.json
 * incorrectly.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, '..', 'spec.json');

const META_SCHEMA = {
  type: 'object',
  required: ['version', 'tools', 'oasis_topics', 'watchdogs', 'system_instruction_params'],
  additionalProperties: true,
  properties: {
    version: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'implementations', 'safety_critical'],
        additionalProperties: true,
        properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
          implementations: {
            type: 'array',
            items: { enum: ['vertex', 'livekit'] },
            minItems: 1,
            uniqueItems: true,
          },
          safety_critical: { type: 'boolean' },
          owner_vtid: { type: ['string', 'null'] },
          notes: { type: 'string' },
        },
      },
    },
    oasis_topics: {
      type: 'array',
      items: {
        type: 'object',
        required: ['topic', 'implementations'],
        additionalProperties: true,
        properties: {
          topic: { type: 'string', pattern: '^[a-z][a-z0-9_.]*[a-z0-9_]$' },
          implementations: {
            type: 'array',
            items: { enum: ['vertex', 'livekit'] },
            minItems: 1,
          },
        },
      },
    },
    watchdogs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'value', 'implementations'],
        additionalProperties: true,
        properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
          value: { type: 'number' },
          description: { type: 'string' },
          implementations: { type: 'array', items: { enum: ['vertex', 'livekit'] } },
        },
      },
    },
    system_instruction_params: {
      type: 'object',
      required: ['authenticated_signature', 'anonymous_signature'],
      properties: {
        authenticated_signature: { type: 'array', items: { type: 'string' }, minItems: 1 },
        anonymous_signature: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
    },
  },
};

function main(): void {
  const raw = readFileSync(SPEC_PATH, 'utf-8');
  let spec: unknown;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    console.error('spec.json is not valid JSON:', (e as Error).message);
    process.exit(1);
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(META_SCHEMA);
  const ok = validate(spec);

  if (!ok) {
    console.error('spec.json failed validation:');
    for (const err of validate.errors ?? []) {
      console.error(`  ${err.instancePath || '(root)'} ${err.message}`);
    }
    process.exit(1);
  }

  const s = spec as { tools: { name: string }[]; oasis_topics: { topic: string }[] };
  const dupTools = findDuplicates(s.tools.map((t) => t.name));
  const dupTopics = findDuplicates(s.oasis_topics.map((t) => t.topic));
  if (dupTools.length || dupTopics.length) {
    if (dupTools.length) console.error('Duplicate tool names:', dupTools);
    if (dupTopics.length) console.error('Duplicate OASIS topics:', dupTopics);
    process.exit(1);
  }

  console.log(
    `spec.json OK — ${s.tools.length} tools, ${s.oasis_topics.length} topics, ${(spec as { watchdogs: unknown[] }).watchdogs.length} watchdogs.`,
  );
}

function findDuplicates<T>(arr: T[]): T[] {
  const seen = new Set<T>();
  const dup = new Set<T>();
  for (const x of arr) {
    if (seen.has(x)) dup.add(x);
    seen.add(x);
  }
  return [...dup];
}

main();
