# Vitanaland Agent Gateway V1

**Status:** Detailed design baseline; not implementation authorization. **Version:** 0.1.

## 1. Purpose
Provide a provider-agnostic, secure interface for external AI agents to discover Vitanaland, understand capabilities, authenticate, obtain scoped delegation and perform authorized actions. Support ChatGPT/OpenAI, Claude/Anthropic, Gemini/Google, Grok/xAI and future agents through MCP/API contracts.

The Gateway is not the system of record for business data, credentials, destination structure or model execution. It delegates to authoritative services.

## 2. Responsibilities
Agent/client discovery; capability catalogue; authentication; principal/organization delegation; consent/grants; MCP/API transport and version negotiation; capability invocation; policy/approval; rate limits; audit/usage; revocation and session lifecycle.

## 3. Discovery
Expose ecosystem description, public destination metadata, capability identifiers/versions, operation schemas, required scopes, side-effect classes, approval requirements, limits and error contracts. Do not reveal private destinations or tenant data through unauthenticated discovery. Discovery is not authorization.

## 4. Identity and delegation
Keep distinct human principal, organization/tenant principal, agent/client, grant, session/token and destination. Agent acts on behalf of a principal only under a verifiable grant. Grant specifies principal, agent, tenant/destination, allowed capabilities/actions, data scopes, purpose, expiry, revocation, approval policy and budget/usage limits. Asking to connect a business initiates consent; it is not unlimited authority.

## 5. Authorization
Evaluate authenticated principal, client identity, tenant membership, organization authority, destination role, operation, data classification, consent, context, risk, budget and rate policy on every call. Reading public information does not grant customer-data access; searching availability does not grant reservation creation/cancellation.

## 6. Action classes
Read; reversible draft/configuration; external side effect; financial; sensitive-data; public/legal publishing; ownership/security. Policy determines whether standing grants suffice or contextual approval is required. Approval binds to exact target, parameters, action and cost; changed parameters require renewed approval.

## 7. MCP/API domain operations
Discover ecosystem/destinations/capabilities; read authorized context; propose Skeleton change sets; validate/preview; request consent; invoke capability; inspect execution status/results; inspect permitted usage/audit; revoke grants. Do not expose raw database access or unrestricted shell execution.

## 8. Request/response envelope
Requests resolve correlation ID, agent/client, principal/delegation, tenant/destination, capability/version, operation/input, grant, idempotency key and trace metadata. Responses return structured result or typed error, status, source evidence, approval requirement, usage/cost and correlation ID. Never expose secrets or internal stack traces.

## 9. External-agent journey
Agent discovers Vitanaland → participant authenticates → tenant/destination resolved → requested scopes explained → participant grants/rejects → agent sees only authorized resources → each action receives policy check → results/usage audited → grant can be narrowed/revoked.

## 10. Threats and controls
Address impersonation, confused deputy, prompt injection, tool overreach, token theft/replay, cross-tenant leakage, malicious connector output and exfiltration. Enforce audience/issuer/expiry/scope, short-lived credentials where possible, idempotency, rate limits, input/output validation, tool allowlists, audit, revocation and untrusted-content isolation. Agent-supplied content is data, not policy.

## 11. Observability
Record actor, principal, agent/client, tenant/destination, grant, capability, policy decision, approval, result, provider reference, cost and error. Minimize sensitive payload retention.

## 12. Acceptance criteria
Independent agent ecosystems use common contracts; discovery is separate from authorization; every action has accountable principal and tenant; grants are narrow, expiring, inspectable and revocable; side effects are idempotent and policy-checked; private resources remain private; all actions are attributable.

## 13. Open decisions
MCP transport/version; OAuth/client registration; delegation token; consent UI; public/authenticated discovery; capability schema/version negotiation; approval continuation; agent assurance levels; quotas/abuse; existing Gateway reuse.

**Guardrail:** map current Agent Gateway/MCP/auth implementation and multi-tenant policies before adding endpoints or services.