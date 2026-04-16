/**
 * Automation Role Targeting Tests
 *
 * Role model:
 *   community    — Primary user. Social + business creator. Onboarding role for first 6 months.
 *   patient      — Person receiving medical care from a professional (doctor).
 *   professional — Medical doctor in hospital/clinic. Uploads reports, clinical relationships.
 *   staff        — Back-office employees at hospital, lab, enterprise.
 *   admin        — Platform administrator.
 *   developer    — Internal platform developer.
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
  test('every automation has a valid targetRoles property', () => {
    expect(AUTOMATION_REGISTRY.length).toBeGreaterThan(0);
    for (const def of AUTOMATION_REGISTRY) {
      expect(def).toHaveProperty('targetRoles');
      const roles = def.targetRoles;
      if (roles !== 'all') {
        expect(Array.isArray(roles)).toBe(true);
        expect(roles.length).toBeGreaterThan(0);
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
// 3. Community user — the primary onboarding role
// =============================================================================

describe('community user — richest automation set', () => {
  test('community has the most automations of any role', () => {
    const summary = getRegistrySummary();
    for (const role of ['patient', 'professional', 'staff', 'admin', 'developer']) {
      expect(summary.roles.community).toBeGreaterThanOrEqual(summary.roles[role]);
    }
  });

  test('community sees ALL social domains', () => {
    const communityAutomations = getAutomationsByRole('community');
    const domains = new Set(communityAutomations.map(a => a.domain));
    expect(domains).toContain('connect-people');
    expect(domains).toContain('community-groups');
    expect(domains).toContain('events-live-rooms');
    expect(domains).toContain('sharing-growth');
    expect(domains).toContain('engagement-loops');
    expect(domains).toContain('personalization-engines');
    expect(domains).toContain('memory-intelligence');
  });

  test('community sees ALL business/creator automations (shop, services, products)', () => {
    const communityAutomations = getAutomationsByRole('community');
    const ids = communityAutomations.map(a => a.id);
    // Business Hub — community creates businesses
    expect(ids).toContain('AP-1101'); // Service Listing Publication
    expect(ids).toContain('AP-1102'); // Product Listing
    expect(ids).toContain('AP-1103'); // Discover Personalization
    expect(ids).toContain('AP-1104'); // Client-Service Matching
    expect(ids).toContain('AP-1106'); // Shop Setup Wizard
    expect(ids).toContain('AP-1107'); // Product Review Follow-Up
    expect(ids).toContain('AP-1108'); // Creator Analytics
    expect(ids).toContain('AP-1110'); // Cross-Sell
  });

  test('community sees ALL creator payment automations', () => {
    const communityAutomations = getAutomationsByRole('community');
    const ids = communityAutomations.map(a => a.id);
    expect(ids).toContain('AP-0706'); // Creator Stripe Connect Onboarding
    expect(ids).toContain('AP-0707'); // Creator Payout Monitoring
    expect(ids).toContain('AP-0710'); // Monetization Readiness
    expect(ids).toContain('AP-0711'); // Weekly Earnings Report
  });

  test('community sees ALL live rooms commerce (creator side)', () => {
    const communityAutomations = getAutomationsByRole('community');
    const ids = communityAutomations.map(a => a.id);
    expect(ids).toContain('AP-1201'); // Paid Live Room Setup
    expect(ids).toContain('AP-1202'); // Booking & Payment (consumer)
    expect(ids).toContain('AP-1203'); // Upsell (consumer)
    expect(ids).toContain('AP-1205'); // Post-Session Revenue Report
    expect(ids).toContain('AP-1207'); // Recurring Session Scheduling
    expect(ids).toContain('AP-1209'); // Free Trial Session
  });

  test('community does NOT see patient-only health automations', () => {
    const communityAutomations = getAutomationsByRole('community');
    const ids = communityAutomations.map(a => a.id);
    // These require health data / clinical relationship
    expect(ids).not.toContain('AP-0608'); // Biomarker Trend Analysis
    expect(ids).not.toContain('AP-0609'); // Quality-of-Life Recommendations
    expect(ids).not.toContain('AP-0610'); // Wearable Anomaly Detection
    expect(ids).not.toContain('AP-0611'); // Vitana Index Weekly
    expect(ids).not.toContain('AP-0612'); // Professional Referral
  });

  test('community does NOT see platform ops', () => {
    const communityAutomations = getAutomationsByRole('community');
    const platformIds = communityAutomations
      .filter(a => a.domain === 'platform-operations')
      .map(a => a.id);
    expect(platformIds.length).toBe(0);
  });
});

// =============================================================================
// 4. Professional — medical doctor only, NOT business creator
// =============================================================================

describe('professional — medical/clinical scope only', () => {
  test('professional sees clinical health automations', () => {
    const proAutomations = getAutomationsByRole('professional');
    const ids = proAutomations.map(a => a.id);
    expect(ids).toContain('AP-0601'); // PHI Redaction Gate (clinical)
    expect(ids).toContain('AP-0602'); // Health Report Summarization (clinical)
    expect(ids).toContain('AP-0603'); // Consent Check (clinical)
    expect(ids).toContain('AP-0607'); // Lab Report Ingestion (doctor uploads)
  });

  test('professional does NOT see business/creator automations', () => {
    const proAutomations = getAutomationsByRole('professional');
    const ids = proAutomations.map(a => a.id);
    // Business is for community users, not medical professionals
    expect(ids).not.toContain('AP-1101'); // Service Listing
    expect(ids).not.toContain('AP-1106'); // Shop Setup Wizard
    expect(ids).not.toContain('AP-0706'); // Creator Stripe Onboarding
    expect(ids).not.toContain('AP-0711'); // Weekly Earnings Report
    expect(ids).not.toContain('AP-1201'); // Paid Live Room Setup
  });

  test('professional sees social/engagement automations (member role)', () => {
    const proAutomations = getAutomationsByRole('professional');
    const ids = proAutomations.map(a => a.id);
    expect(ids).toContain('AP-0101'); // Daily Match Delivery
    expect(ids).toContain('AP-0501'); // Morning Briefing
  });
});

// =============================================================================
// 5. Patient — health data recipient
// =============================================================================

describe('patient — health intelligence focus', () => {
  test('patient sees all health automations', () => {
    const patientAutomations = getAutomationsByRole('patient');
    const healthIds = patientAutomations
      .filter(a => a.domain === 'health-wellness')
      .map(a => a.id);
    expect(healthIds).toContain('AP-0601'); // PHI Redaction Gate
    expect(healthIds).toContain('AP-0607'); // Lab Report Ingestion
    expect(healthIds).toContain('AP-0608'); // Biomarker Trend
    expect(healthIds).toContain('AP-0611'); // Vitana Index Weekly
    expect(healthIds).toContain('AP-0612'); // Professional Referral
  });

  test('patient sees social/engagement automations (member role)', () => {
    const patientAutomations = getAutomationsByRole('patient');
    const ids = patientAutomations.map(a => a.id);
    expect(ids).toContain('AP-0101'); // Daily Match Delivery
    expect(ids).toContain('AP-0501'); // Morning Briefing
    expect(ids).toContain('AP-1208'); // Consultation Matching
  });

  test('patient sees marketplace consumer automations', () => {
    const patientAutomations = getAutomationsByRole('patient');
    const ids = patientAutomations.map(a => a.id);
    expect(ids).toContain('AP-1103'); // Discover Personalization
    expect(ids).toContain('AP-1104'); // Client-Service Matching
    expect(ids).toContain('AP-1202'); // Live Room Booking
  });
});

// =============================================================================
// 6. Staff / Admin / Developer — operational roles
// =============================================================================

describe('staff — back-office hospital/lab/enterprise', () => {
  test('staff sees platform ops', () => {
    const staffAutomations = getAutomationsByRole('staff');
    const ids = staffAutomations.map(a => a.id);
    expect(ids).toContain('AP-1002'); // Governance Flag Monitoring
  });

  test('staff does NOT see health intelligence or business', () => {
    const staffAutomations = getAutomationsByRole('staff');
    const healthIds = staffAutomations.filter(a => a.domain === 'health-wellness').map(a => a.id);
    expect(healthIds.length).toBe(0);
    const bizIds = staffAutomations.filter(a => a.domain === 'business-hub-marketplace').map(a => a.id);
    expect(bizIds.length).toBe(0);
  });
});

describe('developer — internal platform dev', () => {
  test('developer sees only platform ops and universal automations', () => {
    const devExec = getExecutableAutomationsForRole('developer');
    for (const a of devExec) {
      const isOps = a.domain === 'platform-operations';
      const isAll = a.targetRoles === 'all';
      expect(isOps || isAll).toBe(true);
    }
  });

  test('developer sees zero health automations', () => {
    const devAutomations = getAutomationsByRole('developer');
    const healthIds = devAutomations.filter(a => a.domain === 'health-wellness').map(a => a.id);
    expect(healthIds.length).toBe(0);
  });
});

// =============================================================================
// 7. Cross-domain role isolation
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

  test('creator automations (AP-1101, AP-1106, AP-0706) target community, NOT professional', () => {
    const creatorIds = ['AP-1101', 'AP-1106', 'AP-0706'];
    for (const id of creatorIds) {
      const def = getAutomation(id)!;
      expect(automationTargetsRole(def, 'community')).toBe(true);
      expect(automationTargetsRole(def, 'professional')).toBe(false);
    }
  });

  test('clinical automations (AP-0601, AP-0603, AP-0607) target both patient AND professional', () => {
    const clinicalIds = ['AP-0601', 'AP-0603', 'AP-0607'];
    for (const id of clinicalIds) {
      const def = getAutomation(id)!;
      expect(automationTargetsRole(def, 'patient')).toBe(true);
      expect(automationTargetsRole(def, 'professional')).toBe(true);
    }
  });

  test('payment retry (AP-0701) targets all roles', () => {
    const def = getAutomation('AP-0701')!;
    expect(def.targetRoles).toBe('all');
  });
});

// =============================================================================
// 8. Registry summary
// =============================================================================

describe('getRegistrySummary — role breakdown', () => {
  test('summary includes role counts', () => {
    const summary = getRegistrySummary();
    expect(summary.roles).toBeDefined();
    for (const role of ['patient', 'professional', 'community', 'admin', 'staff', 'developer']) {
      expect(typeof summary.roles[role]).toBe('number');
    }
  });

  test('community has the most automations (broadest audience, primary onboarding)', () => {
    const summary = getRegistrySummary();
    expect(summary.roles.community).toBeGreaterThanOrEqual(summary.roles.patient);
    expect(summary.roles.community).toBeGreaterThanOrEqual(summary.roles.professional);
    expect(summary.roles.community).toBeGreaterThanOrEqual(summary.roles.staff);
    expect(summary.roles.community).toBeGreaterThanOrEqual(summary.roles.developer);
  });
});
