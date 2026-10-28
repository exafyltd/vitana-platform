# VTID-01186 — Memory System: Migrate to Qdrant Cloud (Persistent Storage)

**VTID:** 01186
**Title:** Migrate Memory-Indexer from Local Qdrant to Qdrant Cloud
**Owner:** Claude (Worker)
**Validator:** Claude (Validator)
**Creativity:** FORBIDDEN
**Type:** Infrastructure + Memory Service
**Priority:** P0 - CRITICAL (Memory is completely broken without this)

---

## 0) HARD GOVERNANCE (NON-NEGOTIABLE)

1. **Qdrant Cloud is the ONLY vector store** - No local fallback
2. **Multi-tenancy metadata REQUIRED** on every vector
3. **Secrets via environment variables** - Never hardcode API keys
4. **No silent failures** - Emit OASIS error events on any failure
5. **Backward compatible** - Existing Supabase memory_items unaffected

---

## 1) PROBLEM STATEMENT

### Current State (BROKEN)
- Memory-indexer uses **local Qdrant** at `/tmp/qdrant`
- Cloud Run containers are **ephemeral** - storage lost on restart/scale-to-zero
- Result: **ALL MEMORIES DELETED** every ~15 minutes of inactivity

### Evidence
- User reports: "Memory doesn't work"
- AI responses: "Als KI habe ich keinen Zugriff auf deine persönlichen Informationen"
- Qdrant Cloud cluster exists but **NOT CONNECTED**

---

## 2) SOLUTION: USE EXISTING QDRANT CLOUD

### 2.1 Qdrant Cloud Cluster Details

```
Cluster ID: d1ddc241-17f0-4fb4-84b8-8fa8d3f59911
Endpoint:   https://d1ddc241-17f0-4fb4-84b8-8fa8d3f59911.us-east4-0.gcp.cloud.qdrant.io
Region:     us-east4 (GCP)
Version:    v1.16.3
Nodes:      1
Disk:       4 GiB
RAM:        1 GiB
```

### 2.2 Required Environment Variables

**File:** `services/agents/memory-indexer/.env.template`

```env
# Qdrant Cloud Configuration (REQUIRED)
QDRANT_URL=https://d1ddc241-17f0-4fb4-84b8-8fa8d3f59911.us-east4-0.gcp.cloud.qdrant.io
QDRANT_API_KEY=<from Qdrant Cloud API Keys tab>

# Anthropic for LLM fact extraction
ANTHROPIC_API_KEY=<existing>
```

### 2.3 Cloud Run Service Update

```bash
gcloud run services update vitana-memory-indexer \
  --region=us-central1 \
  --project=lovable-vitana-vers1 \
  --set-env-vars="QDRANT_URL=https://d1ddc241-17f0-4fb4-84b8-8fa8d3f59911.us-east4-0.gcp.cloud.qdrant.io" \
  --set-env-vars="QDRANT_API_KEY=<API_KEY>"
```

---

## 3) CODE CHANGES

### 3.1 Update mem0_service.py Configuration

**File:** `services/agents/memory-indexer/mem0_service.py`

**Change `Mem0Config.to_mem0_config()` from:**
```python
"vector_store": {
    "provider": "qdrant",
    "config": {
        "path": self.qdrant_path,  # LOCAL - BROKEN
        "embedding_model_dims": 384,
    },
},
```

**To:**
```python
"vector_store": {
    "provider": "qdrant",
    "config": {
        "url": os.environ.get("QDRANT_URL"),
        "api_key": os.environ.get("QDRANT_API_KEY"),
        "embedding_model_dims": 384,
    },
},
```

### 3.2 Add Startup Validation

**File:** `services/agents/memory-indexer/main.py`

Add at startup:
```python
# VTID-01186: Validate Qdrant Cloud configuration
QDRANT_URL = os.environ.get("QDRANT_URL")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY")

if not QDRANT_URL or not QDRANT_API_KEY:
    logger.error("[VTID-01186] CRITICAL: QDRANT_URL or QDRANT_API_KEY not set!")
    logger.error("[VTID-01186] Memory will NOT work without Qdrant Cloud connection")
    # Don't crash - allow health checks to pass, but log prominently
```

### 3.3 Remove Local Qdrant Path

**File:** `services/agents/memory-indexer/Dockerfile`

**Remove:**
```dockerfile
RUN mkdir -p /tmp/qdrant /root/.mem0
```

**Replace with:**
```dockerfile
RUN mkdir -p /root/.mem0
# VTID-01186: Qdrant Cloud used - no local storage needed
```

### 3.4 Update .gcp-config

**File:** `.gcp-config`

Add:
```
# Qdrant Cloud
QDRANT_CLUSTER_ID=d1ddc241-17f0-4fb4-84b8-8fa8d3f59911
QDRANT_URL=https://d1ddc241-17f0-4fb4-84b8-8fa8d3f59911.us-east4-0.gcp.cloud.qdrant.io
QDRANT_REGION=us-east4
```

---

## 4) MULTI-TENANCY METADATA

Every vector stored MUST include:

```python
metadata = {
    "tenant_id": str,      # UUID - tenant isolation
    "user_id": str,        # UUID - user isolation
    "role_context": str,   # Dev/Admin/Community/Professional/Patient
    "visibility": str,     # private/connections/professionals
    "source": str,         # orb/diary/upload/system
    "vtid": str,           # Provenance tracking
    "created_at": str,     # ISO timestamp
}
```

