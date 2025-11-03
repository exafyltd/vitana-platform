---
doc_id: DOC-00-0003
title: "Vitana Core Principles & Process Rules"
version: 0.1.0
status: draft
template: concept
owner: "CEO"
tags: [foundation, principles, process, rules]
related_vtids: []
related_docs: [DOC-00-0001, DOC-00-0002, DOC-30-0300, DOC-95-9500]
created_at: "2025-11-03"
updated_at: "2025-11-03"
---

# Vitana Core Principles & Process Rules

## 1. Purpose of This Document

This document defines the **non-negotiable principles and process rules** that govern the Vitana ecosystem. These principles serve as our constitution—the foundation upon which all product decisions, technical architectures, and operational processes are built.

**Why these principles exist:**
- Ensure alignment between our health & longevity mission (DOC-00-0001) and daily execution
- Provide clear decision-making criteria when facing trade-offs
- Maintain consistency across three tenants (Maxina, AlKalma, Earthlings) and infrastructure (DOC-30-0300)
- Protect member trust through transparent, predictable behavior

**How they are used:**
- **Product decisions:** "Does this feature align with Health-First and Human-Over-Screen principles?"
- **Code reviews:** "Is this change logged in OASIS? Does it have a VTID?"
- **Architecture Decision Records (ADRs):** Must reference and comply with relevant principles
- **Incident reviews:** "Which principle was violated, and how do we prevent recurrence?"
- **Roadmap prioritization:** Features that strengthen core principles take precedence

**Precedence:** When this document conflicts with other documentation, DOC-00-0003 takes precedence unless explicitly overridden through the ADR process (Section 8).

---

## 2. Product & UX Principles

### 2.1 Health-First, Not Engagement-First

**Principle:** Member well-being always trumps engagement metrics, retention, or revenue.

**Rules:**
- Do not use addictive dark patterns (infinite scroll, artificial urgency, manipulative notifications)
- Measure success by health outcomes (Vitana Index improvement) before engagement metrics (DAU, session length)
- If a feature increases screen time without improving health, reconsider or redesign it
- Autopilot should reduce unnecessary app interactions, not increase them

**Example:** Autopilot Autonomous Mode proactively sends health reminders but limits notifications to avoid notification fatigue—even if more notifications would boost engagement stats.

### 2.2 Human Relationships > Screen Time

**Principle:** Technology should facilitate real human connection, not replace it.

**Rules:**
- Maxina meetups and in-person events prioritized over purely digital experiences
- AlKalma telemedicine supplements (not replaces) local doctor relationships
- Earthlings retreats emphasize disconnection from devices and immersion in nature/community
- Social features must encourage offline interactions (e.g., "Meet at this Maxina event" not "Chat more online")

**Example:** The Social Longevity Graph suggests in-person meetups based on geographic proximity, not just online group chats.

### 2.3 Coherent Multi-Tenant Experience

**Principle:** One Vitana account, seamless experience across Maxina, AlKalma, and Earthlings.

**Rules:**
- Single sign-on (SSO) across all tenants
- Unified Credits and VTN balance visible everywhere
- Shared Vitana Index updates across all tenant activities
- Consistent navigation patterns (detailed in DOC-90-0900 Navigation Canon)
- Cross-tenant context: AlKalma doctor sees Earthlings retreat history (with member consent)

**Example:** A member books an Earthlings retreat, and their AlKalma doctor receives an OASIS event notification (with consent) to adjust their care plan accordingly.

### 2.4 Clarity in Pricing and Data Usage

**Principle:** No hidden costs, no surprise data usage, no deceptive practices.

**Rules:**
- All pricing displayed upfront in Credits or fiat equivalent
- Data sharing requires explicit, granular consent (not blanket "agree to terms")
- Credit earning and spending rules transparent and predictable
- VTN tokenomics documented publicly (supply, distribution, utility)
- Privacy policy written in plain language (in addition to legal version)

**Example:** Before sharing biomarker data with a research partner, members see: "This will share your anonymized blood test results with Stanford Longevity Lab for cardiovascular research. You'll earn 20 Credits/month. Revoke anytime."

