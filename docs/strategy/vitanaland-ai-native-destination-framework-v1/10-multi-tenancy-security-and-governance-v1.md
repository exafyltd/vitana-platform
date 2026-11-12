# Multi-Tenancy, Security and Governance V1

**Status:** Foundational requirements; reconcile with active implementation. **Version:** 0.1.

## 1. Purpose
Protect independent people, organizations, communities and destinations sharing Vitanaland infrastructure. This document is intentionally conservative because multi-tenancy work is ongoing.

## 2. Principles
Tenant isolation enforced in data/service layers; explicit ownership/scope; least privilege; purpose-bound revocable consent; scoped agent delegation; explicit shared-data classification; secure secret storage; auditable consequential actions; platform controls cannot be weakened by tenant settings; fail closed when identity/tenant context is missing.

## 3. Identity model
Keep human principal, organization, tenant, destination, membership/role, external agent/client, delegation/grant and service identity distinct. A user may belong to multiple organizations; this does not imply shared data. Tenant-to-organization cardinality must follow the active architecture, not be invented here.

## 4. Isolation enforcement
Check tenant scope at API entry, authorization, database queries/RLS, background jobs, events/webhooks, caches, search indexes, object storage, analytics/exports, AI retrieval/context assembly, logs and support tooling. Never rely on frontend filtering or caller-supplied tenant ID as security boundary.

## 5. Data classification
At minimum distinguish public ecosystem, public destination, tenant-private business, user-private personal, member-restricted, sensitive/regulated and platform-confidential operational data. Cross-tenant sharing requires explicit relationship, purpose, scope, duration and revocation.

## 6. Consent and delegation
Consent/grant records identify principal, source/capability, purpose, recipient/agent, tenant/destination, scopes, timestamp/policy version, expiry and revocation. Reading a website does not authorize private accounts; reading inventory does not authorize price changes or orders. Revalidate grant on every action.

## 7. Secrets and connected accounts
OAuth tokens, API keys, signing secrets and private keys live only in approved secure connection/secret services. Never store in Skeletons, knowledge records, model prompts, Git or ordinary logs. Support rotation, expiry, least privilege and incident response.

## 8. AI/knowledge controls
Authorize before retrieval/context assembly. Treat websites, documents, social content and provider responses as untrusted data. Prompt injection cannot change policy or permissions. Keep personal memory, destination knowledge and shared knowledge separate. Enforce model-provider data classification/residency rules. Redact sensitive traces.

## 9. Approval and governance
Policy evaluates action class: read, reversible draft/config, external side effect, financial, sensitive data, public/legal publishing, ownership/security. Platform controls are mandatory; tenants may tighten, never weaken them.

## 10. Audit
Record actor/principal/agent, tenant/organization/destination, action/target, grant/policy decision, approval, before/after revision, result/provider reference, timestamp and correlation ID. Minimize sensitive payloads.

## 11. Lifecycle rights
Define membership removal, agent revocation, source disconnection, correction, export, retention, deletion and derived-data propagation, ownership transfer, tenant suspension/closure. Deletion must consider indexes, caches, replicas, knowledge derivatives and external processors under legal retention rules.

## 12. Threat model
Assess cross-tenant leakage, confused deputy, token theft/replay, prompt injection, malicious connector/webhook, organization takeover, cache/index scope errors, worker tenant-context loss, insider misuse and analytics/log exfiltration. Assign preventive/detective controls, test coverage and incident owner.

## 13. Acceptance criteria
Server-resolved tenant context; all stores/workers preserve scope; sharing is explicit/revocable; grants enforced per operation; secrets excluded from manifests/prompts/logs; retrieval scoped; untrusted content cannot alter policy; consequential approvals; export/deletion includes derived systems; cross-tenant tests.

## 14. Open decisions
Tenant/organization cardinality; identity/membership authority; classification/retention; consent/grant schema; cross-tenant sharing; RLS/service authorization division; delegation tokens; residency/model policy; audit retention; incident/ownership transfer.

**Critical guardrail:** inspect active multi-tenancy plan, code, schema, RLS and migrations before any change. Do not create parallel tenancy tables or alter tenant semantics. No migration is authorized here.