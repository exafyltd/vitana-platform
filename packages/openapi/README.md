# OpenAPI Specifications

This directory contains all OpenAPI 3.0+ specifications for Vitana Platform APIs.

## Current Specs

- `gateway-v1.yml` - Gateway API endpoints
- `oasis-v1.yml` - OASIS events API

## Usage

```bash
# Validate specs
spectral lint *.yml

# View in Swagger UI
swagger-ui gateway-v1.yml
```

See `/specs/README.md` for detailed documentation.
