"""
Integration Guide: Wiring KB Skills into CrewAI-GCP

This guide shows how to integrate KB skills into the existing
crewai-gcp service (main.py).

VTID: DEV-AICOR-0025
"""

# ============================================================================
# STEP 1: Update main.py imports
# ============================================================================

from kb_skills import init_kb_executor, KBSkills, create_kb_tools
from kb_executor import KBAccessError, DocumentNotFoundError

# ============================================================================
# STEP 2: Initialize KB executor at startup
# ============================================================================

# Add to main.py after FastAPI app creation:

@app.on_event("startup")
async def startup_event():
    """Initialize services on startup"""
    try:
        # Initialize KB executor
        kb_executor = init_kb_executor(
            base_path=os.getenv('KB_BASE_PATH', '/mnt/project'),
            cache_ttl=int(os.getenv('KB_CACHE_TTL', '3600')),
            max_doc_size=int(os.getenv('KB_MAX_DOC_SIZE', '1048576')),
            gateway_url=os.getenv('GATEWAY_URL', 'http://localhost:8080'),
            tenant=os.getenv('TENANT', 'vitana-dev')
        )
        print("✅ KB executor initialized")
        
        # Register KB tools with CrewAI
        kb_tools = create_kb_tools()
        app.state.kb_tools = kb_tools
        print(f"✅ Registered {len(kb_tools)} KB tools")
        
    except Exception as e:
        print(f"❌ Failed to initialize KB executor: {e}")
        # Don't fail startup - KB is optional enhancement

# ============================================================================
# STEP 3: Add KB access endpoints
# ============================================================================

@app.post("/kb/index")
async def kb_index(query: Optional[str] = None, vtid: str = "UNKNOWN"):
    """
    Browse KB index.
    
    Query params:
    - query: Optional search term
    - vtid: VTID for telemetry
    """
    try:
        result = KBSkills.get_index(query=query, vtid=vtid, agent_role="api")
        return result
    except Exception as e:
        return {"error": str(e)}, 500

@app.post("/kb/doc")
async def kb_doc(doc_name: str, vtid: str = "UNKNOWN"):
    """
    Get specific document.
    
    Body:
    - doc_name: Document filename
    - vtid: VTID for telemetry
    """
    try:
        result = KBSkills.get_doc(doc_name=doc_name, vtid=vtid, agent_role="api")
        return result
    except DocumentNotFoundError as e:
        return {"error": str(e)}, 404
    except KBAccessError as e:
        return {"error": str(e)}, 400
    except Exception as e:
        return {"error": str(e)}, 500

@app.post("/kb/bundle")
async def kb_bundle(bundle_name: str, vtid: str = "UNKNOWN"):
    """
    Get document bundle.
    
    Body:
    - bundle_name: Bundle name (cicd_docs, deployment_docs, etc.)
    - vtid: VTID for telemetry
    """
    try:
        result = KBSkills.get_bundle(
            bundle_name=bundle_name,
            vtid=vtid,
            agent_role="api"
        )
        return result
    except ValueError as e:
        return {"error": str(e)}, 400
    except Exception as e:
        return {"error": str(e)}, 500

# ============================================================================
# STEP 4: Integrate with agent execution flow
# ============================================================================

# For Planner agent - enrich task context:

def planner_execute_task(task: dict) -> dict:
    """
    Planner: Execute task with KB context enrichment.
    
    Args:
        task: Task dict with description, vtid, keywords
        
    Returns:
        Execution plan with KB context
    """
    vtid = task.get("vtid", "UNKNOWN")
    keywords = task.get("keywords", [])
    
    # Search KB for relevant docs
    try:
        index = KBSkills.get_index(
            query=" ".join(keywords),
            vtid=vtid,
            agent_role="planner"
        )
        
        # Get top 3 relevant documents
        relevant_docs = []
        for doc in index["documents"][:3]:
            try:
                doc_content = KBSkills.get_doc(
                    doc["name"],
                    vtid=vtid,
                    agent_role="planner"
                )
                relevant_docs.append({
                    "name": doc_content["name"],
                    "content": doc_content["content"][:500],  # First 500 chars
                    "size": doc_content["size"]
                })
            except Exception as e:
                print(f"⚠️ Failed to fetch {doc['name']}: {e}")
        
        # Add KB context to task
        task["kb_context"] = {
            "documents": relevant_docs,
            "total_found": index["total"]
        }
        
        print(f"✅ Enriched task with {len(relevant_docs)} KB documents")
        
    except Exception as e:
        print(f"⚠️ KB enrichment failed: {e}")
        # Continue without KB context - it's optional
    
    # Execute planning with enriched context
    plan = execute_planning_logic(task)
    
    return plan

# For Worker agent - load comprehensive bundle:

def worker_execute_task(task: dict) -> dict:
    """
    Worker: Execute task with KB bundle loaded.
    
    Args:
        task: Task dict with vtid, type, tags
        
    Returns:
        Execution result
    """
    vtid = task.get("vtid", "UNKNOWN")
    tags = task.get("tags", [])
    
    # Determine appropriate bundle
    bundle_name = None
    if "deployment" in tags:
        bundle_name = "deployment_docs"
    elif "cicd" in tags:
        bundle_name = "cicd_docs"
    elif "architecture" in tags:
        bundle_name = "architecture_docs"
    
    # Load bundle if relevant
    if bundle_name:
        try:
            bundle = KBSkills.get_bundle(
                bundle_name=bundle_name,
                vtid=vtid,
                agent_role="worker"
            )
            
            task["kb_bundle"] = {
                "name": bundle["bundle_name"],
                "docs": [
                    {"name": doc["name"], "size": doc["size"]}
                    for doc in bundle["documents"]
                ],
                "total_size": bundle["total_size"]
            }
            
            print(f"✅ Loaded {bundle['document_count']} docs from {bundle_name}")
            
        except Exception as e:
            print(f"⚠️ Bundle loading failed: {e}")
    
    # Execute work with KB context
    result = execute_work_logic(task)
    
    return result

