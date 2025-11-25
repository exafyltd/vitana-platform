# Oasis Projector Service

VTID Event Projector Service for DEV-OASIS-0010 implementation.

## Overview

This service implements an event projector pattern that processes events from the `events` table and projects them to downstream systems. It follows the **SYS-RULE-DEPLOY-L1** deployment protocol.

## Features

- **Event Processing**: Processes unprojected events in batches
- **Offset Tracking**: Maintains projection progress in `projection_offsets` table
- **Health Monitoring**: Provides `/alive`, `/ready`, and `/metrics` endpoints
- **Graceful Shutdown**: Handles SIGTERM and SIGINT properly
- **Structured Logging**: Uses Winston for consistent logging

## API Endpoints

- `GET /alive` - Health check
- `GET /ready` - Readiness check (includes DB connectivity)
- `GET /metrics` - Service metrics and projection status

## Deployment

```bash
./scripts/deploy/deploy-service.sh oasis-projector services/oasis-projector
```
