# e2e/ — End-to-End Tests (Playwright)

## Overview

Playwright E2E tests for both the Community App (vitana-v1) and Command Hub. Tests run against live or staging URLs.

## Commands

```bash
cd e2e
npx playwright test                              # Run all tests
npx playwright test --project=desktop-community   # Desktop community tests
npx playwright test --project=mobile-community    # Mobile community tests
npx playwright test --project=command-hub          # Command Hub tests
npx playwright test --headed                       # Run with browser visible
npx playwright show-report                         # View last test report
```

## Structure

```
e2e/
├── playwright.config.ts       # 16 test projects configuration
├── global-setup.ts            # Test user provisioning (e2e-test@vitana.dev)
├── package.json               # Playwright + Supabase deps
├── auth/                      # Authentication flow tests
├── command-hub/               # Command Hub UI tests
├── community-desktop/         # Desktop community app tests
├── community-mobile/          # Mobile community app tests
└── fixtures/                  # Test data and user fixtures
    └── test-users.ts          # Test user credentials and config
```

## 16 Test Projects

The config defines projects for each role on each device:
- `desktop-community`, `mobile-community`
- `desktop-professional`, `mobile-professional`
- `desktop-staff`, `mobile-staff`
- `desktop-admin`, `mobile-admin`
- `desktop-dev`, `mobile-dev`
- `shared` (cross-role)
- `command-hub`

## Authentication

Tests authenticate via Supabase REST API (not browser form):
- `POST /auth/v1/token?grant_type=password`
- Test user: `e2e-test@vitana.dev`
- Auto-provisioned by `global-setup.ts` with `exafy_admin: true`
- Uses Lovable Supabase service role key

## CI/CD

- Workflow: `.github/workflows/E2E-TEST-RUN.yml`
- Triggers: manual dispatch or `repository_dispatch` from vitana-v1 deploy
- Can target Cloud Run URL via `COMMUNITY_URL` env var

## Patterns

- Tests follow Page Object Model pattern where applicable
- Auth state is stored and reused across tests in a project
- Mobile tests use viewport emulation (not real devices)
- Test against staging URLs by default, override with env vars
