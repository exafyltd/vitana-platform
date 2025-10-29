# Vitana Platform API Specifications

This directory contains OpenAPI 3.0 specifications for Vitana Platform APIs.

## Available Specifications

### 1. Gateway API (`gateway-v1.yml`)
**Endpoints:**
- VTID management
- DevHub SSE feed (real-time event streaming)
- OASIS events query
- GitHub webhooks
- Health checks

**Base URL (Production):** `https://vitana-gateway-86804897789.us-central1.run.app`

### 2. OASIS API (`oasis-v1.yml`)
**Endpoints:**
- Events query (with filtering)
- Events ingestion (internal)

**Base URL (Production):** `https://vitana-gateway-86804897789.us-central1.run.app/api/v1/oasis`

---

## Viewing Specifications

### Option 1: Swagger UI (Recommended)
```bash
# Install Swagger UI globally
npm install -g swagger-ui-cli

# View Gateway API
swagger-ui specs/gateway-v1.yml

# View OASIS API
swagger-ui specs/oasis-v1.yml
```

### Option 2: Swagger Editor (Online)
1. Go to: https://editor.swagger.io/
2. File → Import File → Select `gateway-v1.yml` or `oasis-v1.yml`

### Option 3: VS Code Extension
Install "OpenAPI (Swagger) Editor" extension and open the files.

---

## Validating Specifications

### Using Spectral (Recommended)
```bash
# Install Spectral
npm install -g @stoplight/spectral-cli

# Validate Gateway API
spectral lint specs/gateway-v1.yml

# Validate OASIS API
spectral lint specs/oasis-v1.yml
```

### Using Swagger CLI
```bash
# Install Swagger CLI
npm install -g @apidevtools/swagger-cli

# Validate specs
swagger-cli validate specs/gateway-v1.yml
swagger-cli validate specs/oasis-v1.yml
```

---

## Testing API Endpoints

### Using curl

**Gateway Health:**
```bash
curl https://vitana-gateway-86804897789.us-central1.run.app/health
```

**OASIS Events Query:**
```bash
# Get all events (last 50)
curl "https://vitana-gateway-86804897789.us-central1.run.app/api/v1/oasis/events?limit=50"

# Filter by VTID
curl "https://vitana-gateway-86804897789.us-central1.run.app/api/v1/oasis/events?vtid=DEV-CICDL-0031&limit=200"

# Filter by source
curl "https://vitana-gateway-86804897789.us-central1.run.app/api/v1/oasis/events?source=github.actions&limit=100"
```

**DevHub SSE Feed:**
```bash
# Stream events in real-time
curl -N "https://vitana-gateway-86804897789.us-central1.run.app/api/v1/devhub/feed"
```

### Using Postman
1. Import OpenAPI spec: Collections → Import → Upload `gateway-v1.yml`
2. Update base URL to production
3. Test endpoints

---

## CI/CD Integration

Add API validation to your CI pipeline:

```yaml
# .github/workflows/API-SPEC-VALIDATION.yml
name: API-SPEC-VALIDATION
on: [pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install Spectral
        run: npm install -g @stoplight/spectral-cli
      - name: Validate Gateway API
        run: spectral lint specs/gateway-v1.yml
      - name: Validate OASIS API
        run: spectral lint specs/oasis-v1.yml
```

---

## Updating Specifications

When making changes to APIs:

1. **Update the spec file** (`gateway-v1.yml` or `oasis-v1.yml`)
2. **Validate** using Spectral or Swagger CLI
3. **Test** endpoints match the spec
4. **Commit** with descriptive message:
   ```bash
   git add specs/
   git commit -m "docs(api): Update Gateway API spec for new /events endpoint"
   ```
5. **PR Review**: Ensure API changes are documented

---

## Generating Client SDKs

Use OpenAPI Generator to create client libraries:

```bash
# Install OpenAPI Generator
npm install -g @openapitools/openapi-generator-cli

# Generate TypeScript/JavaScript client
openapi-generator-cli generate \
  -i specs/gateway-v1.yml \
  -g typescript-axios \
  -o packages/gateway-client

# Generate Python client
openapi-generator-cli generate \
  -i specs/oasis-v1.yml \
  -g python \
  -o packages/py/oasis-client
```

---

## Phase 2B Compliance

These API specifications are part of **Phase 2B: Naming Governance & Repo Standardization** (VTID: DEV-CICDL-0031).

**Key Standards:**
- All endpoint paths use kebab-case
- Event fields follow naming conventions (UPPERCASE for constants, snake_case for types)
- Documentation includes examples and descriptions
- Specs are validated in CI pipeline

---

## Support

For questions or issues with API specifications:
- GitHub Issues: https://github.com/exafyltd/vitana-platform/issues
- Tag: `api-spec`, `documentation`

---

**Last Updated:** 2025-10-29  
**Phase 2B Status:** ✅ Complete
