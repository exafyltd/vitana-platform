from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from llm_router.router import get_router, AgentRole
from kb_tools import get_kb_tools

app = FastAPI()
kb_tools = get_kb_tools()

# Existing endpoints
@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "crewai-vitana-agent",
        "role": "multi-agent",
        "routing": "llm_router_v1",
        "kb_enabled": True
    }

# KB Endpoints
class KBIndexRequest(BaseModel):
    family_id: Optional[str] = None
    status: Optional[str] = None
    tag: Optional[str] = None
    rid: Optional[str] = None

@app.post("/kb/index")
def kb_index(req: KBIndexRequest):
    """Get KB index"""
    return kb_tools.get_index(
        family_id=req.family_id,
        status=req.status,
        tag=req.tag,
        rid=req.rid
    )

class KBDocRequest(BaseModel):
    doc_id: str
    rid: Optional[str] = None

@app.post("/kb/doc")
def kb_doc(req: KBDocRequest):
    """Get full KB document"""
    result = kb_tools.get_doc(doc_id=req.doc_id, rid=req.rid)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result

class KBBundleRequest(BaseModel):
    docs: List[Dict[str, Any]]
    max_total_words: Optional[int] = None
    rid: Optional[str] = None

@app.post("/kb/bundle")
def kb_bundle(req: KBBundleRequest):
    """Create KB bundle"""
    return kb_tools.get_bundle(
        docs=req.docs,
        max_total_words=req.max_total_words,
        rid=req.rid
    )

# Demo: KB-powered task execution
class TaskRequest(BaseModel):
    prompt: str
    role: str = "worker"
    rid: Optional[str] = None
    use_kb_context: bool = True
    kb_doc_ids: Optional[List[str]] = None
    max_kb_words: Optional[int] = 500

@app.post("/execute/task")
def execute_task(req: TaskRequest):
    """
    Execute a task with optional KB context.
    
    This is a demo endpoint showing how agents use KB in their workflow:
    1. Fetch relevant KB context if use_kb_context=True
    2. Include context in LLM prompt
    3. Execute task with LLM router
    4. Log KB usage to OASIS
    """
    kb_context = ""
    kb_metadata = {}
    
    # Step 1: Fetch KB context if requested
    if req.use_kb_context:
        if req.kb_doc_ids:
            # User specified which docs to use
            docs_request = [{"doc_id": doc_id} for doc_id in req.kb_doc_ids]
            bundle = kb_tools.get_bundle(
                docs=docs_request,
                max_total_words=req.max_kb_words,
                rid=req.rid
            )
            
            if "error" not in bundle:
                # Format KB context for prompt
                kb_context = "\n\n=== VITANA KNOWLEDGE BASE CONTEXT ===\n"
                for doc in bundle["docs"]:
                    kb_context += f"\n## {doc['title']} ({doc['word_count']} words)\n"
                    for section in doc["sections"][:5]:  # Limit sections
                        kb_context += f"\n### {section.get('title', 'Section')}\n"
                        kb_context += section.get('content_markdown', section.get('content', ''))[:500]
                        kb_context += "\n"
                
                kb_metadata = {
                    "kb_docs_used": [doc["doc_id"] for doc in bundle["docs"]],
                    "kb_total_words": bundle["total_words"],
                    "kb_truncated": bundle["truncated"]
                }
        else:
            # Auto-fetch foundation docs for general context
            bundle = kb_tools.get_bundle(
                docs=[{"doc_id": "00-foundation-doc-00-0001_vitana-vision-strategy-ecosystem"}],
                max_total_words=req.max_kb_words,
                rid=req.rid
            )
            if "error" not in bundle:
                kb_context = "\n\n=== VITANA CONTEXT ===\n"
                kb_context += f"Vision: {bundle['docs'][0]['title']}\n"
                kb_metadata = {"kb_auto_context": True}
    
    # Step 2: Build enhanced prompt
    enhanced_prompt = req.prompt
    if kb_context:
        enhanced_prompt = f"{kb_context}\n\n=== TASK ===\n{req.prompt}"
    
    # Step 3: Execute with LLM router
    router = get_router()
    role = AgentRole[req.role.upper()] if req.role.upper() in AgentRole.__members__ else AgentRole.WORKER
    
    llm_result = router.complete(
        role=role,
        prompt=enhanced_prompt,
        metadata={
            "rid": req.rid,
            "original_prompt": req.prompt,
            "kb_enhanced": bool(kb_context),
            **kb_metadata
        }
    )
    
    # Step 4: Return results with KB metadata
    return {
        "rid": req.rid,
        "role": req.role,
        "task_prompt": req.prompt,
        "kb_context_used": bool(kb_context),
        "kb_metadata": kb_metadata,
        "llm_result": llm_result,
        "oasis_logged": True
    }

@app.post("/execute")
def execute():
    """Legacy execute endpoint"""
    return {"status": "success", "note": "Use /execute/task for KB-powered execution"}
