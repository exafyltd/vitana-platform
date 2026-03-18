/**
 * Spec Quality Agent — Deep content validation for task specs.
 *
 * Inserts between 'validated' and 'approved' in the spec pipeline.
 * All checks are deterministic (no LLM dependency).
 *
 * Checks:
 *   CQ-01..CQ-10: Content quality per section
 *   Risk derivation from scope/changes
 *   Cross-VTID conflict detection (file overlap)
 *   Governance rule mapping (gap detection)
 */

import { SYSTEM_AREAS, type SystemArea } from '../utils/task-title';

// =============================================================================
// Types
// =============================================================================

export interface SpecCheck {
  check_id: string;
  category: 'content' | 'structure' | 'governance' | 'impact' | 'conflict' | 'risk';
  name: string;
  result: 'pass' | 'fail' | 'warning';
  severity: 'blocker' | 'critical' | 'warning' | 'info';
  message: string;
  details?: Record<string, unknown>;
}

export interface ImpactAnalysis {
  system_areas_touched: SystemArea[];
  files_mentioned: string[];
  api_changes_detected: boolean;
  db_migration_detected: boolean;
  ui_changes_detected: boolean;
  risk_multipliers: string[];
}

export interface FileConflict {
  file_path: string;
  other_vtid: string;
  other_vtid_status: string;
  other_vtid_title: string;
}

export interface ConflictAnalysis {
  has_conflicts: boolean;
  conflicts: FileConflict[];
  overlap_count: number;
}

export interface GovernanceRuleMatch {
  rule_id: string;
  rule_name: string;
  level: string;
  reason: string;
}

export interface GovernanceAnalysis {
  rules_mentioned_in_spec: string[];
  rules_actually_applicable: GovernanceRuleMatch[];
  unmentioned_rules: GovernanceRuleMatch[];
  governance_gap: boolean;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface SpecQualityReport {
  vtid: string;
  spec_hash: string;
  overall_result: 'pass' | 'fail' | 'warning';
  overall_score: number;
  risk_level: RiskLevel;
  risk_reasons: string[];
  checks: SpecCheck[];
  impact_analysis: ImpactAnalysis;
  conflict_analysis: ConflictAnalysis;
  governance_analysis: GovernanceAnalysis;
  timestamp: string;
}

// =============================================================================
// Section extraction
// =============================================================================

/** Extract content between a section header and the next ## header. */
function extractSectionContent(specMarkdown: string, sectionName: string): string {
  const pattern = new RegExp(
    `^##?\\s*\\d*\\.?\\s*${sectionName}[^\\n]*\\n([\\s\\S]*?)(?=^##?\\s|$)`,
    'im'
  );
  const match = specMarkdown.match(pattern);
  if (!match) return '';
  return match[1].trim();
}

/** Check if content is a placeholder / default from generateSpecFromSeed(). */
function isPlaceholder(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 10) return true;
  const placeholders = [
    /^\s*-?\s*(TBD|To be determined|N\/A|None identified|TODO)/im,
    /^Implement the requested functionality$/im,
    /^Items not explicitly mentioned in acceptance criteria$/im,
    /^To be determined during (analysis|implementation)/im,
    /^# Verification commands TBD$/im,
    /^\[\s*\]\s*UI verification steps TBD$/im,
    /^None identified \(to be updated\)$/im,
  ];
  return placeholders.some(p => p.test(trimmed));
}

/** Count real (non-empty, non-placeholder) bullet points in content. */
function countRealBullets(content: string): number {
  const lines = content.split('\n');
  let count = 0;
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet && bullet[1].trim().length >= 10 && !isPlaceholder(bullet[1])) {
      count++;
    }
  }
  return count;
}

