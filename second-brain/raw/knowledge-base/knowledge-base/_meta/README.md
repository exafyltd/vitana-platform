# Vitana Knowledge Base - Authoring Guide

## Purpose

This Knowledge Base powers the ORB AI assistant's ability to answer any user question
about the Vitana platform. Articles are optimized for LLM retrieval, not direct user reading.

## Architecture

- **Part A (Sections 01-07)**: Maxina Longevity Core — philosophy, science, programs, measurement
- **Part B (Sections 08-20)**: Feature Guides — practical how-tos framed through the longevity lens
- **Part C (Sections 21-22)**: Experience Guides — tenant-specific content (Alkalma, Earthlings)

## Article Format

Every article uses YAML frontmatter + Markdown body:

```markdown
---
id: kb-en-XX-YY           # Unique ID: kb-{lang}-{section}-{article}
title: "Article Title"     # Human-readable title
category: "section-slug"   # Matches directory name
tags: ["tag1", "tag2"]     # Semantic tags for retrieval
lang: "en"                 # Language code: en, de
tenant: "all"              # "all", "maxina", "alkalma", "earthlings"
status: "live"             # "live" or "coming-soon"
last_updated: "2026-02-25" # ISO date
related: ["kb-en-XX-YY"]   # Related article IDs
---

# Article Title

Article body in ORB first-person voice...
```

## Voice & Tone

- **Always ORB first-person**: "I can help you...", "I track your...", "Together we can..."
- **Warm and supportive**: Like a trusted wellness companion
- **Longevity-framed**: Every feature connects to the longevity mission
- **Action-oriented**: Focus on what users CAN DO
- **Accessible science**: Reference Blue Zones, preventive medicine — but in plain language
- **No jargon**: Never mention VTIDs, APIs, databases, RLS, or internal system names

## Conventions

- File names: `XX-kebab-case-title.md`
- Section directories: `XX-kebab-case-section/`
- IDs: `kb-{lang}-{section}-{article}` (e.g., `kb-en-01-01`)
- Cross-references: Use KB IDs in Related Topics sections
- Coming Soon: Set `status: "coming-soon"` + add inline note in body
- Tenant-specific: Set `tenant: "maxina"` (or other tenant) in frontmatter

## Multi-Language Strategy

**English is the single source of truth.** No per-language file translations are maintained.

The ORB supports any language through multilingual embeddings + native LLM response:

1. **KB stored in English only** — single source, zero sync burden
2. **Multilingual embeddings** (`text-embedding-004`) handle cross-lingual search —
   a German query finds the right English article natively
3. **LLM responds in user's language** — Gemini/Claude generate fluent responses
   in any language from English context, with zero added latency

This approach scales to unlimited languages with no per-language maintenance.

### i18n Sync Tool (Optional)

If curated translations are ever needed for specific use cases (SEO, static pages),
the `scripts/kb-i18n-sync.mjs` tool provides hash-based change detection:

```bash
node scripts/kb-i18n-sync.mjs check          # Full sync report
node scripts/kb-i18n-sync.mjs outdated        # CI-friendly: exit 1 if any outdated
node scripts/kb-i18n-sync.mjs update-hashes   # Stamp English hashes into translations
```

## Sync to Database

Articles are synced to the `knowledge_hub` table via `scripts/sync-kb-to-knowledge-hub.mjs`.
See taxonomy.md for the complete category and ID scheme.
