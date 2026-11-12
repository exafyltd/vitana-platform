# Vitana AI Knowledge Builder V1

**Status:** Detailed design baseline; not implementation authorization. **Version:** 0.1.

## 1. Purpose
Turn participant-provided and authorized connected information into governed, traceable knowledge Vitana AI can use to represent a person, community or business accurately. The same framework may support individual profiles and business destinations, with separate ownership and consent scopes.

## 2. Three knowledge layers
1. **Universal ecosystem knowledge:** Vitanaland and Longevity Economy context, subject to platform policy.
2. **Destination-specific knowledge:** identity, mission, expertise, offerings, audience, policies, FAQs, tone and operations.
3. **Live connected context:** current authorized facts from business systems such as prices, inventory, availability and order state.

Never merge these into one unscoped pool. Retrieval applies tenant, user, destination, purpose and sensitivity policy.

## 3. Source types
Public websites; PDF/Word/PowerPoint/spreadsheets/text; supported images/media; authorized social accounts; business applications; recorded conversations/audio/video; participant-entered information. Each source record stores source ID/type, owner, tenant/destination, origin, authorization, collection/source timestamps, processing version, permitted purpose, provenance and refresh/revocation policy.

## 4. Ingestion pipeline
Register source → authorize → acquire within boundaries → extract → normalize language/structure/entities → classify domain/sensitivity → detect duplicates/conflicts → create candidate knowledge records → assess quality/confidence → request confirmation where needed → index in scoped retrieval → monitor and refresh. Processing must be resumable and idempotent. Significant extraction failure must not be hidden behind a “complete” status.

## 5. Knowledge modules
Identity/ownership; mission/positioning; expertise/credentials; products/services; audience/customer needs; policies/terms/FAQs; communication/tone/languages; operations; locations/service coverage; relationships; evidence/outcomes/approved claims. This is an internal model, not a participant-facing form.

## 6. Truth and provenance
Each claim has a state:
- **Source:** directly present in a source with location reference.
- **AI interpretation:** summary, classification or inference.
- **Confirmed:** explicitly approved by an authorized participant or verified by authoritative process.
- **Disputed/withdrawn:** challenged, superseded or revoked.

Store source URL/page/slide/sheet/record/timestamp; extraction method/version; confidence/quality; tenant/owner; first/last seen; confirmation actor/time; revision/supersession. AI inference must never silently become a credential, licence, clinical claim, price, guarantee or policy.

## 7. Confirmation policy
Require confirmation or authoritative verification for ownership, identity, credentials, licences, health/medical claims, outcomes, prices, guarantees, contractual terms and policies. Low-risk descriptive material can be batched for review. Conflicts are shown with source evidence, not silently resolved by model preference. Confidence is not truth.

## 8. Website understanding
Accept participant domain/URL; verify ownership for privileged access; crawl only public/authorized pages within boundaries; respect robots, access controls, rate limits and terms; exclude private/login content unless separately authorized; retain URL/crawl timestamp; detect changes; allow page exclusions; preview extracted facts. Website crawl creates knowledge, not transaction permission.

## 9. Documents and connected accounts
Preserve document version, page/slide/sheet/section provenance, tables, language, date and extraction warnings. Deduplicate multiple uploads and detect cross-document contradictions. Social connections use authorized provider scopes and must not assume access to private messages or followers' personal information. Business-system live facts flow through Integration Fabric capabilities.

## 10. Retrieval and context
Apply tenant/destination/user authorization before retrieval; then layer, purpose, sensitivity, confirmation, freshness, supersession, authority and locale. Return provenance with claims. Keep personal memory, universal knowledge and destination knowledge separate. A person's personal context is not business knowledge without consent.

## 11. Refresh, correction and deletion
Support scheduled/event refresh, source change detection, reprocessing, corrections, confirmation, disconnection, revocation, supersession and deletion/retention propagation to derived records and indexes. Stop new access on revocation. Treatment of already confirmed/published facts must follow explicit retention and provenance policy.

## 12. Security and quality
Tenant isolation at ingestion/storage/index/retrieval; encryption and raw-data minimization; source permission compliance; private/public separation; prompt-injection resistance; no execution of instructions inside documents; audit source and consent. Measure extraction coverage, failures, freshness, duplicates, contradictions, confirmation rate, retrieval precision and correction latency.

## 13. Acceptance criteria
Every item has provenance and tenant scope; source/interpretation/confirmed states are separate; retrieval enforces permissions; website knowledge does not imply transactions; conflicts/gaps are visible; sources can be corrected/revoked; personal and destination knowledge remain isolated.

## 14. Open decisions
Ontology and record schema; confidence calibration; crawl/refresh policy; supported formats; retention/deletion; vector/graph/hybrid retrieval; authority ranking; memory interoperability/consent; provenance API.

**Guardrail:** inspect current memory, indexing, retrieval, document ingestion and connected-account systems first. Reuse existing infrastructure; do not create a parallel memory stack.