/** Count numbered items (1. xxx, 2. xxx). */
function countNumberedItems(content: string): number {
  const lines = content.split('\n');
  let count = 0;
  for (const line of lines) {
    const item = line.match(/^\s*\d+[.)]\s+(.+)/);
    if (item && item[1].trim().length >= 15 && !isPlaceholder(item[1])) {
      count++;
    }
  }
  // Also count checkbox items: - [ ] xxx
  for (const line of lines) {
    const item = line.match(/^\s*-\s*\[.\]\s+(.+)/);
    if (item && item[1].trim().length >= 15 && !isPlaceholder(item[1])) {
      count++;
    }
  }
  return count;
}

/** Extract file paths from content (lines containing / or file extensions). */
function extractFilePaths(content: string): string[] {
  const paths: string[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    // Match lines like "- services/gateway/src/routes/auth.ts" or inline paths
    const matches = line.match(/[\w./-]+\.(ts|tsx|js|jsx|sql|json|css|html|yml|yaml|py|md)/g);
    if (matches) {
      for (const m of matches) {
        if (m.includes('/') || m.includes('.')) {
          paths.push(m);
        }
      }
    }
  }
  return [...new Set(paths)];
}

// =============================================================================
// Content Quality Checks (CQ-01 through CQ-10)
// =============================================================================

