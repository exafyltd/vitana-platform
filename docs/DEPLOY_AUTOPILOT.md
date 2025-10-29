# Deploy Autopilot - Autonomous PR + Deploy Guide

## Overview
Fully autonomous PR creation and deployment with OASIS approval loop.

**VTID:** DEV-AICOR-0008

## Required Secrets
- `GITHUB_PAT` - GitHub Personal Access Token (repo + workflow)
- `GCP_WIF_PROVIDER` - GCP Workload Identity Provider
- `GCP_WIF_SA_EMAIL` - GCP Service Account Email
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE` - Supabase service role key

## Workflow

### 1. Create PR (Automated)
Trigger: Manual or via API
```bash
