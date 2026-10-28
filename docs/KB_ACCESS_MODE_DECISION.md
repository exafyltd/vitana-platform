# KB Access Mode Decision Document

**VTID:** DEV-AICOR-0025  
**Date:** 2025-11-05  
**Status:** Decided

---

## Decision: Local Filesystem Access (Option A)

### Rationale

1. **Documentation Already Available:** Project docs are already at `/mnt/project` in the crew execution environment
2. **Simpler Implementation:** No need to deploy separate KB service
3. **Lower Latency:** Direct filesystem access < 50ms vs HTTP 100-200ms
4. **No Additional Infrastructure:** No new Cloud Run service to maintain
5. **Easier Testing:** Can test with local filesystem in dev
6. **Aligns with Current Setup:** The crew_template assumes local KB access

### Implementation Approach

**Environment Variable:** `KB_BASE_PATH=/mnt/project`

**Access Pattern:**
```python
import os
from pathlib import Path

class KBAccess:
    def __init__(self):
        self.base_path = Path(os.getenv('KB_BASE_PATH', '/mnt/project'))
        self._validate_base_path()
    
    def _validate_base_path(self):
        if not self.base_path.exists():
            raise ValueError(f"KB_BASE_PATH does not exist: {self.base_path}")
        if not self.base_path.is_dir():
            raise ValueError(f"KB_BASE_PATH is not a directory: {self.base_path}")
    
    def read_document(self, doc_name: str) -> str:
        # Prevent directory traversal
        safe_path = self.base_path / doc_name
        if not safe_path.resolve().is_relative_to(self.base_path):
            raise ValueError(f"Invalid document path: {doc_name}")
        
        if not safe_path.exists():
            raise FileNotFoundError(f"Document not found: {doc_name}")
        
        return safe_path.read_text()
```

### Security Measures

1. **Path Sanitization:** Prevent directory traversal attacks
2. **Path Validation:** Ensure paths stay within KB_BASE_PATH
3. **File Extension Filtering:** Only allow .md files
4. **Size Limits:** Max 1MB per document (configurable)
5. **Read-Only:** No write operations allowed

### Future Migration Path (Option B)

If we later want remote service access:

```python
class KBAccess:
    def __init__(self):
        self.base_url = os.getenv('KB_AGENT_BASE_URL')
        if self.base_url:
            self._mode = 'remote'
            self._client = KBRemoteClient(self.base_url)
        else:
            self._mode = 'local'
            self.base_path = Path(os.getenv('KB_BASE_PATH', '/mnt/project'))
```

This allows seamless migration without breaking existing code.

---

## OASIS Telemetry Events

All KB access will emit granular events to `/events/ingest`:

### Event Schema

```typescript
{
  service: "crewai-kb-executor",
  event: "kb.skill_invoked" | "kb.index_accessed" | "kb.doc_accessed" | "kb.bundle_created",
  tenant: "vitana-dev" | "vitana-prod",
  status: "start" | "success" | "fail",
  notes: string,
  git_sha: string,
  rid: string,  // request_id for correlation
  metadata: {
    vtid: string,
    agent_role: "planner" | "worker",
    skill_name: "vitana.kb.get_index" | "vitana.kb.get_doc" | "vitana.kb.get_bundle",
    doc_name?: string,
    doc_names?: string[],
    bundle_name?: string,
    query?: string,
    docs_count?: number,
    execution_time_ms: number,
    cache_hit: boolean,
    error?: string
  }
}
```

### Event Emission Pattern

```python
async def emit_oasis_event(
    event_type: str,
    vtid: str,
    agent_role: str,
    metadata: dict,
    status: str = "success"
):
    payload = {
        "service": "crewai-kb-executor",
        "event": event_type,
        "tenant": os.getenv("TENANT", "vitana-dev"),
        "status": status,
        "notes": f"KB {event_type} for {vtid}",
        "git_sha": os.getenv("GIT_SHA", "unknown"),
        "rid": str(uuid.uuid4()),
        "metadata": {
            "vtid": vtid,
            "agent_role": agent_role,
            **metadata
        }
    }
    
    gateway_url = os.getenv("GATEWAY_URL", "http://localhost:8080")
    async with httpx.AsyncClient() as client:
        await client.post(f"{gateway_url}/events/ingest", json=payload)
```

---

## Implementation Plan

### Phase 1: KB Executor (Python)
**Location:** `services/agents/crewai-gcp/kb_executor.py`

1. Create KBAccess class with local filesystem support
2. Implement get_index(), get_doc(), get_bundle()
3. Add caching layer (in-memory LRU cache, 100 items, 1-hour TTL)
4. Add OASIS event emission for all operations
5. Add error handling and logging

### Phase 2: Skill Integration
**Location:** `services/agents/crewai-gcp/skills/`

1. Create kb_skills.py that wraps KBExecutor
2. Register skills in crew execution flow
3. Map skill calls to KBExecutor methods
4. Pass agent_role from skill invocation context

### Phase 3: Testing
**Location:** `services/agents/crewai-gcp/tests/`

1. Unit tests for KBAccess
2. Integration tests for skill execution
3. OASIS event emission verification
4. Cache behavior tests
5. Security tests (path traversal prevention)

### Phase 4: Demo
**VTID:** TEST-KB-0001

Task: "Summarize the Vitana Vision and Ecosystem Strategy"

Expected flow:
1. Task arrives with VTID
2. Planner calls get_index(query="vision ecosystem")
3. Planner identifies relevant docs
4. Planner calls get_doc("01-PROJECT-OVERVIEW.md")
5. Worker calls get_bundle("architecture_docs")
6. OASIS receives 5+ events tracking the flow
7. Response generated with doc citations

---

## Environment Configuration

### Development
```bash
KB_BASE_PATH=/mnt/project
KB_CACHE_TTL=3600
KB_MAX_DOC_SIZE=1048576
GATEWAY_URL=http://localhost:8080
TENANT=vitana-dev
```

### Production
```bash
KB_BASE_PATH=/mnt/project
KB_CACHE_TTL=7200
KB_MAX_DOC_SIZE=1048576
GATEWAY_URL=https://gateway.vitana.app
TENANT=vitana-prod
```

---

## Success Metrics

### Performance
- ✅ get_index(): < 50ms
- ✅ get_doc(): < 100ms
- ✅ get_bundle(): < 500ms
- ✅ Cache hit rate: > 70%

### Reliability
- ✅ 100% OASIS event emission
- ✅ Graceful error handling
- ✅ Zero security vulnerabilities

### Usage
- ✅ KB skills used in 50%+ of tasks
- ✅ Average 2-3 docs per task
- ✅ Zero failed document retrievals

---

## Decision Approved

**Implementing Option A: Local Filesystem Access**

Next: Begin implementation in crewai-gcp service
