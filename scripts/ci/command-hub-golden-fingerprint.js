#!/usr/bin/env node
/**
 * VTID-0302: Command Hub Golden Fingerprint Check
 *
 * Validates that the built Command Hub bundle contains all required
 * golden markers. This prevents accidental replacement with older or
 * unrelated bundles during backend deployments.
 *
 * Required markers in dist/frontend/command-hub/app.js:
 * 1. VTID-0529-B or GOLDEN-COMMAND-HUB-V4 comment
 * 2. .task-board / .task-column / .task-card class names
 * 3. ORB mount point (orb-idle class)
 * 4. Header toolbar container (.header-toolbar)
 */

const fs = require('fs');
const path = require('path');

// Markers that MUST be present in the golden bundle
const REQUIRED_MARKERS = [
  {
    name: 'Golden VTID marker',
    pattern: /VTID-0529-B|GOLDEN-COMMAND-HUB-V4/,
    description: 'Bundle must contain VTID-0529-B or GOLDEN-COMMAND-HUB-V4 marker'
  },
  {
    name: 'Task Board class',
    pattern: /['"]task-board['"]/,
    description: 'Bundle must contain .task-board class name'
  },
  {
    name: 'Task Column class',
    pattern: /['"]task-column['"]/,
    description: 'Bundle must contain .task-column class name'
  },
  {
    name: 'Task Card class',
    pattern: /['"]task-card['"]/,
    description: 'Bundle must contain .task-card class name'
  },
  {
    name: 'ORB idle element',
    pattern: /orb-idle/,
    description: 'Bundle must contain ORB idle element (orb-idle class)'
  },
  {
    name: 'Header toolbar',
    pattern: /['"]header-toolbar['"]/,
    description: 'Bundle must contain header toolbar container'
  }
];

function main() {
  console.log('==========================================');
  console.log('VTID-0302: Command Hub Golden Fingerprint');
  console.log('==========================================');
  console.log('');

  // Determine the path to check
  const repoRoot = process.env.GITHUB_WORKSPACE ||
                   process.cwd().replace(/\/services\/gateway$/, '');

  const bundlePath = path.join(repoRoot, 'services/gateway/dist/frontend/command-hub/app.js');

  console.log(`Checking: ${bundlePath}`);
  console.log('');

  // Check if bundle exists
  if (!fs.existsSync(bundlePath)) {
    console.error('ERROR: Command Hub bundle not found!');
    console.error(`Expected at: ${bundlePath}`);
    console.error('');
    console.error('Make sure to run `npm run build` in services/gateway before this check.');
    process.exit(1);
  }

  // Read bundle content
  const bundleContent = fs.readFileSync(bundlePath, 'utf-8');
  console.log(`Bundle size: ${(bundleContent.length / 1024).toFixed(1)} KB`);
  console.log('');

  // Check each marker
  const results = [];
  let allPassed = true;

  console.log('Checking required markers:');
  console.log('');

  for (const marker of REQUIRED_MARKERS) {
    const found = marker.pattern.test(bundleContent);
    results.push({ ...marker, found });

    if (found) {
      console.log(`  FOUND: ${marker.name}`);
    } else {
      console.log(`  MISSING: ${marker.name}`);
      allPassed = false;
    }
  }

  console.log('');

  if (allPassed) {
    console.log('All golden markers verified.');
    console.log('Fingerprint check PASSED.');
    process.exit(0);
  }

  // Report failures
  console.error('ERROR: Golden fingerprint check FAILED!');
  console.error('');
  console.error('The Command Hub bundle is missing required markers.');
  console.error('This may indicate the bundle was replaced with an older version.');
  console.error('');
  console.error('Missing markers:');
  results
    .filter(r => !r.found)
    .forEach(r => {
      console.error(`  - ${r.name}: ${r.description}`);
    });
  console.error('');
  console.error('To fix:');
  console.error('1. Ensure you are working from a fresh branch based on latest main');
  console.error('2. Do not replace Command Hub frontend files with older versions');
  console.error('3. If this is a DEV-COMHU VTID making intentional changes,');
  console.error('   ensure all golden markers are preserved');
  console.error('');
  process.exit(1);
}

main();