### 2.5 Default-Safe UX

**Principle:** When in doubt, choose the option that protects member health, privacy, and financial interests.

**Rules:**
- Autopilot suggestions default to conservative recommendations (e.g., "consult a doctor" not "try this supplement")
- Financial transactions require confirmation (no one-click $1,000 retreat bookings)
- Data sharing defaults to "opt-in" not "opt-out"
- Health-critical features (medication reminders, symptom tracking) have redundancy and fail-safes

**Example:** If Autopilot detects conflicting health advice (e.g., two supplements that may interact), it flags for human review rather than proceeding.

---

## 3. Data, Privacy & Compliance Principles

### 3.1 Member Data Ownership

**Principle:** Members own 100% of their health data and can export or delete it at any time.

**Rules:**
- Full data export available in machine-readable format (JSON, CSV)
- Delete account = delete all personal health data within 30 days (OASIS events anonymized)
- No data lock-in: members can take Vitana Index history to other platforms
- Data portability complies with GDPR Article 20 standards

**Example:** A member clicks "Export My Data" and receives a complete archive of Vitana Index history, biomarkers, Credits transactions, and OASIS events related to their account.

### 3.2 Granular Consent and Revocation

**Principle:** Members control exactly what data is shared, with whom, and for how long.

**Rules:**
- Consent requests specify: data type, recipient, purpose, duration, compensation (if any)
- One-click revocation of any consent (effective within 24 hours)
- No "all or nothing" consent: members can share Vitana Index but withhold biomarkers
- Consent logged in OASIS for audit trail

**Example:** A member shares their Mental pillar score with an AlKalma therapist but withholds Physical and Nutritional pillars. They can revoke therapist access anytime.

### 3.3 Auditability via OASIS

**Principle:** All health-critical and financial events are logged in OASIS for transparency and compliance.

**Rules:**
- Every data access, sharing event, and consent change recorded in OASIS
- Members can query: "Who accessed my data in the last 90 days?"
- Professionals and partners see audit trails for their actions
- OASIS events immutable (append-only log) for regulatory compliance

**Example:** Member asks, "Who viewed my lab results?" and sees: "Dr. Smith (AlKalma) on 2025-10-15, Stanford Research Lab (anonymized) on 2025-10-28."

### 3.4 Security Baselines

**Principle:** Defense-in-depth security architecture with least-privilege access.

**Rules:**
- End-to-end encryption for health data in transit and at rest
- Service accounts follow least-privilege principle (GCP IAM roles)
- Secrets stored in GCP Secret Manager, never in code or environment variables
- Regular security audits, penetration testing, and vulnerability scanning
- Zero-trust network architecture (no implicit trust between services)

**Example:** The Gateway service can read OASIS events but cannot write to the vtid_tracking table. Only the VTID service has write access.

### 3.5 GDPR and HIPAA Alignment

**Principle:** Operate as if GDPR and HIPAA apply globally, even when not legally required.

**Rules:**
- Data minimization: collect only necessary health data
- Purpose limitation: use data only for stated purposes
- Storage limitation: delete or anonymize data after retention period (90 days–7 years depending on type)
- Business Associate Agreements (BAAs) with all health data processors
- Breach notification within 72 hours (GDPR standard)

**Example:** Even for members in countries without strict data laws, Vitana applies GDPR-level protections as baseline.

---

## 4. Autopilot & Agent Safety Principles

### 4.1 Bounded Autonomy

**Principle:** Agents execute approved tasks independently but escalate high-risk decisions to humans.

**Rules:**
- **Fully autonomous:** Logging health data, scheduling meetups, sending routine reminders, dev environment deployments
- **Requires approval:** Production deployments, financial transactions >$100, medical advice, data sharing consents
- **Never autonomous:** Diagnosing medical conditions, prescribing medications, irreversible data deletions
- Boundaries defined per agent type (see DOC-95-9500 for Autopilot specifics, DOC-30-0300 for DevOps agents)

**Example:** Autopilot can suggest "Your sleep score is low, consider earlier bedtime" but cannot say "You have insomnia, take this medication."

### 4.2 Never Pretend to Be Human