# ============================================================================
# STEP 5: Add environment variable validation
# ============================================================================

@app.get("/health")
def health():
    """Health check with KB status"""
    kb_status = "not_initialized"
    
    try:
        from kb_skills import get_kb_executor
        executor = get_kb_executor()
        kb_status = "ok"
    except Exception as e:
        kb_status = f"error: {e}"
    
    return {
        "status": "ok",
        "service": "crewai-gcp",
        "kb_status": kb_status,
        "kb_base_path": os.getenv("KB_BASE_PATH", "not_set")
    }

# ============================================================================
# STEP 6: Add to requirements.txt
# ============================================================================

"""
Add to requirements.txt:

httpx>=0.24.0  # For async HTTP requests to Gateway
pytest>=7.4.0  # For KB executor tests
pytest-asyncio>=0.21.0  # For async test support
"""

# ============================================================================
# STEP 7: Environment variables
# ============================================================================

"""
Add to .env:

# KB Configuration
KB_BASE_PATH=/mnt/project
KB_CACHE_TTL=3600
KB_MAX_DOC_SIZE=1048576

# OASIS Integration
GATEWAY_URL=http://gateway:8080
TENANT=vitana-dev
GIT_SHA=${GIT_SHA:-unknown}
"""

# ============================================================================
# STEP 8: Docker deployment
# ============================================================================

"""
Update Dockerfile to mount /mnt/project:

# In docker-compose.yml or Cloud Run config:
volumes:
  - ./project_docs:/mnt/project:ro

# Or for Cloud Run, use Secret Manager:
gcloud run deploy crewai-gcp \
  --mount type=volume,source=kb-docs,target=/mnt/project
"""

# ============================================================================
# COMPLETE EXAMPLE: main.py with KB integration
# ============================================================================

COMPLETE_MAIN_PY = '''
from fastapi import FastAPI
from llm_router.router import get_router, AgentRole
from kb_skills import init_kb_executor, KBSkills, create_kb_tools
from kb_executor import KBAccessError, DocumentNotFoundError
import os

app = FastAPI()

@app.on_event("startup")
async def startup_event():
    """Initialize KB executor on startup"""
    try:
        init_kb_executor(
            base_path=os.getenv('KB_BASE_PATH', '/mnt/project'),
            gateway_url=os.getenv('GATEWAY_URL', 'http://localhost:8080'),
            tenant=os.getenv('TENANT', 'vitana-dev')
        )
        print("✅ KB executor initialized")
        
        kb_tools = create_kb_tools()
        app.state.kb_tools = kb_tools
        print(f"✅ Registered {len(kb_tools)} KB tools")
        
    except Exception as e:
        print(f"❌ KB initialization failed: {e}")

@app.get("/health")
def health():
    """Health check with KB status"""
    kb_status = "ok"
    try:
        from kb_skills import get_kb_executor
        get_kb_executor()
    except:
        kb_status = "not_initialized"
    
    return {
        "status": "ok",
        "service": "crewai-gcp",
        "role": "worker",
        "routing": "llm_router_v1",
        "kb_status": kb_status
    }

@app.post("/execute")
def execute(task: dict):
    """Execute task with KB context"""
    vtid = task.get("vtid", "UNKNOWN")
    agent_role = task.get("role", "worker")
    
    # Enrich with KB context
    try:
        if agent_role == "planner":
            # Planner: get relevant docs
            keywords = task.get("keywords", [])
            if keywords:
                index = KBSkills.get_index(
                    query=" ".join(keywords),
                    vtid=vtid,
                    agent_role="planner"
                )
                task["kb_available_docs"] = index["total"]
        
        elif agent_role == "worker":
            # Worker: load bundle
            tags = task.get("tags", [])
            if "deployment" in tags:
                bundle = KBSkills.get_bundle(
                    bundle_name="deployment_docs",
                    vtid=vtid,
                    agent_role="worker"
                )
                task["kb_docs_loaded"] = bundle["document_count"]
    
    except Exception as e:
        print(f"⚠️ KB enrichment failed: {e}")
    
    # Execute task with router
    router = get_router()
    result = router.complete(AgentRole.WORKER, prompt=task["description"])
    
    return {
        "status": "success",
        "result": result,
        "kb_enriched": "kb_available_docs" in task or "kb_docs_loaded" in task
    }

@app.post("/kb/index")
async def kb_index(query: str = None, vtid: str = "UNKNOWN"):
    """KB index endpoint"""
    try:
        return KBSkills.get_index(query=query, vtid=vtid, agent_role="api")
    except Exception as e:
        return {"error": str(e)}, 500

@app.post("/kb/doc")
async def kb_doc(doc_name: str, vtid: str = "UNKNOWN"):
    """KB document endpoint"""
    try:
        return KBSkills.get_doc(doc_name=doc_name, vtid=vtid, agent_role="api")
    except DocumentNotFoundError as e:
        return {"error": str(e)}, 404
    except Exception as e:
        return {"error": str(e)}, 500

@app.post("/kb/bundle")
async def kb_bundle(bundle_name: str, vtid: str = "UNKNOWN"):
    """KB bundle endpoint"""
    try:
        return KBSkills.get_bundle(bundle_name=bundle_name, vtid=vtid, agent_role="api")
    except ValueError as e:
        return {"error": str(e)}, 400
    except Exception as e:
        return {"error": str(e)}, 500
'''

print("Integration guide complete. See COMPLETE_MAIN_PY for full example.")
