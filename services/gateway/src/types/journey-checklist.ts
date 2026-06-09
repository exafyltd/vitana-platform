/**
 * VTID-03277 — Guided Journey checklist (curriculum) shared types (P2).
 *
 * The 90-session / 250-topic onboarding curriculum. `ChecklistTopic` is the
 * full admin/editor view; `PublicChecklistTopic` is the user-facing subset My
 * Journey renders — it deliberately omits internal fields (voice script source,
 * safety level, manual path, audit ids) per the design spec.
 */

export type ChecklistStatus = 'draft' | 'published' | 'disabled';
export type BusinessGate = 'curious' | 'active' | 'builder';

export interface ChecklistExplanation {
  whatItIs: string | null;
  userBenefit: string | null;
  whenToUse: string | null;
  tryThis: string | null;
}

export interface ChecklistTopic {
  topicId: string;
  curriculumVersion: string;
  session: number;
  position: number;
  chapterId: string;
  displayLabel: string;
  title: string | null;
  shortDescription: string | null;
  vitanaVoiceScript: string | null;
  explanation: ChecklistExplanation;
  guidedPracticeTarget: string | null;
  practiceActionType: string | null;
  completionEvent: string | null;
  unlockRule: string | null;
  safetyLevel: string;
  businessGate: BusinessGate | null;
  sourceRefs: string[];
  manualPath: string | null;
  fallbackTopicId: string | null;
  status: ChecklistStatus;
  enabled: boolean;
  updatedByAdminId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** User-facing topic — what My Journey / Topic Explanation render. */
export interface PublicChecklistTopic {
  topicId: string;
  session: number;
  position: number;
  chapterId: string;
  displayLabel: string;
  shortDescription: string | null;
  explanation: ChecklistExplanation;
  guidedPracticeTarget: string | null;
  businessGate: BusinessGate | null;
}

export interface ChecklistValidationIssue {
  rule: string;
  detail: string;
  topicIds?: string[];
}

export interface ChecklistValidationResult {
  ok: boolean;
  errors: ChecklistValidationIssue[];
  summary: {
    sessionCount: number;
    topicCount: number;
    enabledCount: number;
  };
}

export interface ChecklistVersion {
  id: string;
  versionLabel: string;
  curriculumVersion: string;
  status: 'published' | 'rolled_back' | 'archived';
  sessionCount: number;
  topicCount: number;
  isCurrent: boolean;
  note: string | null;
  publishedBy: string | null;
  publishedAt: string;
}

/** Raw DB row for journey_checklist_topics (snake_case). */
export interface ChecklistTopicRow {
  topic_id: string;
  curriculum_version: string;
  session: number;
  position: number;
  chapter_id: string;
  display_label: string;
  title: string | null;
  short_description: string | null;
  vitana_voice_script: string | null;
  explanation_what_it_is: string | null;
  explanation_user_benefit: string | null;
  explanation_when_to_use: string | null;
  explanation_try_this: string | null;
  guided_practice_target: string | null;
  practice_action_type: string | null;
  completion_event: string | null;
  unlock_rule: string | null;
  safety_level: string;
  business_gate: BusinessGate | null;
  source_refs: string[] | null;
  manual_path: string | null;
  fallback_topic_id: string | null;
  status: ChecklistStatus;
  enabled: boolean;
  updated_by_admin_id: string | null;
  created_at: string;
  updated_at: string;
}
