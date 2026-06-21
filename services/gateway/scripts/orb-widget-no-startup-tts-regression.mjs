#!/usr/bin/env node
/**
 * Regression: opening the ORB must not play a separate cached spoken wake cue.
 * The real Live Vitana voice owns all startup speech; the non-verbal activation
 * chime and disconnect/recovery alerts remain supported.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const widgetPath = resolve(repoRoot, 'services/gateway/src/frontend/command-hub/orb-widget.js');
const rendererPath = resolve(repoRoot, 'services/gateway/scripts/render-orb-alert-clips.ts');
const soundDir = resolve(repoRoot, 'services/gateway/src/frontend/command-hub/sounds/orb-alert');
const widget = readFileSync(widgetPath, 'utf8');
const renderer = readFileSync(rendererPath, 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`[orb-widget-no-startup-tts-regression] FAIL: ${message}`);
    process.exit(1);
  }
}

const forbiddenWidgetTokens = [
  'wakeCue',
  '_useWakeCue',
  '_wakeCueSrc',
  'wake-cue-en',
  'wake-cue-de',
];

for (const token of forbiddenWidgetTokens) {
  assert(!widget.includes(token), `orb-widget.js still contains startup TTS token: ${token}`);
}

assert(
  !renderer.includes("id: 'wake-cue-en'") && !renderer.includes("id: 'wake-cue-de'"),
  'render-orb-alert-clips.ts still renders startup wake-cue speech.',
);
assert(
  !renderer.includes("text: \"I'm here.\"") && !renderer.includes("text: 'Ich bin da.'"),
  'render-orb-alert-clips.ts still contains the hard-coded startup phrases.',
);
assert(
  !existsSync(resolve(soundDir, 'wake-cue-en.mp3')),
  'wake-cue-en.mp3 still exists and can be served by the gateway.',
);
assert(
  !existsSync(resolve(soundDir, 'wake-cue-de.mp3')),
  'wake-cue-de.mp3 still exists and can be served by the gateway.',
);

console.log('[orb-widget-no-startup-tts-regression] OK: startup speech belongs only to the real Live Vitana voice.');
