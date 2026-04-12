# prisma/ — Database Schema & Migrations

## Overview

Prisma ORM configuration for PostgreSQL. Manages 3 core models that power the OASIS event system and VTID governance.

## Commands

```bash
npx prisma migrate dev              # Create + apply migration in dev
npx prisma migrate deploy           # Apply pending migrations (production)
npx prisma generate                 # Regenerate Prisma Client
npx prisma studio                   # Visual DB browser (localhost:5555)
npx prisma db push                  # Push schema without migration file
npx prisma migrate reset            # Reset DB (destructive — dev only)
```

## Schema (`schema.prisma`)

### OasisEvent → `oasis_events`
System-wide event log. Every significant platform action creates an event.

Key fields:
- `id` (auto-increment), `rid` (reference ID)
- `service`, `event`, `tenant`, `status`
- `vtid`, `topic`, `message`, `role`, `model`
- `actorId`, `actorEmail`, `actorRole`, `surface`, `conversationTurnId` (actor tracking)
- `metadata` (JSON), `gitSha`, `projected` (Boolean)

Indexes: projected+createdAt, service+createdAt, tenant+createdAt, status+createdAt, vtid

### VtidLedger → `vtid_ledger`
Central task/VTID tracking. Every tracked task has a ledger entry.

Key fields:
- `id` (auto-increment), `vtid` (unique)
- `taskFamily`, `taskType`, `description`, `status`
- `assignedTo`, `tenant`, `parentVtid`
- `layer`, `module`, `title`, `summary`
- `lastEventId`, `lastEventAt`, `service`, `environment`
- `metadata` (JSON)

Indexes: createdAt, taskFamily+createdAt, status+createdAt, tenant+createdAt, vtid, lastEventAt, service

### ProjectionOffset → `projection_offsets`
Tracks which events each projector has processed (event sourcing cursor).

Key fields:
- `projectorName` (unique)
- `lastEventId`, `lastEventTime`, `lastProcessedAt`
- `eventsProcessed` (count)

## Local Database

Docker Compose provides PostgreSQL 16:
```bash
docker compose up -d   # Start postgres on localhost:5432
```

Connection string: `postgresql://postgres:postgres@localhost:5432/vitana`

## Migration Workflow

1. Edit `schema.prisma`
2. Run `npx prisma migrate dev --name describe_change`
3. Prisma generates SQL migration in `migrations/`
4. Commit both schema and migration file
5. Production: `npx prisma migrate deploy` (run by CI)

## Relationship to `database/migrations/`

- `prisma/migrations/` — Prisma-managed, auto-generated SQL
- `database/migrations/` — Hand-written SQL for tables not in Prisma schema (context dimensions, RLS policies, etc.)

Both are needed. Prisma manages the core 3 tables; raw SQL manages extended tables.
