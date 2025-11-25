"""
KB Skills for CrewAI Integration

Provides skill wrappers for vitana.kb.* skills that can be invoked
by Planner and Worker agents.

VTID: DEV-AICOR-0025
"""

import asyncio
from typing import Dict, List, Optional, Any
from kb_executor import KBExecutor, KBAccessError, DocumentNotFoundError, InvalidPathError

# Global KB executor instance
_kb_executor: Optional[KBExecutor] = None

def init_kb_executor(**kwargs) -> KBExecutor:
    """
    Initialize global KB executor instance.
    
    Should be called once at service startup.
    
    Returns:
        KBExecutor instance
    """
    global _kb_executor
    if _kb_executor is None:
        _kb_executor = KBExecutor(**kwargs)
    return _kb_executor

def get_kb_executor() -> KBExecutor:
    """
    Get the global KB executor instance.
    
    Returns:
        KBExecutor instance
        
    Raises:
        RuntimeError: If executor not initialized
    """
    if _kb_executor is None:
        raise RuntimeError("KB executor not initialized. Call init_kb_executor() first.")
    return _kb_executor

class KBSkills:
    """
    KB Skills wrapper for CrewAI integration.
    
    Provides synchronous wrappers around async KB executor methods
    that can be invoked from CrewAI tools.
    """
    
    @staticmethod
    def get_index(
        query: Optional[str] = None,
        vtid: str = "UNKNOWN",
        agent_role: str = "planner"
    ) -> Dict[str, Any]:
        """
        Browse KB index (list of available documents).
        
        Skill: vitana.kb.get_index
        Agent: planner
        
        Args:
            query: Optional search term to filter documents
            vtid: VTID for telemetry
            agent_role: Agent role (planner/worker)
            
        Returns:
            Dictionary with:
            - total: Number of documents
            - documents: List of document metadata
            - categories: Document categories
            - bundles: Available bundle names
            
        Example:
            >>> result = KBSkills.get_index(query="deployment")
            >>> print(f"Found {result['total']} documents")
            >>> for doc in result['documents']:
            ...     print(f"  - {doc['name']} ({doc['category']})")
        """
        executor = get_kb_executor()
        return asyncio.run(executor.get_index(query, vtid, agent_role))
    
    @staticmethod
    def get_doc(
        doc_name: str,
        vtid: str = "UNKNOWN",
        agent_role: str = "planner"
    ) -> Dict[str, Any]:
        """
        Retrieve a specific document by name.
        
        Skill: vitana.kb.get_doc
        Agent: planner, worker
        
        Args:
            doc_name: Document filename (e.g., "07-GCP-DEPLOYMENT.md")
            vtid: VTID for telemetry
            agent_role: Agent role (planner/worker)
            
        Returns:
            Dictionary with:
            - name: Document name
            - content: Full document content
            - size: Document size in bytes
            - cache_hit: Whether result came from cache
            
        Example:
            >>> result = KBSkills.get_doc("07-GCP-DEPLOYMENT.md", vtid="DEV-CICDL-0033")
            >>> content = result['content']
            >>> print(f"Retrieved {len(content)} bytes")
        
        Raises:
            DocumentNotFoundError: If document doesn't exist
            InvalidPathError: If document name is invalid
        """
        executor = get_kb_executor()
        return asyncio.run(executor.get_doc(doc_name, vtid, agent_role))
    
    @staticmethod
    def get_bundle(
        bundle_name: Optional[str] = None,
        doc_names: Optional[List[str]] = None,
        vtid: str = "UNKNOWN",
        agent_role: str = "worker"
    ) -> Dict[str, Any]:
        """
        Get multiple documents as a bundle.
        
        Skill: vitana.kb.get_bundle
        Agent: worker
        
        Args:
            bundle_name: Predefined bundle (e.g., "cicd_docs", "deployment_docs")
            doc_names: Custom list of document names
            vtid: VTID for telemetry
            agent_role: Agent role (planner/worker)
            
        Returns:
            Dictionary with:
            - bundle_name: Name of the bundle
            - document_count: Number of documents retrieved
            - documents: List of document objects
            - total_size: Combined size of all documents
            
        Available Bundles:
            - cicd_docs: CI/CD and workflow documentation
            - deployment_docs: Deployment and architecture docs
            - architecture_docs: System architecture documentation
            - tracking_docs: VTID and OASIS tracking docs
            - all_docs: All documentation
            
        Example:
            >>> result = KBSkills.get_bundle(bundle_name="cicd_docs", vtid="DEV-CICDL-0031")
            >>> print(f"Loaded {result['document_count']} documents")
            >>> for doc in result['documents']:
            ...     print(f"  - {doc['name']}: {len(doc['content'])} bytes")
        
        Raises:
            ValueError: If neither bundle_name nor doc_names provided
            KBAccessError: If bundle retrieval fails
        """
        executor = get_kb_executor()
        return asyncio.run(executor.get_bundle(bundle_name, doc_names, vtid, agent_role))

