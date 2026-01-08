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
// VTID-0135: ORB Voice Conversation Enablement (Phase A) - Command Hub ORB overlay updates
// VTID-01037: Fix ORB audio feedback loop and transcript scroll anchor
// VTID-01038: ORB TTS Upgrade (Better Voice) - Phase A' (Local "Best Voice" + Selector)
// VTID-01039: ORB Conversation Aggregation (Summary + Transcript display in drawer)
//             Branch pattern: add-conversation-summary (for claude/add-conversation-summary-* branches)
// VTID-01041: Editable Scheduled Card Title + Title Capture on ORB Create + Success Confirmation
//             Branch pattern: editable-scheduled-card-title (for claude/editable-scheduled-card-title-* branches)
// VTID-01042: Unified Language Selector for ORB STT + TTS (coupled language setting)
//             Branch pattern: unified-language-selector (for claude/unified-language-selector-* branches)
// VTID-01043: Fix STT abort error on language change (Web Speech API limitation)
//             Branch pattern: fix-stt-abort-error (for claude/fix-stt-abort-error-* branches)
// VTID-01044: Fix TTS feedback loop regression from VTID-01043
//             Branch pattern: fix-tts-feedback (for claude/fix-tts-feedback-* branches)
// VTID-01045: Compact task cards + calendar icon date filter
//             Branch pattern: compact-cards-date-filter (for claude/compact-cards-date-filter-* branches)
// VTID-01049: Command Hub UI role switch wiring (Profile dropdown becomes authoritative)
//             Branch pattern: gateway-me-context-api (for claude/gateway-me-context-api-* branches)
// VTID-01052: Delete button for scheduled tasks (void VTID, log OASIS event)
//             Branch pattern: delete-scheduled-tasks (for claude/delete-scheduled-tasks-* branches)
// VTID-01055: Reconcile task board by VTID on refresh (remove ghost cards)
//             Branch pattern: fix-ghost-cards (for claude/fix-ghost-cards-* branches)
// VTID-01064: ORB Status Aura + Transcript Auto-Follow
//             Branch pattern: security-audit-review (for claude/security-audit-review-* branches)
// VTID-01079: Command Hub Board Determinism (Status→Column Map + One-Row-Per-VTID + DEV Filter)
//             Branch pattern: fix-vtid-board-mapping (for claude/fix-vtid-board-mapping-* branches)
// VTID-01066: ORB Conversation Stream v1: Voice-First Live Flow (Follow, Speak Cursor, Interrupt)
//             Branch pattern: orb-conversation-stream (for claude/orb-conversation-stream-* branches)
// VTID-01067: ORB Aura v2 - Context Badges + Intensity + Speech Sync
//             Branch pattern: orb-presence-layer (for claude/orb-presence-layer-* branches)
// VTID-01069: ORB Input Surface v2 - Auto-Growing Chatbox with Symmetric Layout
//             Branch pattern: auto-growing-chatbox (for claude/auto-growing-chatbox-* branches)
// VTID-01086: Memory Garden UI Deepening - Counts, Progress, Longevity Lens
//             Branch pattern: memory-garden-ui-depth (for claude/memory-garden-ui-depth-* branches)
// VTID-01109: ORB Conversation Persistence Until Logout (Memory + Conversation fix)
//             Branch pattern: debug-orb-memory (for claude/debug-orb-memory-* branches)
// VTID-01111: Filter allocator shell entries from Command Hub board
//             Branch pattern: debug-command-hub-vtids (for claude/debug-command-hub-vtids-* branches)
// VTID-01122: Filter cancelled tasks from Command Hub board
//             Branch pattern: remove-deleted-task (for claude/remove-deleted-task-* branches)
// VTID-01150: Runner → Claude Execution Bridge (ORB task creation uses same flow as button)
//             Branch pattern: runner-execution-bridge (for claude/runner-execution-bridge-* branches)
// VTID-01155: Gemini Live Multimodal + TTS + 8-Language UI Update
//             Branch pattern: gemini-live-multimodal-tts (for claude/gemini-live-multimodal-tts-* branches)
// VTID-01156: Remove legacy /api/v1/tasks debug fetch (OASIS-only board truth)
//             Branch pattern: remove-legacy-tasks-fetch (for claude/remove-legacy-tasks-fetch-* branches)
// SPEC-01: Global Top Navigation & Refresh Standard (locked governance spec)
//          Branch pattern: global-top-navigation (for claude/global-top-navigation-* branches)
// VTID-01154: GitHub-Authoritative Approvals Feed (SPEC-02)
//             Branch pattern: github-approvals-feed (for claude/github-approvals-feed-* branches)
// VTID-01168: Approve → Safe Merge → Auto-Deploy (SPEC-04)
//             Branch pattern: approval-auto-deploy (for claude/approval-auto-deploy-* branches)
// VTID-01172: Dev Users list + Dev Access toggle (Admin > Users page)
//             Branch pattern: dev-users-access-toggle (for claude/dev-users-access-toggle-* branches)
const ALLOWED_VTID_PATTERN = /DEV-COMHU-\d+|VTID-0302|VTID-0539|VTID-0541|VTID-0542|VTID-0600|VTID-0601|VTID-01001|VTID-01002|VTID-01003|VTID-01005|VTID-01006|VTID-01009|VTID-01010|VTID-01012|VTID-01013|VTID-01014|VTID-01015|VTID-01016|VTID-01017|VTID-01019|VTID-01021|VTID-01022|VTID-01025|VTID-01027|VTID-01028|VTID-01030|VTID-01034|VTID-0135|VTID-01037|VTID-01038|VTID-01039|VTID-01041|VTID-01042|VTID-01043|VTID-01044|VTID-01045|VTID-01049|VTID-01052|VTID-01055|VTID-01064|VTID-01066|VTID-01067|VTID-01069|VTID-01079|VTID-01086|VTID-01109|VTID-01111|VTID-01122|VTID-01150|VTID-01155|VTID-01156|VTID-01154|VTID-01168|VTID-01172|SPEC-01|global-vtid-allocator|vtid-ledger-visibility|add-conversation-summary|editable-scheduled-card-title|unified-language-selector|fix-stt-abort-error|fix-tts-feedback|compact-cards-date-filter|gateway-me-context-api|delete-scheduled-tasks|fix-ghost-cards|security-audit-review|fix-vtid-board-mapping|orb-conversation-stream|orb-presence-layer|auto-growing-chatbox|memory-garden-ui-depth|debug-orb-memory|debug-command-hub-vtids|remove-deleted-task|runner-execution-bridge|gemini-live-multimodal-tts|remove-legacy-tasks-fetch|global-top-navigation|github-approvals-feed|approval-auto-deploy|dev-users-access-toggle/i;

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
