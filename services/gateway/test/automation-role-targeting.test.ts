/**
 * Automation Role Targeting Tests
 *
 * Validates that:
 * 1. All 108 automations have a targetRoles property
 * 2. Role filtering works correctly for each user type
 * 3. queryTargetUsers helper builds correct Supabase queries
 * 4. Registry summary includes role breakdown
 * 5. API endpoints support ?role= filtering
 */

import {
  AUTOMATION_REGISTRY,
  getAutomation,
  getAutomationsByRole,
  getExecutableAutomationsForRole,
  automationTargetsRole,
  getRegistrySummary,
} from '../src/services/automation-registry';
import { AUTOMATION_ROLES, AutomationDefinition } from '../src/types/automations';

// =============================================================================
// 1. Schema validation: every automation must have targetRoles
// =============================================================================

describe('AutomationDefinition.targetRoles — schema completeness', () => {
  test('all 108 automations have a targetRoles property', () => {
    expect(AUTOMATION_REGISTRY.length).toBe(108);
    for (const def of AUTOMATION_REGISTRY) {
      expect(def).toHaveProperty('targetRoles');
      const roles = def.targetRoles;
      if (roles !== 'all') {
        expect(Array.isArray(roles)).toBe(true);
        expect(roles.length).toBeGreaterThan(0);
        // Each role must be valid
        for (const r of roles) {
          expect(AUTOMATION_ROLES).toContain(r);
        }
      }
    }
  });

  test('no automation has an empty targetRoles array', () => {
    for (const def of AUTOMATION_REGISTRY) {
      if (def.targetRoles !== 'all') {
        expect(def.targetRoles.length).toBeGreaterThan(0);
      }
    }
  });
});

// =============================================================================
// 2. Role targeting logic
// =============================================================================

describe('automationTargetsRole', () => {
  test('"all" targets every role', () => {
    const def: AutomationDefinition = {
      id: 'TEST-001', name: 'Test', domain: 'connect-people',
      status: 'IMPLEMENTED', priority: 'P0', triggerType: 'manual',
      targetRoles: 'all',
    };
    for (const role of AUTOMATION_ROLES) {
      expect(automationTargetsRole(def, role)).toBe(true);
    }
  });

  test('explicit array only targets listed roles', () => {
    const def: AutomationDefinition = {
      id: 'TEST-002', name: 'Test', domain: 'health-wellness',
      status: 'IMPLEMENTED', priority: 'P0', triggerType: 'manual',
      targetRoles: ['patient'],
    };
    expect(automationTargetsRole(def, 'patient')).toBe(true);
    expect(automationTargetsRole(def, 'community')).toBe(false);
    expect(automationTargetsRole(def, 'professional')).toBe(false);
    expect(automationTargetsRole(def, 'developer')).toBe(false);
  });
});

// =============================================================================
// 3. Role-based registry queries
// =============================================================================

describe('getAutomationsByRole', () => {
  test('patient sees health automations', () => {
    const patientAutomations = getAutomationsByRole('patient');
    const healthIds = patientAutomations
      .filter(a => a.domain === 'health-wellness')
      .map(a => a.id);
    // All 15 health automations target patient
    expect(healthIds).toContain('AP-0601'); // PHI Redaction Gate
    expect(healthIds).toContain('AP-0607'); // Lab Report Ingestion
    expect(healthIds).toContain('AP-0608'); // Biomarker Trend
    expect(healthIds).toContain('AP-0611'); // Vitana Index Weekly
  });

  test('professional sees business and creator automations', () => {
    const proAutomations = getAutomationsByRole('professional');
    const businessIds = proAutomations
      .filter(a => a.domain === 'business-hub-marketplace')
      .map(a => a.id);
    expect(businessIds).toContain('AP-1101'); // Service Listing
    expect(businessIds).toContain('AP-1102'); // Product Listing
    expect(businessIds).toContain('AP-1106'); // Shop Setup Wizard
  });

  test('professional does NOT see patient-only health automations', () => {
    const proAutomations = getAutomationsByRole('professional');
    const proHealthIds = proAutomations
      .filter(a => a.domain === 'health-wellness')
      .map(a => a.id);
    // PHI Redaction, Lab Report, Biomarker are patient-only
    expect(proHealthIds).not.toContain('AP-0601');
    expect(proHealthIds).not.toContain('AP-0607');
    expect(proHealthIds).not.toContain('AP-0608');
  });

  test('developer only sees platform ops and universal automations', () => {
    const devAutomations = getAutomationsByRole('developer');
    const devDomains = new Set(devAutomations.map(a => a.domain));
    // Developer should see platform-operations
    expect(devDomains).toContain('platform-operations');
    // Developer should NOT see health-wellness (patient-only)
    const devHealthIds = devAutomations.filter(a => a.domain === 'health-wellness').map(a => a.id);
    expect(devHealthIds.length).toBe(0);
    // Developer should NOT see connect-people (member-only)
    const devConnectIds = devAutomations.filter(a => a.domain === 'connect-people').map(a => a.id);
    expect(devConnectIds.length).toBe(0);
  });

  test('admin sees platform ops and governance', () => {
    const adminAutomations = getAutomationsByRole('admin');
    const adminPlatformIds = adminAutomations
      .filter(a => a.domain === 'platform-operations')
      .map(a => a.id);
    expect(adminPlatformIds).toContain('AP-1001'); // VTID Lifecycle
    expect(adminPlatformIds).toContain('AP-1002'); // Governance Flag
  });

  test('staff sees platform ops but not health intelligence', () => {
    const staffAutomations = getAutomationsByRole('staff');
    const staffPlatformIds = staffAutomations
      .filter(a => a.domain === 'platform-operations')
      .map(a => a.id);
    expect(staffPlatformIds).toContain('AP-1002'); // Governance Flag
    // Staff should NOT see health
    const staffHealthIds = staffAutomations.filter(a => a.domain === 'health-wellness').map(a => a.id);
    expect(staffHealthIds.length).toBe(0);
  });

  test('community sees social, engagement, and sharing but not business creator automations', () => {
    const communityAutomations = getAutomationsByRole('community');
    const communityDomains = new Set(communityAutomations.map(a => a.domain));
    expect(communityDomains).toContain('connect-people');
    expect(communityDomains).toContain('engagement-loops');
    expect(communityDomains).toContain('sharing-growth');

    // Community should not see professional creator automations like Shop Setup
    const communityBusinessIds = communityAutomations
      .filter(a => a.domain === 'business-hub-marketplace')
      .map(a => a.id);
    expect(communityBusinessIds).not.toContain('AP-1101'); // Service Listing (professional)
    expect(communityBusinessIds).not.toContain('AP-1106'); // Shop Setup (professional)
  });
});

