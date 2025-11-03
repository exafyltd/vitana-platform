---
doc_id: DOC-00-0002
title: "Vitana Glossary"
version: 0.1.0
status: draft
template: concept
owner: "CTO"
tags: [foundation, glossary, definitions]
related_vtids: []
related_docs: [DOC-00-0001, DOC-30-0300]
created_at: "2025-11-03"
updated_at: "2025-11-03"
---

# Vitana Glossary

This document defines core terms and concepts used throughout the Vitana ecosystem, including the health & longevity platform (DOC-00-0001), DevOps infrastructure (DOC-30-0300), and related documentation. Terms are organized by category and listed alphabetically within each section.

---

## Core Ecosystem Concepts

**Member** – An individual user of the Vitana platform who engages with one or more tenants (Maxina, AlKalma, Earthlings) to optimize their health and longevity.

**Partner** – An organization (lab, destination, insurer, brand) that integrates with Vitana to provide products, services, or data to the ecosystem.

**Professional** – A doctor, coach, host, or wellness expert who provides services to members through the Vitana marketplace.

**Tenant** – One of the three specialized platforms within the Vitana ecosystem: Maxina (lifestyle), AlKalma (clinical), or Earthlings (destinations). Each tenant shares core infrastructure while serving distinct use cases.

**Vitana** – A global health and longevity ecosystem that combines contextual intelligence, community, and autonomous wellness guidance to help people live longer, healthier lives.

**Vitana Ecosystem** – The complete platform including three tenants (Maxina, AlKalma, Earthlings), shared infrastructure (OASIS, Credits, Autopilot), and the network of members, professionals, and partners.

---

## Tenants & Apps

**AlKalma** – The clinical and mental wellness tenant providing structured care programs, telemedicine consultations, and professional health guidance.

**Command Hub** – The operational interface for Vitana DEV, providing visibility into system health, deployments, VTID tracking, and autonomous agent activity. Used by the DevOps team to monitor and manage platform infrastructure.

**Earthlings** – The eco-wellness and longevity destination tenant offering immersive nature-based experiences, retreats, and sustainable travel programs.

**Maxina** – The lifestyle and community tenant focused on social engagement, meetups, events, and experiences like the Maxina Boat.

**Maxina Boat** – A curated maritime experience offering wellness-focused voyages where members connect, learn, and optimize health together in unique environments.

**Vitana DEV** – The internal DevOps and infrastructure management tenant used by the development team to monitor, deploy, and maintain the Vitana platform. See DOC-30-0300 for technical details.

---

## Health & Longevity Concepts

**Biomarker** – A measurable biological indicator (blood test, genetic marker, physiological metric) used to assess health status and guide optimization strategies within the Vitana Index.

**Five Pillars** – The core dimensions of health measured by the Vitana Index: Physical (0–200), Mental (0–200), Nutritional (0–200), Social (0–200), and Environmental (0–200).

**Healthspan** – The period of life spent in good health, free from chronic disease and disability. Vitana's primary optimization target, as distinguished from pure lifespan extension.

**Longevity** – The extension of both lifespan (total years lived) and healthspan (years lived in optimal health). Vitana focuses primarily on healthspan optimization.

**Retreat** – An immersive wellness experience offered through Earthlings, typically multi-day programs at eco-wellness destinations featuring nature-based longevity interventions.

**Session** – A time-bound interaction between a member and a professional (e.g., telemedicine consultation in AlKalma, coaching call in Maxina), typically purchased using Credits.

**Social Longevity Graph** – The network of connections between members, professionals, and groups based on health interests, goals, Vitana Index profiles, and compatibility. Powers intelligent matchmaking and community recommendations.

**Vitana Index** – A comprehensive health score (0–999) measuring overall longevity potential across five pillars plus biomarkers. Updated continuously from wearables, labs, self-reports, and environmental data.

---

## Economic & Tokenomics Concepts

**Credits** – The platform currency used to purchase services, products, and experiences within Vitana (1 Credit ≈ $1 USD). Earned through engagement, referrals, and contributions; spent in the marketplace.

**Marketplace** – The economic layer of Vitana where members purchase services from professionals, book retreats, and access products using Credits. Professionals earn Credits (convertible to fiat) for services rendered.

**Staking** – The act of locking VTN tokens for a period to earn rewards and/or gain enhanced governance rights in platform decisions.