# CrewAI Tool Definitions
# These can be registered with CrewAI's tool system

def create_kb_tools():
    """
    Create CrewAI-compatible tool definitions for KB skills.
    
    Returns:
        List of tool dictionaries that can be registered with CrewAI
    """
    return [
        {
            "name": "vitana_kb_get_index",
            "description": (
                "Browse the knowledge base index to discover available documentation. "
                "Optionally filter by search query. "
                "Returns list of documents with metadata and categories. "
                "Use this to find relevant docs before retrieving them."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Optional search term to filter documents"
                    },
                    "vtid": {
                        "type": "string",
                        "description": "VTID for telemetry tracking"
                    }
                }
            },
            "function": KBSkills.get_index
        },
        {
            "name": "vitana_kb_get_doc",
            "description": (
                "Retrieve a specific document from the knowledge base. "
                "Returns full document content. "
                "Use after finding relevant docs via get_index."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_name": {
                        "type": "string",
                        "description": "Document filename (e.g., '07-GCP-DEPLOYMENT.md')",
                        "required": True
                    },
                    "vtid": {
                        "type": "string",
                        "description": "VTID for telemetry tracking"
                    }
                },
                "required": ["doc_name"]
            },
            "function": KBSkills.get_doc
        },
        {
            "name": "vitana_kb_get_bundle",
            "description": (
                "Retrieve multiple related documents as a bundle. "
                "Faster than multiple individual get_doc calls. "
                "Available bundles: cicd_docs, deployment_docs, architecture_docs, tracking_docs. "
                "Use for comprehensive context on a topic."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "bundle_name": {
                        "type": "string",
                        "description": "Predefined bundle name (cicd_docs, deployment_docs, etc.)",
                        "enum": ["cicd_docs", "deployment_docs", "architecture_docs", "tracking_docs", "all_docs"]
                    },
                    "doc_names": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Custom list of document names"
                    },
                    "vtid": {
                        "type": "string",
                        "description": "VTID for telemetry tracking"
                    }
                }
            },
            "function": KBSkills.get_bundle
        }
    ]

# Example usage in agent context
class AgentKBIntegration:
    """
    Example integration of KB skills into agent workflow.
    
    This shows how Planner and Worker agents can use KB skills
    during task execution.
    """
    
    @staticmethod
    def planner_enrich_context(task: Dict[str, Any]) -> Dict[str, Any]:
        """
        Planner: Enrich task context with KB documentation.
        
        Args:
            task: Task dictionary with description, vtid, keywords
            
        Returns:
            Enriched task with kb_context
        """
        vtid = task.get("vtid", "UNKNOWN")
        keywords = task.get("keywords", [])
        
        # Search KB for relevant docs
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
                relevant_docs.append(doc_content)
            except Exception as e:
                print(f"⚠️ Failed to fetch {doc['name']}: {e}")
        
        # Add to task context
        task["kb_context"] = {
            "documents": relevant_docs,
            "doc_names": [doc["name"] for doc in relevant_docs],
            "total_docs_found": index["total"]
        }
        
        return task
    
    @staticmethod
    def worker_load_bundle(task: Dict[str, Any]) -> Dict[str, Any]:
        """
        Worker: Load comprehensive KB bundle for task execution.
        
        Args:
            task: Task dictionary with vtid, type, tags
            
        Returns:
            Task with kb_bundle loaded
        """
        vtid = task.get("vtid", "UNKNOWN")
        task_type = task.get("type", "")
        tags = task.get("tags", [])
        
        # Determine appropriate bundle
        bundle_name = None
        if "deployment" in tags or "deploy" in task_type.lower():
            bundle_name = "deployment_docs"
        elif "cicd" in tags or "workflow" in task_type.lower():
            bundle_name = "cicd_docs"
        elif "architecture" in tags or "system" in task_type.lower():
            bundle_name = "architecture_docs"
        elif "vtid" in tags or "tracking" in task_type.lower():
            bundle_name = "tracking_docs"
        
        if bundle_name:
            try:
                bundle = KBSkills.get_bundle(
                    bundle_name=bundle_name,
                    vtid=vtid,
                    agent_role="worker"
                )
                task["kb_bundle"] = bundle
                print(f"✅ Loaded {bundle['document_count']} docs from {bundle_name}")
            except Exception as e:
                print(f"⚠️ Failed to load bundle {bundle_name}: {e}")
        
        return task