export function checkSectionContent(specMarkdown: string): SpecCheck[] {
  const checks: SpecCheck[] = [];

  // CQ-01: Goal
  const goal = extractSectionContent(specMarkdown, 'Goal');
  if (!goal || goal.length < 20 || isPlaceholder(goal)) {
    checks.push({
      check_id: 'CQ-01', category: 'content', name: 'Goal section',
      result: 'fail', severity: 'blocker',
      message: 'Goal must be >= 20 chars with real description (not placeholder)',
      details: { content_length: goal.length, is_placeholder: isPlaceholder(goal) }
    });
  } else {
    checks.push({
      check_id: 'CQ-01', category: 'content', name: 'Goal section',
      result: 'pass', severity: 'blocker', message: 'Goal is well-defined'
    });
  }

  // CQ-02: Scope IN
  const scope = extractSectionContent(specMarkdown, 'Scope');
  const inScopeMatch = scope.match(/IN\s*SCOPE[^\n]*\n([\s\S]*?)(?=OUT\s*(?:OF\s*)?SCOPE|$)/i);
  const inScopeContent = inScopeMatch ? inScopeMatch[1] : scope;
  const inScopeBullets = countRealBullets(inScopeContent);
  if (inScopeBullets < 2) {
    checks.push({
      check_id: 'CQ-02', category: 'content', name: 'Scope IN',
      result: 'fail', severity: 'blocker',
      message: `IN SCOPE needs >= 2 real bullet points (found ${inScopeBullets})`,
      details: { bullets_found: inScopeBullets }
    });
  } else {
    checks.push({
      check_id: 'CQ-02', category: 'content', name: 'Scope IN',
      result: 'pass', severity: 'blocker', message: `IN SCOPE has ${inScopeBullets} items`
    });
  }

  // CQ-03: Scope OUT
  const outScopeMatch = scope.match(/OUT\s*(?:OF\s*)?SCOPE[^\n]*\n([\s\S]*?)$/i);
  const outScopeContent = outScopeMatch ? outScopeMatch[1] : '';
  const outScopeBullets = countRealBullets(outScopeContent);
  if (outScopeBullets < 1) {
    checks.push({
      check_id: 'CQ-03', category: 'content', name: 'Scope OUT',
      result: 'warning', severity: 'warning',
      message: 'OUT OF SCOPE should have at least 1 real bullet point'
    });
  } else {
    checks.push({
      check_id: 'CQ-03', category: 'content', name: 'Scope OUT',
      result: 'pass', severity: 'warning', message: 'OUT OF SCOPE defined'
    });
  }

  // CQ-04: Changes (at least one subsection filled)
  const changes = extractSectionContent(specMarkdown, 'Changes');
  const dbContent = extractSectionContent(changes, 'Database Migrations') || extractSubSection(changes, 'Database');
  const apiContent = extractSectionContent(changes, 'APIs') || extractSubSection(changes, 'API');
  const uiContent = extractSectionContent(changes, 'UI Changes') || extractSubSection(changes, 'UI');
  const hasRealDb = dbContent.length > 0 && !isPlaceholder(dbContent);
  const hasRealApi = apiContent.length > 0 && !isPlaceholder(apiContent);
  const hasRealUi = uiContent.length > 0 && !isPlaceholder(uiContent);
  if (!hasRealDb && !hasRealApi && !hasRealUi) {
    checks.push({
      check_id: 'CQ-04', category: 'content', name: 'Changes section',
      result: 'fail', severity: 'blocker',
      message: 'At least one of DB/API/UI changes must have real content'
    });
  } else {
    checks.push({
      check_id: 'CQ-04', category: 'content', name: 'Changes section',
      result: 'pass', severity: 'blocker',
      message: `Changes filled: DB=${hasRealDb}, API=${hasRealApi}, UI=${hasRealUi}`
    });
  }

  // CQ-05: Files to Modify
  const filesSection = extractSectionContent(specMarkdown, 'Files to Modify');
  const filePaths = extractFilePaths(filesSection);
  if (filePaths.length < 1) {
    checks.push({
      check_id: 'CQ-05', category: 'content', name: 'Files to Modify',
      result: 'fail', severity: 'blocker',
      message: 'Must list at least 1 real file path (containing / or file extension)',
      details: { raw_content: filesSection.slice(0, 200) }
    });
  } else {
    checks.push({
      check_id: 'CQ-05', category: 'content', name: 'Files to Modify',
      result: 'pass', severity: 'blocker',
      message: `${filePaths.length} file(s) listed`,
      details: { files: filePaths }
    });
  }

  // CQ-06: Acceptance Criteria
  const criteria = extractSectionContent(specMarkdown, 'Acceptance Criteria');
  const criteriaCount = countNumberedItems(criteria) + countRealBullets(criteria);
  if (criteriaCount < 2) {
    checks.push({
      check_id: 'CQ-06', category: 'content', name: 'Acceptance Criteria',
      result: 'fail', severity: 'blocker',
      message: `Need >= 2 acceptance criteria items (found ${criteriaCount})`,
      details: { items_found: criteriaCount }
    });
  } else {
    checks.push({
      check_id: 'CQ-06', category: 'content', name: 'Acceptance Criteria',
      result: 'pass', severity: 'blocker',
      message: `${criteriaCount} criteria defined`
    });
  }

  // CQ-07: Verification Steps
  const verification = extractSectionContent(specMarkdown, 'Verification Steps');
  const hasCurl = /curl\s/.test(verification) || /```bash/.test(verification);
  const hasUiCheck = /\[.\]/.test(verification) && !isPlaceholder(verification);
  if (!hasCurl && !hasUiCheck) {
    checks.push({
      check_id: 'CQ-07', category: 'content', name: 'Verification Steps',
      result: 'fail', severity: 'critical',
      message: 'Must have at least 1 curl command or 1 UI verification check'
    });
  } else {
    checks.push({
      check_id: 'CQ-07', category: 'content', name: 'Verification Steps',
      result: 'pass', severity: 'critical',
      message: `Verification: curl=${hasCurl}, UI=${hasUiCheck}`
    });
  }

  // CQ-08: Rollback Plan
  const rollback = extractSectionContent(specMarkdown, 'Rollback Plan');
  const hasMigration = /migrat/i.test(specMarkdown);
  const hasConcreteRollback = rollback.length >= 20 && !isPlaceholder(rollback);
  const mentionsMigrationRollback = /migrat.*rollback|rollback.*migrat|revert.*migrat/i.test(rollback);
  if (!hasConcreteRollback) {
    checks.push({
      check_id: 'CQ-08', category: 'content', name: 'Rollback Plan',
      result: 'fail', severity: 'critical',
      message: 'Rollback plan must have a concrete action (>= 20 chars, not placeholder)'
    });
  } else if (hasMigration && !mentionsMigrationRollback) {
    checks.push({
      check_id: 'CQ-08', category: 'content', name: 'Rollback Plan',
      result: 'fail', severity: 'critical',
      message: 'Spec includes DB migrations but rollback plan does not mention migration rollback'
    });
  } else {
    checks.push({
      check_id: 'CQ-08', category: 'content', name: 'Rollback Plan',
      result: 'pass', severity: 'critical', message: 'Rollback plan is concrete'
    });
  }

  // CQ-09: Risk Level
  const risk = extractSectionContent(specMarkdown, 'Risk Level');
  const validRisk = /\b(LOW|MEDIUM|HIGH|CRITICAL)\b/i.test(risk);
  if (!validRisk) {
    checks.push({
      check_id: 'CQ-09', category: 'risk', name: 'Risk Level',
      result: 'fail', severity: 'critical',
      message: 'Risk level must be LOW, MEDIUM, HIGH, or CRITICAL'
    });
  } else {
    checks.push({
      check_id: 'CQ-09', category: 'risk', name: 'Risk Level',
      result: 'pass', severity: 'critical', message: 'Risk level present'
    });
  }

  // CQ-10: Governance Rules
  const govRules = extractSectionContent(specMarkdown, 'Non-negotiable Governance Rules Touched');
  if (!govRules || isPlaceholder(govRules)) {
    checks.push({
      check_id: 'CQ-10', category: 'governance', name: 'Governance Rules',
      result: 'warning', severity: 'warning',
      message: 'Governance rules section is placeholder — should list applicable rules'
    });
  } else {
    checks.push({
      check_id: 'CQ-10', category: 'governance', name: 'Governance Rules',
      result: 'pass', severity: 'warning', message: 'Governance rules specified'
    });
  }

  return checks;
}

/** Helper to extract a sub-section within a Changes block. */
function extractSubSection(content: string, keyword: string): string {
  const pattern = new RegExp(`###?\\s*\\d*\\.?\\d*\\s*${keyword}[^\\n]*\\n([\\s\\S]*?)(?=###?\\s|$)`, 'i');
  const match = content.match(pattern);
  return match ? match[1].trim() : '';
}