**Principle:** AI must identify itself and never impersonate human doctors, coaches, or staff.

**Rules:**
- All AI interactions clearly labeled: "Autopilot suggests..." or "AI-generated recommendation"
- No fake names or human personas for Autopilot
- Disclaimers on medical advice: "This is not a substitute for professional medical advice"
- Members can always request human handoff (e.g., "Connect me with an AlKalma doctor")

**Example:** Autopilot messages start with: "🤖 Autopilot: Based on your recent activity..." not "Hi, this is Sarah from Vitana..."

### 4.3 Escalation Rules for Health-Critical Decisions

**Principle:** When health risk is detected, escalate to licensed professionals immediately.

**Rules:**
- Autopilot triggers AlKalma doctor notification for: abnormal biomarkers, concerning symptoms, medication interactions
- Emergency situations (chest pain, suicidal ideation) generate immediate alerts and emergency contact prompts
- No automated medical diagnosis—only symptom tracking and professional referral
- Escalation logged in OASIS with reasoning and outcome

**Example:** Member logs "severe chest pain" in Start Stream. Autopilot immediately displays: "This may be an emergency. Call emergency services now. [Call 911] We're also notifying your AlKalma doctor."

### 4.4 Logging and Explainability

**Principle:** All agent actions are logged in OASIS with clear reasoning and traceability.

**Rules:**
- Every Autopilot recommendation includes: reasoning, data sources, confidence level
- OASIS events link to VTID for infrastructure changes (see Section 5)
- Members can ask: "Why did you suggest this?" and get plain-language explanation
- Agent decision logic auditable by compliance and medical review teams

**Example:** Autopilot suggests a supplement. Member clicks "Why?" and sees: "Your Nutritional pillar score (142/200) indicates low magnesium based on recent lab test (2025-10-28). Dr. Chen (AlKalma) previously recommended magnesium for sleep optimization."

### 4.5 Default-Safe Behavior on Uncertainty

**Principle:** When data is missing, conflicting, or uncertain, agents choose conservative paths.

**Rules:**
- Insufficient data → "I don't have enough information to recommend this. Consult your AlKalma doctor."
- Conflicting advice → Flag for human review, do not proceed
- Low confidence → Present options with caveats, do not choose unilaterally
- System errors → Fail safe (e.g., no notification sent > incorrect notification sent)

**Example:** If wearable data is missing for 3 days, Autopilot does not extrapolate—it says: "I haven't received sleep data recently. Please check your device sync."

---

## 5. DevOps, OASIS & VTID Principles

### 5.1 "If It's Not in OASIS, It Didn't Happen"

**Principle:** OASIS is the single source of truth for all system events, state, and audit trails.

**Rules:**
- Every deployment, PR merge, health data update, Credit transaction recorded in OASIS
- No reliance on tribal knowledge or external logs as primary record
- OASIS events queryable for debugging, compliance, and analysis
- Detailed in DOC-30-0300 (OASIS technical architecture)

**Example:** During an incident review, the team queries OASIS: "Show all deployment events and error logs for gateway service between 10:00–11:00 UTC" rather than checking multiple dashboards.

### 5.2 Every Meaningful Change Has a VTID

**Principle:** All work items—features, bugs, ops tasks, documentation—tracked via unique VTID (Vitana Task Identifier).

**Rules:**
- Format: `DOMAIN-CATEGORY-NUMBER` (e.g., `DEV-CICDL-0031`, `DOC-GLOSS-0002`)
- VTID in branch name, PR title, commit messages, OASIS events
- VTID lifecycle tracked in OASIS: created → in_progress → review → merged → deployed → verified → closed
- No production change without a VTID (exceptions require CTO approval + ADR)

**Example:** A bug fix PR titled `[BUG-API-0042] Fix token expiration handling` with branch `bugfix/BUG-API-0042-token-expiry` and commit message referencing the VTID.

### 5.3 No Production Change Without: VTID + Doc + Checks

**Principle:** Production deployments require traceability, documentation, and validation.

