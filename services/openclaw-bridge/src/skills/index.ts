/**
 * Skill Registry - Central registry for all Vitana OpenClaw skills.
 *
 * Skills are loaded at startup and made available to the bridge
 * for routing incoming OpenClaw tasks to the correct handler.
 */

import * as supabaseSkill from './vitana-supabase';
import * as stripeSkill from './vitana-stripe';
import * as dailySkill from './vitana-daily';
import * as healthSkill from './vitana-health';
import * as notificationsSkill from './vitana-notifications';
import * as schedulingSkill from './vitana-scheduling';
import * as documentsSkill from './vitana-documents';
import * as vtnWalletSkill from './vitana-vtn-wallet';
import * as knowledgeSkill from './vitana-knowledge';
import * as analyticsSkill from './vitana-analytics';
import * as complianceSkill from './vitana-compliance';
import * as integrationsSkill from './vitana-integrations';
import * as automationsSkill from './vitana-automations';
import * as onboardingSkill from './vitana-onboarding';
import * as communitySkill from './vitana-community';
import * as messagingSkill from './vitana-messaging';
import * as walletSkill from './vitana-wallet';
import * as marketplaceSkill from './vitana-marketplace';
import * as monetizationSkill from './vitana-monetization';
import * as liveroomsSkill from './vitana-liverooms';
import * as voiceSkill from './vitana-voice';
import * as diarySkill from './vitana-diary';
import * as topicsSkill from './vitana-topics';
import * as adminOpsSkill from './vitana-admin-ops';
import * as cicdSkill from './vitana-cicd';
import * as llmRoutingSkill from './vitana-llm-routing';
import * as assessmentsSkill from './vitana-assessments';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillAction {
  (input: unknown): Promise<unknown>;
}

export interface SkillModule {
  actions: Record<string, SkillAction>;
  SKILL_META: {
    name: string;
    description: string;
    actions: string[];
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const SKILLS: Record<string, SkillModule> = {
  'vitana-supabase': supabaseSkill,
  'vitana-stripe': stripeSkill,
  'vitana-daily': dailySkill,
  'vitana-health': healthSkill,
  'vitana-notifications': notificationsSkill,
  'vitana-scheduling': schedulingSkill,
  'vitana-documents': documentsSkill,
  'vitana-vtn-wallet': vtnWalletSkill,
  'vitana-knowledge': knowledgeSkill,
  'vitana-analytics': analyticsSkill,
  'vitana-compliance': complianceSkill,
  'vitana-integrations': integrationsSkill,
  'vitana-automations': automationsSkill,
  'vitana-onboarding': onboardingSkill,
  'vitana-community': communitySkill,
  'vitana-messaging': messagingSkill,
  'vitana-wallet': walletSkill,
  'vitana-marketplace': marketplaceSkill,
  'vitana-monetization': monetizationSkill,
  'vitana-liverooms': liveroomsSkill,
  'vitana-voice': voiceSkill,
  'vitana-diary': diarySkill,
  'vitana-topics': topicsSkill,
  'vitana-admin-ops': adminOpsSkill,
  'vitana-cicd': cicdSkill,
  'vitana-llm-routing': llmRoutingSkill,
  'vitana-assessments': assessmentsSkill,
};

/**
 * Get a registered skill by name.
 */
export function getSkill(name: string): SkillModule | undefined {
  return SKILLS[name];
}

/**
 * Execute a skill action by skill name and action name.
 */
export async function executeSkillAction(
  skillName: string,
  actionName: string,
  input: unknown,
): Promise<unknown> {
  const skill = SKILLS[skillName];
  if (!skill) {
    throw new Error(`Skill not found: ${skillName}. Available: ${Object.keys(SKILLS).join(', ')}`);
  }

  const action = skill.actions[actionName];
  if (!action) {
    throw new Error(
      `Action "${actionName}" not found in skill "${skillName}". Available: ${skill.SKILL_META.actions.join(', ')}`,
    );
  }

  return action(input);
}

/**
 * List all registered skills and their actions.
 */
export function listSkills(): Array<{ name: string; description: string; actions: string[] }> {
  return Object.values(SKILLS).map((s) => ({
    name: s.SKILL_META.name,
    description: s.SKILL_META.description,
    actions: s.SKILL_META.actions,
  }));
}

/**
 * Check if a skill+action combination exists.
 */
export function hasSkillAction(skillName: string, actionName: string): boolean {
  const skill = SKILLS[skillName];
  return skill !== undefined && actionName in skill.actions;
}