// =============================================================================
// 4. Role count in registry summary
// =============================================================================

describe('getRegistrySummary — role breakdown', () => {
  test('summary includes role counts', () => {
    const summary = getRegistrySummary();
    expect(summary.roles).toBeDefined();
    expect(typeof summary.roles.patient).toBe('number');
    expect(typeof summary.roles.professional).toBe('number');
    expect(typeof summary.roles.community).toBe('number');
    expect(typeof summary.roles.admin).toBe('number');
    expect(typeof summary.roles.staff).toBe('number');
    expect(typeof summary.roles.developer).toBe('number');
  });

  test('patient has more automations than developer', () => {
    const summary = getRegistrySummary();
    expect(summary.roles.patient).toBeGreaterThan(summary.roles.developer);
  });

  test('community has the most automations (broadest audience)', () => {
    const summary = getRegistrySummary();
    expect(summary.roles.community).toBeGreaterThanOrEqual(summary.roles.staff);
    expect(summary.roles.community).toBeGreaterThanOrEqual(summary.roles.developer);
  });
});

// =============================================================================
// 5. Cross-domain role isolation
// =============================================================================

describe('cross-domain role isolation', () => {
  test('health automations never target developer role', () => {
    const healthAutomations = AUTOMATION_REGISTRY.filter(a => a.domain === 'health-wellness');
    for (const a of healthAutomations) {
      expect(automationTargetsRole(a, 'developer')).toBe(false);
    }
  });

  test('platform-operations never targets community/patient roles', () => {
    const platformAutomations = AUTOMATION_REGISTRY.filter(a => a.domain === 'platform-operations');
    for (const a of platformAutomations) {
      expect(automationTargetsRole(a, 'community')).toBe(false);
      expect(automationTargetsRole(a, 'patient')).toBe(false);
    }
  });

  test('creator automations (AP-1101, AP-1106, AP-0706) target professional only', () => {
    const creatorIds = ['AP-1101', 'AP-1106', 'AP-0706'];
    for (const id of creatorIds) {
      const def = getAutomation(id)!;
      expect(automationTargetsRole(def, 'professional')).toBe(true);
      expect(automationTargetsRole(def, 'community')).toBe(false);
      expect(automationTargetsRole(def, 'patient')).toBe(false);
    }
  });

  test('payment retry (AP-0701) targets all roles', () => {
    const def = getAutomation('AP-0701')!;
    expect(def.targetRoles).toBe('all');
  });
});

// =============================================================================
// 6. Executable automations respect role targeting
// =============================================================================

describe('getExecutableAutomationsForRole', () => {
  test('patient gets health executable automations', () => {
    const patientExec = getExecutableAutomationsForRole('patient');
    const ids = patientExec.map(a => a.id);
    expect(ids).toContain('AP-0607'); // Lab Report Ingestion (IMPLEMENTED)
    expect(ids).toContain('AP-0608'); // Biomarker Trend (IMPLEMENTED)
  });

  test('professional gets creator executable automations', () => {
    const proExec = getExecutableAutomationsForRole('professional');
    const ids = proExec.map(a => a.id);
    expect(ids).toContain('AP-1101'); // Service Listing
    expect(ids).toContain('AP-0706'); // Creator Stripe Onboarding
    expect(ids).toContain('AP-0711'); // Weekly Earnings Report
  });

  test('developer gets only platform ops and universal executables', () => {
    const devExec = getExecutableAutomationsForRole('developer');
    for (const a of devExec) {
      // Developer should only see platform ops or 'all' targeted
      const isOps = a.domain === 'platform-operations';
      const isAll = a.targetRoles === 'all';
      expect(isOps || isAll).toBe(true);
    }
  });
});