**Rules:**
- **VTID:** Unique identifier linking to all related artifacts
- **Doc:** Specification (for features), ADR (for architecture), or runbook (for ops changes)
- **Checks:** All CI/CD checks pass (lint, tests, security scan) per DOC-30-0300
- Manual approval required for production (automated for dev/staging)

**Example:** A production deployment of a new AlKalma telemedicine feature requires: `DEV-ALKL-0067` VTID, `DOC-20-0201` (AlKalma spec) updated, and all GitHub Actions checks green before merge.

### 5.4 Environment Separation and Safety

**Principle:** Changes flow through environments (dev → staging → prod) with increasing safety gates.

**Rules:**
- **Dev:** Auto-deploy on merge to `develop` branch, permissive testing
- **Staging:** Auto-deploy on merge to `main` branch, production-like environment
- **Prod:** Manual approval required, blue-green deployment, rollback tested
- No direct commits to `main` or `develop` (PR required)
- Production data never used in dev or staging (synthetic data only)

**Example:** A new Credits calculation algorithm is tested in dev for 3 days, validated in staging for 1 week with synthetic transactions, then deployed to prod with 10% traffic canary release.

### 5.5 Rollback-First Mindset

**Principle:** Always have a tested rollback path before deploying.

**Rules:**
- Cloud Run revisions retained for instant rollback (see DOC-30-0300)
- Database migrations reversible (or forward-only with data preservation)
- Rollback procedure documented in every deployment plan
- Agents can auto-rollback on error rate >5% (Phase 2E, DEV-CICDL-0035)

**Example:** Before deploying a new gateway version, the deployment agent verifies: "Can we rollback to gateway:v1.2.3 within 60 seconds if this fails?" Test rollback executed in staging first.

---

## 6. Economic & Tokenomics Principles

### 6.1 Member-First Economics

**Principle:** The majority of economic value flows to members and professionals, not the platform.

**Rules:**
- Member earnings (Credits + VTN) > platform fees over member lifetime
- Professional marketplace takes 10–15% commission (vs. 20–30% industry standard)
- Referral bonuses generous (100 Credits + 10 VTN per successful referral)
- Free tier genuinely useful (not crippled to force upgrades)

**Example:** A member refers 10 friends, earns 1,000 Credits + 100 VTN (≈$1,000 value), covering their Premium subscription for 3 years.

### 6.2 Utility-First VTN Narrative

**Principle:** VTN token is primarily a utility and governance token, not a speculative investment.

**Rules:**
- Marketing emphasizes: governance, staking rewards, marketplace discounts
- Do not promise price appreciation or "get rich" messaging
- Tokenomics designed for long-term holding (staking rewards, deflationary mechanics)
- Compliance with securities regulations (legal review required for all token communications)

**Example:** VTN launch announcement focuses on: "Earn 8% APY staking rewards + vote on feature roadmap" not "VTN to the moon! 100x potential!"

### 6.3 Clarity on Credits vs. VTN

**Principle:** Members understand the difference and use case for each currency.

**Rules:**
- **Credits:** Stable (≈$1), transactional, earned through engagement, spent on services
- **VTN:** Variable market value, governance rights, staking rewards, long-term investment
- Clear UI showing both balances separately
- Conversion: Credits → fiat easy, VTN → fiat requires secondary market

**Example:** Member dashboard shows: "Credits: 450 (≈$450) | VTN: 120 tokens (current value: ≈$240)" with clear explanations.

### 6.4 Anti-Gaming and Anti-Fraud

**Principle:** Prevent exploitation of Credit/VTN earning mechanisms without harming legitimate users.

**Rules:**
- Anomaly detection for suspicious earning patterns (OASIS event analysis)
- Rate limits on Credit earning (e.g., max 500 Credits/day from engagement)
- Multi-factor verification for large VTN transactions or withdrawals
- Manual review for referral bonuses above threshold (e.g., >50 referrals/month)
- Banned users forfeit Credits and VTN (appeal process available)

**Example:** A member creates 100 fake accounts to farm referral bonuses. OASIS flags suspicious IP patterns, accounts frozen, CTO investigates.

### 6.5 Health Outcomes > Short-Term Revenue

