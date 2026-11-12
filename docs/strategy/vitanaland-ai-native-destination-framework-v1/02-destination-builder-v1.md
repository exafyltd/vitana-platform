# Destination Builder V1

**Status:** Detailed design baseline; not implementation authorization. **Version:** 0.1.

## 1. Purpose and promise
The Destination Builder lets a participant create a new destination or connect an existing business through natural-language interaction with Vitana AI or an authorized external agent. The participant describes the outcome; the platform discovers context, proposes a plan, asks only essential questions, configures a Destination Skeleton, connects approved sources/capabilities, validates and guides activation.

It is not a form wizard, website-only generator or independent execution engine. It orchestrates the Destination Framework, Knowledge Builder, Integration Fabric, Agent Gateway and existing execution foundations.

## 2. Participants and modes
Supported participants: existing business owner/operator, professional/provider, entrepreneur, creator/individual and authorized representative. The Builder must establish who is acting, on whose behalf and with what authority.

Three guidance modes share one underlying engine:
- **Do it for me:** sensible defaults, minimal questions, authorized execution.
- **Connect my existing business:** discovery-first connection of websites, accounts and operating systems.
- **Build it with me:** collaborative planning, previews and participant direction.

These modes alter interaction and autonomy, not the data model. Community onboarding remains separate; a community member may later enter the business journey through an explicit role/organization transition.

## 3. Goals and non-goals
Goals: no technical setup burden; preserve existing identity, brand and systems; avoid redundant questions; disclose permissions and costs; produce a valid, versioned Skeleton; verify real capabilities; support ongoing maintenance.

Non-goals: replacing an ERP/CRM/CMS/booking system by default; treating a website crawl as transaction permission; fabricating licences, outcomes or credentials; bypassing approvals; guaranteeing a complete operating business when essential information or providers are missing.

## 4. End-to-end workflow
**A. Intent and identity:** capture the goal; classify existing/new business; authenticate; resolve tenant/organization; verify authority; explain draft versus published state.

**B. Discovery:** for existing businesses, discover public website information and candidate providers/capabilities. For new ventures, clarify purpose, audience, geography, offerings and operating model. Mark every fact as observed, inferred or confirmed. A domain or social handle is not proof of ownership.

**C. Gap analysis:** identify known facts and provenance, missing critical details, contradictions, candidate archetype, required capabilities, permissions, costs and confirmation needs. Produce a readable plan and structured change set.

**D. Construction:** create/update a draft Skeleton revision using controlled domain operations. Configure identity, brand, archetype, pages, content references, knowledge scope, capabilities, sources, AI profile and access policy. Never write directly to underlying tables.

**E. Connections and knowledge:** invoke Integration Fabric and Knowledge Builder. Request scoped authorization, ingest approved sources, map capabilities and verify access. Credentials remain in secure connection storage.

**F. Preview and validation:** show what exists, what is connected, what remains unconfirmed, which capabilities work, external costs and publication blockers. Run schema, semantic, dependency, security, content and runtime checks.

**G. Activation:** obtain required approvals, publish through lifecycle services, verify the published revision and return the destination entry point. Hand ongoing maintenance to shared services.

## 5. Adaptive conversation
Ask one focused question at a time where practical. Prefer source discovery over manual data entry. Ask only when the answer materially changes the outcome. Explain permissions and costs. Confirm ownership, terms, prices and regulated claims. Let optional information be deferred. Maintain a visible summary of confirmed decisions and outstanding items. Do not expose schema, tenant IDs or connector jargon to ordinary users.

## 6. Change sets and approvals
Every operation records participant intent, actor, tenant/destination, base revision, proposed changes, dependencies, capability actions, estimated credit/external cost, required permissions, validation results, approvals, execution state and evidence.

Routine reversible changes may execute under standing authority. Require contextual approval for new data scopes, material spending, external publishing, legal commitments, ownership changes, sensitive-data use and irreversible actions. Approval binds to the exact proposal and parameters; material changes invalidate it.

## 7. Existing-business path
Identify authorized representative; discover public presence; identify existing systems; propose a connection map; obtain provider scopes; import/map approved information; configure Vitanaland as an additional channel; verify reads and writes separately; preview and activate. Do not force migration or replacement. Where two systems can write the same field, define system-of-record and conflict rules first.

## 8. New-business path
Help define purpose, audience, value proposition, services/products, delivery model, geography, brand, pricing, booking/communication/fulfilment needs, credentials, policies and disclosures. AI may draft, but participant-approved facts remain distinct. Never invent qualifications, licences, reviews, customers or outcomes.

## 9. Readiness and failure handling
Report readiness by identity, content, knowledge, capabilities, integration, governance, commercial/legal and runtime dimensions. Distinguish blockers, warnings, optional items, not applicable and not assessed.

Handle conflicts, unsupported providers, denied/expired grants, partial imports, validation errors, rate limits, budget exhaustion, worker interruption and concurrent edits. Make work resumable and idempotent. Reconcile uncertain external side effects before retrying; never duplicate bookings, orders or payments.

## 10. Security and observability
Every operation is scoped to authenticated actor, tenant, organization and destination. Delegated agents receive minimum scopes. Measure time to valid draft/first capability, source reuse, question count, authorization success, validation failures, estimate accuracy, publication defects and participant corrections. Optimize for quality and trust, not speed alone.

## 11. Acceptance criteria
- All modes converge on the same Skeleton.
- Identity/authority/tenant are checked before writes.
- Discovery avoids repeated questions.
- Observed, inferred and confirmed facts remain distinct.
- Changes can be previewed and validated.
- Costs and permissions are disclosed.
- Partial work resumes safely.
- External effects are reconciled.
- Activation is verified.
- Existing systems are extended, not forcibly replaced.

## 12. Open decisions
Minimum onboarding questions; authority verification; change-set API; autonomy by action class; readiness thresholds; preview technology; credit estimates and approval thresholds; exact ownership across existing services.

**Guardrail:** map current identity, tenancy, Agent Gateway, Autopilot and worker execution before proposing new services. No production changes are authorized.