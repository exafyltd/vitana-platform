"""
Vitana KB Tools
FastAPI tools for accessing Knowledge Base from agents.
Implements the skills defined in crew_template/skills/vitana_kb_skills.yaml
"""
import sys
import os
from typing import Optional, Dict, Any, List

# Add shared directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../shared'))

from vitana_kb_client import get_kb_client, KBClientError
import requests
import json


class KBTools:
    """KB Tools for agent access"""
    
    def __init__(self, gateway_url: Optional[str] = None):
        """Initialize KB tools with optional gateway URL override"""
        self.client = get_kb_client()
        if gateway_url:
            self.client.base_url = gateway_url
            self.client.kb_endpoint = f"{gateway_url}/api/kb"
        
        self.gateway_url = self.client.base_url
    
    def _emit_oasis_event(self, event_type: str, metadata: Dict[str, Any]) -> Optional[str]:
        """Emit OASIS event for KB usage tracking"""
        try:
            response = requests.post(
                f"{self.gateway_url}/events/ingest",
                json={
                    "rid": metadata.get("rid", "unknown"),
                    "tenant": metadata.get("tenant", "vitana"),
                    "task_type": event_type,
                    "assignee_ai": metadata.get("assignee_ai", "kb-agent"),
                    "status": "completed",
                    "notes": metadata.get("notes", ""),
                    "metadata": metadata,
                    "schema_version": 1
                },
                timeout=5
            )
            response.raise_for_status()
            return response.json().get("event_id")
        except Exception as e:
            print(f"⚠️ Failed to emit OASIS event: {e}")
            return None
    
    def get_index(
        self,
        family_id: Optional[str] = None,
        status: Optional[str] = None,
        tag: Optional[str] = None,
        rid: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Fetch KB index to discover available documents.
        
        Args:
            family_id: Filter by document family
            status: Filter by status
            tag: Filter by tag
            rid: Request ID for OASIS tracking
            
        Returns:
            Dict with total_docs, docs list, and families
        """
        try:
            index = self.client.get_index(family_id=family_id, status=status, tag=tag)
            
            # Convert to dict for JSON serialization
            result = {
                "total_docs": index.total_docs,
                "docs": [
                    {
                        "doc_id": doc.doc_id,
                        "title": doc.title,
                        "family_id": doc.family_id,
                        "family_name": doc.family_name,
                        "status": doc.status,
                        "version": doc.version,
                        "tags": doc.tags,
                        "word_count": doc.word_count,
                        "section_count": doc.section_count
                    }
                    for doc in index.docs
                ],
                "families": index.families,
                "generated_at": index.generated_at
            }
            
            # Emit OASIS event
            self._emit_oasis_event("kb.index_accessed", {
                "rid": rid,
                "family_id": family_id,
                "status": status,
                "tag": tag,
                "total_docs": index.total_docs,
                "notes": f"KB index accessed: {index.total_docs} docs"
            })
            
            return result
            
        except KBClientError as e:
            return {"error": str(e), "total_docs": 0, "docs": []}
    
    def get_doc(self, doc_id: str, rid: Optional[str] = None) -> Dict[str, Any]:
        """
        Fetch complete document with all sections.
        
        Args:
            doc_id: Document ID
            rid: Request ID for OASIS tracking
            
        Returns:
            Dict with doc_id, title, sections, etc.
        """
        try:
            doc = self.client.get_doc(doc_id)
            
            result = {
                "doc_id": doc.doc_id,
                "title": doc.title,
                "family_id": doc.family_id,
                "family_name": doc.family_name,
                "word_count": doc.word_count,
                "sections": doc.sections,
                "section_count": len(doc.sections)
            }
            
            # Emit OASIS event
            self._emit_oasis_event("kb.doc_accessed", {
                "rid": rid,
                "doc_id": doc_id,
                "word_count": doc.word_count,
                "section_count": len(doc.sections),
                "notes": f"KB doc accessed: {doc.title} ({doc.word_count} words)"
            })
            
            return result
            
        except KBClientError as e:
            return {"error": str(e), "doc_id": doc_id}
    
    def get_bundle(
        self,
        docs: List[Dict[str, Any]],
        max_total_words: Optional[int] = None,
        rid: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Create custom bundle with word limits.
        
        Args:
            docs: List of doc requests with doc_id and optional section_ids
            max_total_words: Maximum total words
            rid: Request ID for OASIS tracking
            
        Returns:
            Dict with docs, total_words, truncated flag
        """
        try:
            bundle = self.client.get_bundle(docs=docs, max_total_words=max_total_words)
            
            result = {
                "docs": [
                    {
                        "doc_id": doc.doc_id,
                        "title": doc.title,
                        "family_id": doc.family_id,
                        "family_name": doc.family_name,
                        "sections": doc.sections,
                        "word_count": doc.word_count
                    }
                    for doc in bundle.docs
                ],
                "total_words": bundle.total_words,
                "truncated": bundle.truncated
            }
            
            # Emit OASIS event
            doc_ids = [d["doc_id"] for d in docs]
            self._emit_oasis_event("kb.bundle_created", {
                "rid": rid,
                "doc_ids": doc_ids,
                "max_total_words": max_total_words,
                "actual_words": bundle.total_words,
                "truncated": bundle.truncated,
                "notes": f"KB bundle created: {len(bundle.docs)} docs, {bundle.total_words} words"
            })
            
            return result
            
        except KBClientError as e:
            return {"error": str(e), "docs": [], "total_words": 0, "truncated": False}


# Singleton instance
_kb_tools = None

def get_kb_tools() -> KBTools:
    """Get singleton KB tools instance"""
    global _kb_tools
    if _kb_tools is None:
        _kb_tools = KBTools()
    return _kb_tools