**Principle:** Optimize for long-term member healthspan, not quarterly revenue.

**Rules:**
- Do not push high-margin services (expensive retreats) to members who don't need them
- Autopilot recommendations based on health benefit, not upselling opportunity
- Decline partnerships with brands/products misaligned with longevity mission
- Measure success by Vitana Index improvement, not revenue per member

**Example:** Autopilot does not recommend a $5,000 Earthlings retreat to a member who would benefit more from local Maxina meetups and consistent sleep tracking.

---

## 7. Documentation & Process Rules

### 7.1 When a New Doc is Required

**Principle:** Significant features, tenants, or architectural changes require documentation before implementation.

**Rules:**
- **New tenant or major feature:** Concept doc (e.g., DOC-20-0201 for AlKalma) required before development starts
- **Architecture change:** ADR (Architecture Decision Record) in DOC-99-xxxx family before implementation
- **New process or workflow:** Runbook or playbook documented before rollout
- **API or integration:** Specification doc required before external partners integrate

**Example:** Before building the Earthlings retreat booking system, a spec doc (`DOC-20-0202_earthlings-overview.md`) is written, reviewed by CEO + CTO + product lead, and marked `status: canonical` before development begins.

### 7.2 Document Lifecycle: Draft → Reviewed → Canonical → Deprecated

**Principle:** Documentation has clear status and ownership for version control.

**Lifecycle:**
1. **Draft:** Initial creation, work-in-progress, not yet authoritative
2. **Reviewed:** Peer-reviewed by relevant stakeholders, ready for broader use
3. **Canonical:** Authoritative source of truth, referenced by other docs and code
4. **Deprecated:** Outdated, superseded by newer doc (link to replacement)

**Rules:**
- Only `canonical` docs can be cited as authoritative in ADRs or specifications
- `draft` docs must transition to `reviewed` or `canonical` within 30 days or be deleted
- `deprecated` docs retained for historical reference but clearly marked

**Example:** `DOC-30-0300` (DevOps strategy) starts as `draft`, reviewed by CTO + DevOps team, promoted to `canonical` after approval. When a new version is needed, the old doc becomes `deprecated` with a link to the new one.

### 7.3 Feature Not "Done" Until Docs Updated

**Principle:** A VTID is not considered complete until relevant documentation is updated.

**Rules:**
- PR checklist includes: "Update relevant docs (specs, runbooks, glossary)"
- Major features require corresponding doc (e.g., new Autopilot mode → update DOC-95-9500)
- Breaking changes require migration guide documented
- VTID state cannot transition to `closed` until doc updates merged

**Example:** `DEV-CICDL-0031` (Phase 2A validation workflow) not closed until `DOC-30-0300` (DevOps strategy) updated with details on the new workflow.

### 7.4 Foundation Docs are Stable References

**Principle:** DOC-00-0001, DOC-00-0002, and DOC-00-0003 are the stable foundation that other docs build upon.

**Rules:**
- Changes to foundation docs require CEO or CTO approval
- Major updates trigger review of all dependent docs (ADRs, specs)
- Versioning: Significant changes increment version (e.g., `v0.1.0` → `v1.0.0`)
- Foundation docs reviewed quarterly even if no changes (ensure continued relevance)

**Example:** If DOC-00-0001 (Vitana vision) shifts strategic direction (e.g., adding a 4th tenant), all other docs referencing the three-tenant model must be updated within 30 days.

---

## 8. Enforcement & Decision Workflow

### 8.1 Using Principles in Product Decisions

**Process:**
1. Propose feature or change in product meeting or doc
2. Evaluate against relevant principles in DOC-00-0003
3. If conflict: discuss trade-offs, consider alternatives
4. If proceeding despite principle conflict: document rationale in ADR (Architecture Decision Record)
5. ADR reviewed by CEO (business) or CTO (technical) for approval

**Example:** Product team proposes adding infinite scroll to Maxina feed (increases engagement). CTO flags conflict with "Health-First, Not Engagement-First" principle. Team redesigns as paginated feed with "take a break" reminders instead.

### 8.2 Using Principles in Technical ADRs