// =============================================================================
// Impact Analysis
// =============================================================================

const FILE_PATH_AREA_MAP: [RegExp, SystemArea][] = [
  [/orb-live|routes\/voice|orb-session/, 'ORB'],
  [/routes\/auth|middleware\/auth|auth-supabase/, 'Auth'],
  [/command-hub|frontend\/command/, 'Command Hub'],
  [/routes\/autopilot|autopilot-controller|autopilot-event/, 'Pipeline'],
  [/routes\/operator|operator-service|gemini-operator/, 'Operator'],
  [/routes\/governance|governance-controller|validator-core/, 'Governance'],
  [/routes\/events|oasis-event|oasis-pipeline|oasis-tasks/, 'OASIS'],
  [/memory-|semantic-memory|knowledge-graph/, 'Memory'],
  [/agents\/|conductor|worker-/, 'Agents'],
  [/\.github\/|Dockerfile|cloudbuild|EXEC-DEPLOY/, 'Infra'],
  [/temp_vitana|lovable/, 'Frontend'],
  [/routes\/|middleware\/|services\/|index\.ts/, 'Gateway'],
];

function filePathToArea(filePath: string): SystemArea | null {
  for (const [pattern, area] of FILE_PATH_AREA_MAP) {
    if (pattern.test(filePath)) return area;
  }
  return null;
}

