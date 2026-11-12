# Integration Fabric V1

**Status:** Detailed design baseline; not implementation authorization. **Version:** 0.1.

## 1. Purpose
A single provider-agnostic fabric connects destinations to websites, documents, social accounts and business systems. It standardizes discovery, authorization, mapping, execution, synchronization, monitoring and audit. It lets a business add Vitanaland as another channel without replacing its current systems.

## 2. Logical responsibilities
- **Connector registry:** provider, supported versions, capabilities, auth methods, scopes, limits, regions and status.
- **Capability registry:** vendor-neutral contracts such as catalogue, inventory, orders, payments, bookings, appointments, events, CRM and messaging.
- **Connection service:** tenant/destination association, consent, scopes, credential references, expiry and revocation.
- **Mapping layer:** provider-specific to canonical data/event contracts.
- **Runtime:** reads, writes, webhooks, scheduled sync and event-driven actions.
- **Reconciliation/monitoring:** health, sync lag, failed actions, drift and uncertain outcomes.
- **Usage/audit:** attribute actions to tenant, destination, actor, agent and capability.

These are logical boundaries, not a mandate for one microservice per responsibility. Map them to existing AWS-native services first.

## 3. Capability contracts
Each capability defines stable namespace/name, semantic version, supported operations, input/output schemas, scopes, side-effect class, idempotency, errors, pagination, rate constraints, data classification and events. Providers implement adapters and declare conformance. A connector must expose only operations it reliably supports.

Example: a booking connector may support availability reads but not reservation creation. The capability binding must express this partial support rather than claim full booking capability.

## 4. Core entities
Provider, connector definition, capability definition, connection, grant, binding, mapping, sync job, operation, webhook subscription and health observation. Every tenant-owned entity carries enforceable tenant scope. Sharing a connection across destinations requires an explicit governed relationship.

## 5. Connection lifecycle
Proposed states: discovered → authorization_pending → authorized → configuring → validating → active; degraded, reauthorization_required, revoked, disconnected and failed are exception/terminal states. Final transitions require provider-specific treatment.

Flow: discover connector; explain value; disclose scopes; obtain provider authorization; store credentials in secure secret service; verify account/resource; map capabilities; perform safe verification; activate only verified capabilities; monitor expiry and health. Revocation immediately blocks new operations.

## 6. Knowledge versus operations
Represent source modes explicitly:
- Public knowledge source (website): content only.
- Document ingestion: knowledge only.
- Read integration: current authorized data.
- Action integration: external side effects.
- Event integration: authenticated provider events.
- Bidirectional integration: reads/writes with conflict rules.

Website connection never implies booking/payment/order authority.

## 7. Data and synchronization
Support on-demand reads, scheduled incremental sync, webhooks, bounded authorized imports and reconciliation reads. Preserve provider IDs, source timestamps, currency, units, timezone, locale and provenance. Version mappings, detect schema drift and route unmappable records to review. Define system-of-record per domain before enabling bidirectional writes.

## 8. Safe execution
Every operation carries actor/agent, tenant/destination/connection, capability/version, validated input, permission decision, idempotency key, limits, audit correlation and provider result. For uncertain outcomes, query/reconcile provider before retrying. Never blindly retry payments, bookings, orders or cancellations.

## 9. Webhooks
Verify signatures, bind event to connection/tenant, deduplicate provider event IDs, tolerate out-of-order delivery, retry safely and expose delivery state. Webhook payloads are data, not authorization.

## 10. Security and commercial controls
Secrets never appear in Skeletons, model prompts or ordinary logs. Enforce least privilege on every operation, revocation, encryption, tenant isolation, data minimization and source-specific retention. Attribute provider costs separately from AI credits and subscriptions; disclose paid services before activation.

## 11. Monitoring and recovery
Track auth state, latency, provider errors, rate limits, freshness, mapping failures, webhook lag, action success and reconciliation. Use bounded backoff, circuit breakers, dead-letter review and safe replay. Avoid retrying uncertain side effects without reconciliation.

## 12. Acceptance criteria
- Multiple providers implement one capability contract.
- Capability conformance is testable.
- Knowledge-only sources cannot be mistaken for transaction capabilities.
- Secrets are external to the Skeleton.
- Connections have tenant scope, consent and revocation.
- Side effects are permission-checked and idempotent.
- Events are authenticated/deduplicated.
- Errors and costs are observable and attributable.

## 13. Open decisions
Initial provider/capability catalogue; connector runtime; OAuth/non-OAuth patterns; canonical event envelope; system-of-record rules; sync freshness; webhook guarantees; conformance harness; service boundaries.

**Guardrail:** inventory existing connectors, MCP tools and integration services before adding anything. No production migration or write is authorized.