### 4.1 Update Memory Write

**File:** `services/agents/memory-indexer/mem0_service.py`

```python
def write(self, user_id: str, content: str, role: str = "user",
          metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:

    # VTID-01186: Enforce governance metadata
    required_metadata = {
        "tenant_id": metadata.get("tenant_id", "00000000-0000-0000-0000-000000000001"),
        "user_id": user_id,
        "role_context": metadata.get("role_context", "unknown"),
        "visibility": metadata.get("visibility", "private"),
        "source": metadata.get("source", "unknown"),
        "vtid": metadata.get("vtid", "VTID-01186"),
        "created_at": datetime.utcnow().isoformat(),
    }

    # Merge with provided metadata
    full_metadata = {**required_metadata, **(metadata or {})}

    # Store via Mem0 with metadata
    add_kwargs = {"user_id": user_id, "metadata": full_metadata}
```

### 4.2 Update Gateway Calls

**File:** `services/gateway/src/routes/orb-live.ts`

```typescript
writeToMemoryIndexer({
  user_id: userId,  // Real user ID, not DEV_IDENTITY
  content: inputText,
  role: 'user',
  metadata: {
    tenant_id: tenantId,
    user_id: userId,
    role_context: activeRole,
    visibility: 'private',
    source: 'orb',
    vtid: 'VTID-01186',
    orb_session_id: orbSessionId,
    conversation_id: conversationId,
  }
})
```

---

## 5) HEALTH CHECK UPDATE

**File:** `services/agents/memory-indexer/main.py`

```python
@app.route('/health', methods=['GET'])
def health():
    # VTID-01186: Include Qdrant Cloud connectivity status
    qdrant_status = "unknown"
    try:
        from qdrant_client import QdrantClient
        client = QdrantClient(
            url=os.environ.get("QDRANT_URL"),
            api_key=os.environ.get("QDRANT_API_KEY"),
            timeout=5
        )
        collections = client.get_collections()
        qdrant_status = "connected"
    except Exception as e:
        qdrant_status = f"error: {str(e)}"

    return jsonify({
        "service": "memory-indexer",
        "status": "ok" if qdrant_status == "connected" else "degraded",
        "vtid": "VTID-01152",
        "qdrant_cloud": qdrant_status,
        "qdrant_url": os.environ.get("QDRANT_URL", "NOT_SET")[:50] + "..."
    })
```

---

## 6) DEPLOYMENT STEPS

### Step 1: Get Qdrant API Key
1. Go to https://cloud.qdrant.io
2. Navigate to cluster → API Keys tab
3. Create or copy existing API key

### Step 2: Update Memory-Indexer
```bash
cd ~/vitana-platform

# Update code
git pull origin main

# Deploy with new env vars
gcloud run deploy vitana-memory-indexer \
  --source=services/agents/memory-indexer \
  --region=us-central1 \
  --project=lovable-vitana-vers1 \
  --set-env-vars="QDRANT_URL=https://d1ddc241-17f0-4fb4-84b8-8fa8d3f59911.us-east4-0.gcp.cloud.qdrant.io" \
  --set-env-vars="QDRANT_API_KEY=<API_KEY>" \
  --set-env-vars="ANTHROPIC_API_KEY=<EXISTING_KEY>"
```

### Step 3: Verify
```bash
curl https://vitana-memory-indexer-86804897789.us-central1.run.app/health
```

Expected:
```json
{
  "service": "memory-indexer",
  "status": "ok",
  "qdrant_cloud": "connected"
}
```

---

## 7) VERIFICATION

### Test 1: Memory Write
1. Say: "Ich heiße Thomas und wohne in Abu Dhabi"
2. Check Qdrant Cloud console → Collections → should see new vectors

### Test 2: Memory Persistence
1. Wait 20 minutes (Cloud Run scales to zero)
2. Say: "Wie ist mein Name?"
3. Should answer: "Thomas"

### Test 3: Cross-Session
1. Refresh page / new session
2. Ask: "Wo wohne ich?"
3. Should answer: "Abu Dhabi"

---

## 8) ROLLBACK PLAN

If Qdrant Cloud fails:
1. Revert to local Qdrant (accepts data loss)
2. Or: Emergency switch to Supabase pgvector

```bash
# Rollback command (data loss!)
gcloud run services update vitana-memory-indexer \
  --region=us-central1 \
  --project=lovable-vitana-vers1 \
  --remove-env-vars="QDRANT_URL,QDRANT_API_KEY"
```

---

## 9) SUCCESS CRITERIA

- [ ] Memory-indexer connects to Qdrant Cloud (health check shows "connected")
- [ ] Memories persist across container restarts
- [ ] Memories persist across sessions
- [ ] Multi-tenancy metadata present on all vectors
- [ ] No local /tmp/qdrant usage
- [ ] OASIS events emitted on failures

---

## 10) FILES TO MODIFY

| File | Change |
|------|--------|
| `services/agents/memory-indexer/mem0_service.py` | Use QDRANT_URL instead of local path |
| `services/agents/memory-indexer/main.py` | Add startup validation + health check |
| `services/agents/memory-indexer/Dockerfile` | Remove /tmp/qdrant creation |
| `services/agents/memory-indexer/.env.template` | Add QDRANT_URL, QDRANT_API_KEY |
| `services/gateway/src/routes/orb-live.ts` | Pass full metadata to memory writes |
| `.gcp-config` | Add Qdrant Cloud details |