**VTN Token** – The governance and investment token of the Vitana ecosystem. Used for platform governance voting, staking rewards, marketplace discounts, and represents economic participation in ecosystem growth.

---

## Autopilot, AI & Agents

**Agent** – An autonomous software service that executes tasks within defined boundaries, reports actions through OASIS, and escalates to humans when limits are exceeded. Examples include GitHub Agent, Deployment Agent, and Monitoring Agent.

**Autonomous Mode** – The most proactive Autopilot mode where the AI continuously monitors health data and initiates interventions (reminders, recommendations, alerts) without requiring user input.

**Autopilot** – The AI-powered system providing proactive health guidance through three modes: Start Stream (quick capture), Voice Conversation (dialogue), and Autonomous Mode (continuous monitoring).

**Bounded Autonomy** – The principle that agents operate independently within predefined safety limits, requiring human approval for high-risk actions and escalating when boundaries are exceeded.

**Crew** – A coordinated group of agents working together to accomplish complex tasks (e.g., deployment crew = GitHub Agent + Deployment Agent + Monitoring Agent). Used in Vitana DEV infrastructure.

**Start Stream** – The Autopilot mode for quick voice or text capture of health updates, meals, symptoms, moods, and activities. Lowest friction input method.

**Voice Conversation** – The Autopilot mode enabling natural dialogue with the AI health assistant for deeper discussions, questions, and guidance.

---

## Platform & Infrastructure

**CI/CD** – Continuous Integration / Continuous Deployment. Automated workflows (using GitHub Actions) that test, build, and deploy code changes across dev, staging, and production environments.

**Cloud Run** – Google Cloud Platform's serverless container platform used to deploy and auto-scale Vitana services (Gateway, OASIS, Agents).

**Event-First Architecture** – The design principle where every significant action is recorded as an event in OASIS before or during execution, enabling complete auditability and context-aware automation.

**Gateway** – The central API entry point for all Vitana platform requests. Handles routing, authentication, rate limiting, and telemetry emission to OASIS.

**GitHub Actions** – The CI/CD platform used for automated testing, building, and deployment workflows. Triggered by code commits, pull requests, and manual dispatches.

**OASIS** – Operational Audit & State Integration System. The centralized memory and event ledger storing all ecosystem activities across tenants, providing single source of truth for audit trails, context, and state.

**Supabase** – The PostgreSQL database platform hosting the OASIS database. Provides built-in APIs, real-time subscriptions, and authentication.

**VTID** – Vitana Task Identifier. A unique identifier (format: DOMAIN-CATEGORY-NUMBER) assigned to every unit of work, enabling end-to-end traceability across GitHub, CI/CD, deployments, and OASIS events.

---

## Abbreviations & Short Forms

**ADR** – Architecture Decision Record. Documents capturing key technical decisions, rationale, and trade-offs.

**API** – Application Programming Interface. Standard interface for software services to communicate with each other.

**CEO** – Chief Executive Officer. Owner of business strategy and ecosystem vision (DOC-00-0001).

**CTO** – Chief Technology Officer. Owner of technical strategy and infrastructure (DOC-30-0300).

**GCP** – Google Cloud Platform. The primary cloud infrastructure provider for Vitana services.

**GDPR** – General Data Protection Regulation. European privacy law governing personal data handling and user consent.

**HIPAA** – Health Insurance Portability and Accountability Act. US regulation governing health data privacy and security.

**IaC** – Infrastructure as Code. Managing infrastructure through declarative configuration files (e.g., Terraform) rather than manual processes.

**MVP** – Minimum Viable Product. The simplest version of a feature or product that delivers core value for testing and validation.

**NPS** – Net Promoter Score. Metric measuring user satisfaction and likelihood to recommend Vitana to others.

**ORM** – Object-Relational Mapping. Software layer (Prisma) that translates between database tables and application code objects.

**PR** – Pull Request. GitHub mechanism for proposing, reviewing, and merging code changes.

**SRE** – Site Reliability Engineering. Discipline combining software engineering and operations to build reliable, scalable systems.

**UX** – User Experience. The overall experience and satisfaction of users interacting with Vitana products.

---

**Document Owner:** CTO  
**Last Updated:** 2025-11-03  
**Next Review:** 2025-12-03 (monthly, or as new terms emerge)  
**Feedback:** Submit glossary additions/corrections via GitHub issues or DevOps chat