export function analyzeImpact(specMarkdown: string): ImpactAnalysis {
  const filesSection = extractSectionContent(specMarkdown, 'Files to Modify');
  const files = extractFilePaths(filesSection);

  // Also extract inline file references from full spec
  const allFilePaths = extractFilePaths(specMarkdown);
  const allFiles = [...new Set([...files, ...allFilePaths])];

  const areasSet = new Set<SystemArea>();
  for (const f of allFiles) {
    const area = filePathToArea(f);
    if (area) areasSet.add(area);
  }

  const changes = extractSectionContent(specMarkdown, 'Changes');
  const dbContent = extractSubSection(changes, 'Database');
  const apiContent = extractSubSection(changes, 'API');
  const uiContent = extractSubSection(changes, 'UI');

  const multipliers: string[] = [];
  if (allFiles.some(f => /\.github\/workflows/.test(f))) multipliers.push('Modifies CI/CD workflows');
  if (allFiles.some(f => /middleware\//.test(f))) multipliers.push('Modifies middleware');
  if (allFiles.some(f => /\/index\.ts$/.test(f))) multipliers.push('Modifies main entry point');
  if (allFiles.length > 10) multipliers.push(`${allFiles.length} files modified (>10)`);

  return {
    system_areas_touched: [...areasSet] as SystemArea[],
    files_mentioned: allFiles,
    api_changes_detected: !isPlaceholder(apiContent) && apiContent.length > 10,
    db_migration_detected: !isPlaceholder(dbContent) && dbContent.length > 10,
    ui_changes_detected: !isPlaceholder(uiContent) && uiContent.length > 10,
    risk_multipliers: multipliers,
  };
}

// =============================================================================
// Risk Derivation
// =============================================================================

const RISK_ORDER: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function bumpRisk(current: RiskLevel, steps: number): RiskLevel {
  const idx = RISK_ORDER.indexOf(current);
  return RISK_ORDER[Math.min(idx + steps, RISK_ORDER.length - 1)];
}

export function deriveRiskLevel(impact: ImpactAnalysis): { level: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];
  let level: RiskLevel = 'LOW';

  const areas = impact.system_areas_touched;
  const touchesAuth = areas.includes('Auth');
  const touchesGov = areas.includes('Governance');

  // CRITICAL triggers
  if (touchesAuth || touchesGov || (impact.db_migration_detected && (touchesAuth || touchesGov))) {
    level = 'CRITICAL';
    if (touchesAuth) reasons.push('Touches Auth system');
    if (touchesGov) reasons.push('Touches Governance system');
    if (impact.db_migration_detected) reasons.push('Includes DB migrations on sensitive area');
  }
  // HIGH triggers
  else if (areas.length >= 3 || (impact.api_changes_detected && impact.db_migration_detected)) {
    level = 'HIGH';
    if (areas.length >= 3) reasons.push(`Touches ${areas.length} system areas: ${areas.join(', ')}`);
    if (impact.api_changes_detected && impact.db_migration_detected) reasons.push('Both API and DB changes');
  }
  // MEDIUM triggers
  else if (areas.length >= 2 || impact.api_changes_detected) {
    level = 'MEDIUM';
    if (areas.length >= 2) reasons.push(`Touches ${areas.length} system areas: ${areas.join(', ')}`);
    if (impact.api_changes_detected) reasons.push('API changes detected');
  }
  // LOW
  else {
    reasons.push('Single area, no API/DB changes');
  }

  // Risk multipliers — each bumps one level
  for (const mult of impact.risk_multipliers) {
    level = bumpRisk(level, 1);
    reasons.push(mult);
  }

  return { level, reasons };
}

// =============================================================================
// Cross-VTID Conflict Detection
// =============================================================================

export async function detectCrossVtidConflicts(
  vtid: string,
  filesMentioned: string[],
  supabaseUrl: string,
  svcKey: string
): Promise<ConflictAnalysis> {
  if (filesMentioned.length === 0) {
    return { has_conflicts: false, conflicts: [], overlap_count: 0 };
  }

  const headers = {
    apikey: svcKey,
    Authorization: `Bearer ${svcKey}`,
  };

  try {
    // Get all in_progress VTIDs except current
    const ledgerResp = await fetch(
      `${supabaseUrl}/rest/v1/vtid_ledger?status=eq.in_progress&vtid=neq.${vtid}&vtid=like.VTID-%25&select=vtid,title,status,spec_current_id`,
      { headers }
    );
    if (!ledgerResp.ok) return { has_conflicts: false, conflicts: [], overlap_count: 0 };

    const activeVtids = await ledgerResp.json() as Array<{ vtid: string; title: string; status: string; spec_current_id: string | null }>;
    if (activeVtids.length === 0) return { has_conflicts: false, conflicts: [], overlap_count: 0 };

    const conflicts: FileConflict[] = [];

    for (const active of activeVtids) {
      if (!active.spec_current_id) continue;

      // Fetch spec for this VTID
      const specResp = await fetch(
        `${supabaseUrl}/rest/v1/oasis_specs?id=eq.${active.spec_current_id}&select=spec_markdown&limit=1`,
        { headers }
      );
      if (!specResp.ok) continue;

      const specs = await specResp.json() as Array<{ spec_markdown: string }>;
      if (specs.length === 0) continue;

      const otherFiles = extractFilePaths(
        extractSectionContent(specs[0].spec_markdown, 'Files to Modify')
      );

      // Find overlap
      const myFilesSet = new Set(filesMentioned.map(f => f.toLowerCase()));
      for (const otherFile of otherFiles) {
        if (myFilesSet.has(otherFile.toLowerCase())) {
          conflicts.push({
            file_path: otherFile,
            other_vtid: active.vtid,
            other_vtid_status: active.status,
            other_vtid_title: active.title,
          });
        }
      }
    }

    return {
      has_conflicts: conflicts.length > 0,
      conflicts,
      overlap_count: conflicts.length,
    };
  } catch (err) {
    console.warn(`[spec-quality] Conflict detection error: ${err}`);
    return { has_conflicts: false, conflicts: [], overlap_count: 0 };
  }
}

// =============================================================================
// Governance Rule Mapping
// =============================================================================

export async function analyzeGovernanceMapping(
  specMarkdown: string,
  vtid: string,
  systemAreasTouched: SystemArea[],
  supabaseUrl: string,
  svcKey: string
): Promise<GovernanceAnalysis> {
  const govSection = extractSectionContent(specMarkdown, 'Non-negotiable Governance Rules Touched');

  // Extract mentioned rule IDs (GOV-XXX-R.N pattern)
  const mentionedIds = (govSection.match(/GOV-[\w-]+R\.\d+/gi) || []).map(id => id.toUpperCase());

  // Map system areas to governance domains
  const areaToDomain: Record<string, string[]> = {
    'Frontend': ['FRONTEND', 'CSP', 'NAVIGATION'],
    'Auth': ['SECURITY', 'API'],
    'Gateway': ['API', 'DEPLOYMENT'],
    'Infra': ['CICD', 'DEPLOYMENT'],
    'Governance': ['SECURITY'],
    'OASIS': ['DB', 'API'],
    'Pipeline': ['AGENT', 'API'],
    'Agents': ['AGENT'],
    'Memory': ['DB', 'SECURITY'],
  };

  const applicableDomains = new Set<string>();
  for (const area of systemAreasTouched) {
    const domains = areaToDomain[area] || [];
    for (const d of domains) applicableDomains.add(d);
  }

  try {
    const headers = { apikey: svcKey, Authorization: `Bearer ${svcKey}` };
    const rulesResp = await fetch(
      `${supabaseUrl}/rest/v1/governance_rules?is_active=eq.true&select=id,name,rule_id,level,logic`,
      { headers }
    );

    if (!rulesResp.ok) {
      return { rules_mentioned_in_spec: mentionedIds, rules_actually_applicable: [], unmentioned_rules: [], governance_gap: false };
    }

    const rules = await rulesResp.json() as Array<{ id: string; name: string; rule_id: string; level: string; logic: Record<string, unknown> }>;

    const applicable: GovernanceRuleMatch[] = [];
    const unmentioned: GovernanceRuleMatch[] = [];

    for (const rule of rules) {
      const ruleDomain = (rule.logic?.domain as string) || '';
      if (!applicableDomains.has(ruleDomain.toUpperCase())) continue;

      const match: GovernanceRuleMatch = {
        rule_id: rule.rule_id || rule.id,
        rule_name: rule.name,
        level: rule.level || 'L3',
        reason: `Domain ${ruleDomain} applies to areas: ${systemAreasTouched.join(', ')}`,
      };
      applicable.push(match);

      if (!mentionedIds.includes((rule.rule_id || '').toUpperCase())) {
        unmentioned.push(match);
      }
    }

    return {
      rules_mentioned_in_spec: mentionedIds,
      rules_actually_applicable: applicable,
      unmentioned_rules: unmentioned,
      governance_gap: unmentioned.length > 0,
    };
  } catch (err) {
    console.warn(`[spec-quality] Governance mapping error: ${err}`);
    return { rules_mentioned_in_spec: mentionedIds, rules_actually_applicable: [], unmentioned_rules: [], governance_gap: false };
  }
}

// =============================================================================
// Orchestrator: Full Quality Check
// =============================================================================

export async function runFullQualityCheck(
  vtid: string,
  specMarkdown: string,
  specHash: string,
  supabaseUrl: string,
  svcKey: string
): Promise<SpecQualityReport> {
  // 1. Content quality checks
  const checks = checkSectionContent(specMarkdown);

  // 2. Impact analysis
  const impact = analyzeImpact(specMarkdown);

  // 3. Risk derivation
  const { level: riskLevel, reasons: riskReasons } = deriveRiskLevel(impact);

  // 4. Cross-VTID conflict detection
  const conflicts = await detectCrossVtidConflicts(vtid, impact.files_mentioned, supabaseUrl, svcKey);

  // 5. Governance rule mapping
  const governance = await analyzeGovernanceMapping(specMarkdown, vtid, impact.system_areas_touched, supabaseUrl, svcKey);

  // Add conflict check to checks list
  if (conflicts.has_conflicts) {
    checks.push({
      check_id: 'CF-01', category: 'conflict', name: 'Cross-VTID file conflict',
      result: 'warning', severity: 'warning',
      message: `${conflicts.overlap_count} file(s) overlap with active VTIDs: ${conflicts.conflicts.map(c => `${c.file_path} (${c.other_vtid})`).join(', ')}`,
      details: { conflicts: conflicts.conflicts }
    });
  }

  // Add governance gap to checks list
  if (governance.governance_gap) {
    checks.push({
      check_id: 'GV-01', category: 'governance', name: 'Governance rule gap',
      result: 'warning', severity: 'warning',
      message: `${governance.unmentioned_rules.length} applicable governance rule(s) not mentioned in spec: ${governance.unmentioned_rules.map(r => r.rule_id).join(', ')}`,
      details: { unmentioned: governance.unmentioned_rules }
    });
  }

  // Calculate score
  let score = 100;
  let hasBlocker = false;
  for (const check of checks) {
    if (check.result === 'fail') {
      if (check.severity === 'blocker') { score -= 30; hasBlocker = true; }
      else if (check.severity === 'critical') { score -= 20; }
      else if (check.severity === 'warning') { score -= 5; }
    } else if (check.result === 'warning') {
      score -= 5;
    }
  }
  score = Math.max(0, score);

  const overall_result: 'pass' | 'fail' | 'warning' =
    (score < 60 || hasBlocker) ? 'fail' :
    score < 80 ? 'warning' : 'pass';

  return {
    vtid,
    spec_hash: specHash,
    overall_result,
    overall_score: score,
    risk_level: riskLevel,
    risk_reasons: riskReasons,
    checks,
    impact_analysis: impact,
    conflict_analysis: conflicts,
    governance_analysis: governance,
    timestamp: new Date().toISOString(),
  };
}
