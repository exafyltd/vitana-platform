# Agent Contract Templates

**VTID:** DEV-OASIS-0206
**Status:** Active
**Last Updated:** 2025-11-25

## Overview

This directory contains behavioral contract templates for all AI agents operating within the Vitana platform. Every agent MUST follow these templates to ensure proper VTID tracking, OASIS event logging, and governance compliance.

## Core Principle

**All agents must obtain VTIDs from the ledger, never invent them.**

## Required Endpoint

All agents must use the following endpoint at task start:

```
POST /api/v1/vtid/get-or-create
```

### Request Body

```json
{
  "vtid": "DEV-OASIS-0001",  // Optional: existing VTID to reuse
  "task_family": "DEV",      // Optional: DEV, ADM, GOVRN, OASIS
  "task_module": "OASIS",    // Optional: module code (max 10 chars)
  "title": "Task description", // Optional: human-readable title
  "tenant": "vitana",        // Optional: tenant identifier
  "agent": "gemini-worker",  // Optional: calling agent name
  "metadata": {}             // Optional: additional context
}
```

### Response (Success)

```json
{
  "ok": true,
  "vtid": "DEV-OASIS-0042",
  "source": "created",  // or "existing" if vtid was provided
  "layer": "DEV",
  "module": "OASIS"
}
```

### Response (Error)

```json
{
  "ok": false,
  "error": "INVALID_VTID_FORMAT",
  "details": "VTID 'invalid' does not match expected format"
}
```

## Agent Templates

- [gemini-worker.md](./gemini-worker.md) - Gemini Worker Agent
- [gemini-planner.md](./gemini-planner.md) - Gemini Planner Agent
- [kimmi-ui-dev.md](./kimmi-ui-dev.md) - Kimmi UI/Dev Agent
- [claude-validator-planner.md](./claude-validator-planner.md) - Claude Validator/Planner Agent

## Governance Rules

These templates enforce the following governance rules:

| Rule Code | Name | Enforcement |
|-----------|------|-------------|
| VTID-001 | VTID Automatic Creation Required | Mandatory |
| VTID-002 | VTID Ledger Single Source of Truth | Mandatory |
| VTID-003 | VTID Context Reuse Required | Mandatory |

## Compliance

Agents that violate these contracts will:
1. Have their outputs flagged by the Validator
2. Generate governance violations logged to OASIS
3. Potentially be blocked from completing tasks
