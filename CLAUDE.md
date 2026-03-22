# Vitana Platform — Claude Code Instructions

## Repositories & Auth

Two repositories, tokens stored in `.claude/settings.json`:

| Repository | Token Env Var | Purpose |
|---|---|---|
| `exafyltd/vitana-platform` | `GITHUB_TOKEN` | Platform monorepo (gateway, OASIS, agents) |
| Lovable / Vitana Vers1 | `LOVABLE_GITHUB_PAT` | Frontend / Lovable repo |

## Deployment

### Gateway Deploy (preferred: GitHub Actions)
```bash
# Authenticate gh CLI first
echo "$GITHUB_TOKEN" | gh auth login --with-token

# Trigger canonical deploy workflow
gh workflow run EXEC-DEPLOY.yml \
  --repo exafyltd/vitana-platform \
  -f vtid=<VTID> \
  -f service=gateway \
  -f environment=dev-sandbox \
  -f health_path=/alive \
  -f initiator=claude
```

### Alternative: Direct deploy script
```bash
./scripts/deploy/deploy-service.sh gateway
```

### Post-deploy verification
```bash
curl https://gateway-<hash>.us-central1.run.app/alive
curl https://gateway-<hash>.us-central1.run.app/api/v1/orb/health
curl https://gateway-<hash>.us-central1.run.app/api/v1/governance/categories
```

## Build & Test (Gateway)
```bash
cd services/gateway
npm install
npm run build        # tsc + copy frontend
npm run test         # jest (38 suites)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

## Key Facts
- Cloud Run project: `lovable-vitana-vers1`, region: `us-central1`
- Auto-deploy triggers on push to `main` when `services/gateway/**` changes
- Deploy workflow: AUTO-DEPLOY.yml → EXEC-DEPLOY.yml (governed)
- Health endpoint: `/alive`
- ORB WebSocket: `/api/v1/orb/live/ws`
- Always install gh CLI if missing: `apt-get install gh` or use API directly with $GITHUB_TOKEN
