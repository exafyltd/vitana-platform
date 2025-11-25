#!/usr/bin/env node
/**
 * DEV-CICDL-0205: Dev Frontend Spec Validator
 *
 * Enforces the canonical 17-module / 87-screen Developer navigation spec.
 * If ANY deviation is found, this script exits with code 1 and blocks CI/deploy.
 *
 * Usage: node ./scripts/validate-dev-frontend-spec.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SPEC_PATH = path.resolve(__dirname, '../specs/dev_screen_inventory_v1.json');
const CONFIG_PATH = path.resolve(__dirname, '../src/frontend/command-hub/navigationConfig.js');

function fail(message, details = null) {
  console.error('');
  console.error('═══════════════════════════════════════════════════════════════════');
  console.error('❌ FRONTEND SPEC VIOLATION DETECTED');
  console.error('═══════════════════════════════════════════════════════════════════');
  console.error('');
  console.error(message);
  console.error('');
  if (details) {
    console.error('Details:');
    console.error(JSON.stringify(details, null, 2));
    console.error('');
  }
  console.error('───────────────────────────────────────────────────────────────────');
  console.error('You violated the canonical Dev navigation spec (17 modules / 87 screens).');
  console.error('');
  console.error('DO NOT PATCH THIS BROKEN NAVIGATION.');
  console.error('Throw away this variant and rebuild from the official OASIS spec.');
  console.error('───────────────────────────────────────────────────────────────────');
  console.error('');
  process.exit(1);
}

async function main() {
  console.log('');
  console.log('🔍 DEV-CICDL-0205: Validating Dev Frontend Navigation Spec...');
  console.log('');

  // 1. Load spec file
  if (!fs.existsSync(SPEC_PATH)) {
    fail(`Spec file not found at: ${SPEC_PATH}`);
  }

  let spec;
  try {
    const specRaw = fs.readFileSync(SPEC_PATH, 'utf8');
    spec = JSON.parse(specRaw);
  } catch (err) {
    fail(`Failed to parse spec file: ${err.message}`);
  }

  // 2. Load navigation config
  if (!fs.existsSync(CONFIG_PATH)) {
    fail(`Navigation config not found at: ${CONFIG_PATH}`);
  }

  let NAVIGATION_CONFIG;
  try {
    const configModule = await import(CONFIG_PATH);
    NAVIGATION_CONFIG = configModule.NAVIGATION_CONFIG;
  } catch (err) {
    fail(`Failed to import navigationConfig.js: ${err.message}`);
  }

  if (!Array.isArray(NAVIGATION_CONFIG)) {
    fail('NAVIGATION_CONFIG must be an array of module objects.');
  }

  // 3. Extract expected values from spec
  const expectedModules = spec.sidebar_navigation;
  const expectedModuleCatalog = spec.module_catalog;
  const expectedTotalScreens = spec.screen_inventory.total_screens;

  // 4. Validate sidebar modules (exact order, exact count)
  const actualModules = NAVIGATION_CONFIG.map(m => m.module);

  if (actualModules.length !== expectedModules.length) {
    fail(`Module count mismatch: expected ${expectedModules.length}, got ${actualModules.length}`, {
      expected: expectedModules,
      actual: actualModules
    });
  }

  for (let i = 0; i < expectedModules.length; i++) {
    if (actualModules[i] !== expectedModules[i]) {
      fail(`Module at position ${i} mismatch: expected "${expectedModules[i]}", got "${actualModules[i]}"`, {
        expectedOrder: expectedModules,
        actualOrder: actualModules
      });
    }
  }

  // 5. Validate tabs for each module
  let actualTotalScreens = 0;
  const tabErrors = [];

  for (const moduleName of expectedModules) {
    const configEntry = NAVIGATION_CONFIG.find(m => m.module === moduleName);

    if (!configEntry) {
      tabErrors.push({ module: moduleName, error: 'Module missing from NAVIGATION_CONFIG' });
      continue;
    }

    const expectedTabs = expectedModuleCatalog[moduleName] || [];
    const actualTabs = (configEntry.tabs || []).map(t => t.key);

    actualTotalScreens += actualTabs.length;

    if (actualTabs.length !== expectedTabs.length) {
      tabErrors.push({
        module: moduleName,
        error: 'Tab count mismatch',
        expectedCount: expectedTabs.length,
        actualCount: actualTabs.length,
        expectedTabs,
        actualTabs
      });
      continue;
    }

    for (let i = 0; i < expectedTabs.length; i++) {
      if (actualTabs[i] !== expectedTabs[i]) {
        tabErrors.push({
          module: moduleName,
          error: `Tab at position ${i} mismatch`,
          expectedTab: expectedTabs[i],
          actualTab: actualTabs[i],
          expectedTabs,
          actualTabs
        });
        break;
      }
    }
  }

  if (tabErrors.length > 0) {
    fail('One or more modules have incorrect tab configuration.', { tabErrors });
  }

  // 6. Validate total screen count
  if (actualTotalScreens !== expectedTotalScreens) {
    fail(`Total screen count mismatch: expected ${expectedTotalScreens}, got ${actualTotalScreens}`, {
      expectedTotalScreens,
      actualTotalScreens
    });
  }

  // 7. Success
  console.log('✅ FRONTEND SPEC OK');
  console.log(`   ├─ Modules: ${actualModules.length} (expected: ${expectedModules.length})`);
  console.log(`   ├─ Screens: ${actualTotalScreens} (expected: ${expectedTotalScreens})`);
  console.log(`   └─ Order: Canonical`);
  console.log('');
  process.exit(0);
}

main().catch(err => {
  fail(`Unexpected error: ${err.message}`);
});