**Process:**
1. Create ADR doc in `DOC-99-xxxx` family (e.g., `DOC-99-9905_adr-autopilot-llm-choice.md`)
2. List relevant principles from DOC-00-0003 in "Context" section
3. Evaluate options against principles
4. Document decision, rationale, and principle compliance (or override justification)
5. CTO approves and marks ADR as `canonical`

**Example:** ADR for choosing LLM for Autopilot cites principles: "Default-Safe UX", "Logging and Explainability", "Member Data Ownership". Decision: Use Claude 3.5 Sonnet for explainability + data privacy controls, over cheaper but less transparent models.

### 8.3 Using Principles in Incident Reviews

**Process:**
1. After incident resolved, conduct post-mortem within 72 hours
2. Document in runbook or incident report (DOC-60-xxxx family)
3. Identify which principle(s) were violated (if any)
4. Define corrective actions (code changes, process improvements, doc updates)
5. Update principle docs if incident reveals gap or ambiguity

**Example:** Production incident where agent auto-deployed breaking change to prod. Post-mortem reveals violation of "No Production Change Without: VTID + Doc + Checks" principle (checks bypassed). Corrective action: Add enforcement in CI/CD pipeline, cannot merge PR without VTID + passing checks.

### 8.4 When Principles Can Be Overridden

**Principle:** Core principles can be overridden only through documented ADR process with executive approval.

**Override criteria:**
1. **Existential need:** Business survival, critical security patch, legal mandate
2. **Temporary exception:** Time-boxed (e.g., "For next 30 days while we migrate infrastructure")
3. **Documented rationale:** Why principle conflicts, why alternatives won't work
4. **Mitigation plan:** How we minimize harm from principle violation
5. **Executive approval:** CEO (business principles) or CTO (technical principles)

**Example:** GDPR requires data deletion within 30 days, but OASIS retention policy is 90 days. ADR documents exception: GDPR-covered data deleted at 30 days, other OASIS events retained at 90 days for compliance. CTO approves.

### 8.5 Principle Ownership and Updates

**Ownership:**
- **CEO:** Product & UX principles, Economic principles, overall vision alignment
- **CTO:** DevOps/OASIS principles, Autopilot/Agent safety principles (technical aspects), Documentation rules
- **Medical Advisor (future hire):** Health-specific aspects of Autopilot safety principles
- **Legal Counsel:** Data privacy and compliance principles (advisory role)

**Update process:**
1. Propose change to DOC-00-0003 via PR with justification
2. Notify relevant stakeholders (CEO/CTO/medical advisor) for review
3. If approved: Merge, increment version number, update `updated_at` date
4. Announce change to team via DevOps chat + all-hands meeting
5. Update dependent docs within 30 days

**Example:** Medical advisor proposes adding principle: "Autopilot must recommend in-person doctor visit for any symptom lasting >7 days." PR created, reviewed by CEO + CTO, approved, merged as v0.2.0 of DOC-00-0003.

---

## Conclusion

These core principles and process rules form the **constitutional foundation** of Vitana. They ensure that as we scale—across tenants, geographies, and features—we remain true to our mission: **improving human healthspan through contextual intelligence, community, and autonomous wellness guidance.**

**Key takeaway:** When in doubt, ask:
1. Does this decision prioritize member health and well-being? (Principle: Health-First)
2. Is it logged in OASIS for transparency? (Principle: If It's Not in OASIS, It Didn't Happen)
3. Does it respect member data ownership and consent? (Principle: Member Data Ownership)
4. Would I want this if I were a Vitana member myself?

If the answer to all four is "yes," proceed confidently. If "no" to any, revisit the decision or document the override in an ADR.

**These principles are living:** We will refine them as we learn, but changes require deliberate process (Section 8.5). Stability in principles enables innovation in execution.

---

**Document Owner:** CEO  
**Contributors:** CTO, Product Lead, Legal Counsel (advisory)  
**Last Updated:** 2025-11-03  
**Next Review:** 2025-12-03 (monthly for first 6 months, then quarterly)  
**Feedback:** Submit proposed principle updates via PR to this doc, flag @ceo and @cto for review
