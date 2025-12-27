#!/usr/bin/env node
/**
 * VTID-0302: Command Hub Path Ownership Guard
 *
 * Command Hub frontend edits are reserved for DEV-COMHU-* VTIDs only.
 * All other tasks must treat this zone as read-only.
 *
 * This script checks if a PR modifies Command Hub frontend files without
 * having a DEV-COMHU marker in the branch name or PR title.
 */

const { execSync } = require('child_process');
const path = require('path');

const PROTECTED_PATH = 'services/gateway/src/frontend/command-hub/';
// VTID-0302: Original guard VTID
// VTID-0539: Operator Console Chat Experience Improvements
// VTID-0541: OASIS + CI/CD Alignment Repair (includes Publish modal semantics fix)
// VTID-0542: Global VTID Allocator + 3-Path Cutover (includes +Task modal allocator wiring)
//            Branch pattern: global-vtid-allocator (for claude/global-vtid-allocator-* branches)
// VTID-0600: Operational visibility foundation
// VTID-0601: Autonomous Safe Merge & Deploy Control (includes Approvals UI)
// VTID-01001: VTID Ledger Visibility + Decision View (Command Hub + OASIS)
//             Branch pattern: vtid-ledger-visibility (for claude/vtid-ledger-visibility-* branches)
// VTID-01002: Global Dev UI Scroll Retention (polling-safe, permanent)
// VTID-01003: Fix Create Task modal + add Task Spec field + drawer metadata formatting
// VTID-01005: Task Completion Authority & Board Sync (OASIS → Command Hub)
// VTID-01006: Task Lifecycle Authority & Drawer Lock Enforcement
// VTID-01009: Activate emits authoritative OASIS lifecycle.started event
// VTID-01010: Target Role as Mandatory Task Contract (Command Hub + OASIS)
// VTID-01012: Task UI cleanup + Create Modal layout fixes
// VTID-01013: Scheduled Column Hygiene (Auto-Archive + Default Filters)
// VTID-01014: Sidebar space optimization + profile role switcher
// VTID-01015: Scheduled Eligibility Filter + UX Cleanup (Remove Counters)
// VTID-01016: OASIS Event Authority - Deterministic Stage/Status Derivation
// VTID-01017: Scheduled Column Hard Eligibility + Remove Archive UI
// VTID-01019: Operator Console UI Binding to OASIS Truth (No optimistic UI)
// VTID-01021: Board Column Placement + Status Normalization
// VTID-01022: Command Hub Governance - Eliminate CI/CD & System Task Pollution
// VTID-01025: Operator Chat - Open chat mode (frontend routing fix)
// VTID-01027: Operator Console Session Memory - client-side context + conversation_id
// VTID-01028: Task Board Rendering Fix - Restore Visibility & Authority
// VTID-01030: Fix VTIDs/Tasks disappearing - render crash & refresh wipe
// VTID-01034: OASIS Events header single-row compact layout
const ALLOWED_VTID_PATTERN = /DEV-COMHU-\d+|VTID-0302|VTID-0539|VTID-0541|VTID-0542|VTID-0600|VTID-0601|VTID-01001|VTID-01002|VTID-01003|VTID-01005|VTID-01006|VTID-01009|VTID-01010|VTID-01012|VTID-01013|VTID-01014|VTID-01015|VTID-01016|VTID-01017|VTID-01019|VTID-01021|VTID-01022|VTID-01025|VTID-01027|VTID-01028|VTID-01030|VTID-01034|global-vtid-allocator|vtid-ledger-visibility/i;

function getChangedFiles() {
  try {
    // For PR builds, compare against base branch
    const baseBranch = process.env.GITHUB_BASE_REF || 'main';
    const headRef = process.env.GITHUB_HEAD_REF || 'HEAD';

    // Try to get diff against base branch
    let diffCmd = `git diff --name-only origin/${baseBranch}...HEAD 2>/dev/null`;
    let output;

    try {
      output = execSync(diffCmd, { encoding: 'utf-8' });
    } catch {
      // Fallback: diff against origin/main
      try {
        output = execSync('git diff --name-only origin/main...HEAD 2>/dev/null', { encoding: 'utf-8' });
      } catch {
        // Last resort: just show uncommitted changes
        output = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null', { encoding: 'utf-8' });
      }
    }

    return output.trim().split('\n').filter(Boolean);
  } catch (error) {
    console.error('Warning: Could not get changed files:', error.message);
    return [];
  }
}

function getBranchName() {
  // GitHub Actions provides these
  const branchName = process.env.GITHUB_HEAD_REF ||
                     process.env.GITHUB_REF_NAME ||
                     process.env.GITHUB_REF?.replace('refs/heads/', '') ||
                     '';

  if (branchName) return branchName;

  // Fallback: get from git
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function getPRTitle() {
  // GitHub Actions provides PR title in workflow context
  return process.env.PR_TITLE || process.env.GITHUB_PR_TITLE || '';
}

function main() {
  console.log('======================================');
  console.log('VTID-0302: Command Hub Ownership Guard');
  console.log('======================================');
  console.log('');

  const changedFiles = getChangedFiles();
  const branchName = getBranchName();
  const prTitle = getPRTitle();

  console.log(`Branch: ${branchName}`);
  console.log(`PR Title: ${prTitle || '(not available)'}`);
  console.log(`Changed files: ${changedFiles.length}`);
  console.log('');

  // Check if any protected files are modified
  const protectedFilesModified = changedFiles.filter(f => f.startsWith(PROTECTED_PATH));

  if (protectedFilesModified.length === 0) {
    console.log('No Command Hub frontend files modified.');
    console.log('Guard check PASSED.');
    process.exit(0);
  }

  console.log('Command Hub frontend files modified:');
  protectedFilesModified.forEach(f => console.log(`  - ${f}`));
  console.log('');

  // Check if branch name or PR title contains allowed VTID marker
  const hasAllowedMarker = ALLOWED_VTID_PATTERN.test(branchName) ||
                           ALLOWED_VTID_PATTERN.test(prTitle);

  if (hasAllowedMarker) {
    console.log(`DEV-COMHU marker found in branch/PR title.`);
    console.log('Guard check PASSED.');
    process.exit(0);
  }

  // FAIL: Protected files modified without proper VTID
  console.error('');
  console.error('ERROR: Command Hub frontend files modified without authorization!');
  console.error('');
  console.error('The following protected files were modified:');
  protectedFilesModified.forEach(f => console.error(`  - ${f}`));
  console.error('');
  console.error('Command Hub frontend edits require a DEV-COMHU-* VTID marker');
  console.error('in the branch name or PR title.');
  console.error('');
  console.error('Examples of valid branch names:');
  console.error('  - feature/DEV-COMHU-0203-ticker-fix');
  console.error('  - claude/DEV-COMHU-0204-styling');
  console.error('');
  console.error('If this is a backend-only VTID, revert changes to:');
  console.error(`  ${PROTECTED_PATH}`);
  console.error('');
  console.error('Guard check FAILED.');
  process.exit(1);
}

main();
