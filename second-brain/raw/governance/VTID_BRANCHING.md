# VTID Branching Guidelines

> **VTID-0302: Command Hub Golden Shield & Regression Guard**

## Fresh Branch Rule

**For every new VTID, you MUST create a fresh branch from `origin/main`. Reusing old branches is forbidden.**

### Why This Matters

Reusing stale branches can cause:
- **Silent regressions**: Old code overwrites newer fixes
- **Bundle corruption**: Frontend builds from outdated sources
- **Merge conflicts**: Accumulated drift from main
- **Governance violations**: Accidental modifications to protected zones

### Correct Procedure

```bash
# 1. Always start from latest main
git fetch origin
git checkout main
git pull origin main

# 2. Create a fresh branch for your VTID
git checkout -b feature/VTID-XXXX-description

# 3. Never reuse old branches - delete and recreate if needed
```

### Branch Naming Conventions

| VTID Type | Branch Pattern | Example |
|-----------|----------------|---------|
| Command Hub Frontend | `feature/DEV-COMHU-XXXX-*` | `feature/DEV-COMHU-0203-ticker-fix` |
| Backend/API | `feature/VTID-XXXX-*` | `feature/VTID-0600-visibility` |
| Claude Agent | `claude/VTID-XXXX-*` | `claude/VTID-0302-golden-shield` |

---

## Command Hub Frontend Protection Zone

**Path**: `services/gateway/src/frontend/command-hub/**/*`

### Access Rules

| VTID Type | Can Modify Command Hub? |
|-----------|------------------------|
| `DEV-COMHU-*` | Yes |
| `VTID-0302` (one-time) | Yes |
| All other VTIDs | **NO** |

### Enforcement

Two CI guardrails enforce this protection:

1. **Path Ownership Guard**: Fails builds when non-DEV-COMHU VTIDs modify Command Hub files
2. **Golden Fingerprint Check**: Ensures bundle contains required markers (task-board, ORB, etc.)

### If Your Build Fails

If you see "Command Hub frontend files modified without authorization":

1. Check if your VTID really needs to modify Command Hub
2. If yes: rename your branch to include `DEV-COMHU-XXXX`
3. If no: revert your changes to the Command Hub frontend

---

## Golden Bundle Markers

The Command Hub bundle must always contain these markers:

| Marker | Purpose |
|--------|---------|
| `VTID-0529-B` | Golden version identifier |
| `.task-board` | Three-column task board |
| `.task-column` | Column layout |
| `.task-card` | Task card styling |
| `.orb-idle` | ORB button mount point |
| `.header-toolbar` | Header toolbar container |

If any marker is missing after build, the fingerprint check will fail.

---

## For Agent Developers

When implementing backend VTIDs:

1. **Always start fresh**: `git checkout main && git pull && git checkout -b new-branch`
2. **Never touch Command Hub**: Leave `services/gateway/src/frontend/command-hub/` unchanged
3. **Verify before commit**: Run `git diff --name-only origin/main` to check what you're changing
4. **If accidentally modified**: Restore with `git checkout origin/main -- services/gateway/src/frontend/command-hub/`
