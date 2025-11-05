"""
Vitana Knowledge Base Executor

Provides autonomous KB access for AI agents with OASIS telemetry.

VTID: DEV-AICOR-0025
"""

import os
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Any
from functools import lru_cache
from datetime import datetime, timedelta
import httpx
import asyncio

class KBAccessError(Exception):
    """Base exception for KB access errors"""
    pass

class DocumentNotFoundError(KBAccessError):
    """Raised when a document is not found"""
    pass

class InvalidPathError(KBAccessError):
    """Raised when path validation fails"""
    pass

class KBExecutor:
    """
    Knowledge Base executor with local filesystem access and OASIS telemetry.
    
    Features:
    - Safe filesystem access with path validation
    - LRU caching for frequently accessed documents
    - OASIS event emission for all operations
    - Support for index queries, single docs, and doc bundles
    """
    
    def __init__(
        self,
        base_path: Optional[str] = None,
        cache_ttl: int = 3600,
        max_doc_size: int = 1048576,
        gateway_url: Optional[str] = None,
        tenant: str = "vitana-dev"
    ):
        self.base_path = Path(base_path or os.getenv('KB_BASE_PATH', '/mnt/project'))
        self.cache_ttl = cache_ttl
        self.max_doc_size = max_doc_size
        self.gateway_url = gateway_url or os.getenv('GATEWAY_URL', 'http://localhost:8080')
        self.tenant = tenant
        self.git_sha = os.getenv('GIT_SHA', 'unknown')
        
        # Document bundles (predefined sets)
        self.bundles = {
            "cicd_docs": [
                "05-CI-CD-PATTERNS.md",
                "06-GITHUB-WORKFLOW.md",
                "07-GCP-DEPLOYMENT.md"
            ],
            "deployment_docs": [
                "07-GCP-DEPLOYMENT.md",
                "04-SERVICES-ARCHITECTURE.md"
            ],
            "architecture_docs": [
                "01-PROJECT-OVERVIEW.md",
                "04-SERVICES-ARCHITECTURE.md",
                "03-OASIS-SCHEMA.md"
            ],
            "tracking_docs": [
                "02-VTID-SYSTEM.md",
                "03-OASIS-SCHEMA.md",
                "08-ACTIVE-VTIDS.md"
            ],
            "all_docs": [
                "01-PROJECT-OVERVIEW.md",
                "02-VTID-SYSTEM.md",
                "03-OASIS-SCHEMA.md",
                "04-SERVICES-ARCHITECTURE.md",
                "05-CI-CD-PATTERNS.md",
                "06-GITHUB-WORKFLOW.md",
                "07-GCP-DEPLOYMENT.md",
                "08-ACTIVE-VTIDS.md",
                "09-QUICK-REFERENCE.md",
                "10-INTEGRATION-SETUP-GUIDE.md"
            ]
        }
        
        # Cache for documents (simple dict-based cache)
        self._doc_cache: Dict[str, tuple[str, datetime]] = {}
        
        # Validate base path
        self._validate_base_path()
        
    def _validate_base_path(self):
        """Validate that KB_BASE_PATH exists and is accessible"""
        if not self.base_path.exists():
            raise ValueError(f"KB_BASE_PATH does not exist: {self.base_path}")
        if not self.base_path.is_dir():
            raise ValueError(f"KB_BASE_PATH is not a directory: {self.base_path}")
    
    def _validate_path(self, doc_name: str) -> Path:
        """
        Validate document path to prevent directory traversal attacks.
        
        Args:
            doc_name: Document filename
            
        Returns:
            Validated Path object
            
        Raises:
            InvalidPathError: If path is invalid or outside base_path
        """
        # Remove any path components (only allow filename)
        if '/' in doc_name or '\\' in doc_name:
            raise InvalidPathError(f"Document name cannot contain path separators: {doc_name}")
        
        # Only allow .md files
        if not doc_name.endswith('.md'):
            raise InvalidPathError(f"Only .md files are allowed: {doc_name}")
        
        safe_path = self.base_path / doc_name
        
        # Ensure resolved path is within base_path
        try:
            safe_path.resolve().relative_to(self.base_path.resolve())
        except ValueError:
            raise InvalidPathError(f"Path outside KB directory: {doc_name}")
        
        return safe_path
    
    def _get_cached_doc(self, doc_name: str) -> Optional[str]:
        """Get document from cache if not expired"""
        if doc_name in self._doc_cache:
            content, cached_at = self._doc_cache[doc_name]
            if datetime.now() - cached_at < timedelta(seconds=self.cache_ttl):
                return content
            else:
                # Expired, remove from cache
                del self._doc_cache[doc_name]
        return None
    
    def _cache_doc(self, doc_name: str, content: str):
        """Cache document content"""
        self._doc_cache[doc_name] = (content, datetime.now())
    
    async def _emit_oasis_event(
        self,
        event_type: str,
        vtid: str,
        agent_role: str,
        skill_name: str,
        metadata: Dict[str, Any],
        status: str = "success"
    ):
        """
        Emit OASIS event to Gateway.
        
        Args:
            event_type: Type of event (kb.skill_invoked, etc.)
            vtid: VTID associated with the operation
            agent_role: Role of the agent (planner/worker)
            skill_name: Name of the KB skill being executed
            metadata: Additional metadata
            status: Event status (start/success/fail)
        """
        payload = {
            "service": "crewai-kb-executor",
            "event": event_type,
            "tenant": self.tenant,
            "status": status,
            "notes": f"KB {event_type} for {vtid}",
            "git_sha": self.git_sha,
            "rid": str(uuid.uuid4()),
            "metadata": {
                "vtid": vtid,
                "agent_role": agent_role,
                "skill_name": skill_name,
                **metadata
            }
        }
        
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(
                    f"{self.gateway_url}/events/ingest",
                    json=payload
                )
                if response.status_code != 200:
                    print(f"⚠️ OASIS event emission failed: {response.status_code}")
        except Exception as e:
            print(f"⚠️ Failed to emit OASIS event: {e}")
            # Don't raise - telemetry failure shouldn't break KB access
    
    async def get_index(
        self,
        query: Optional[str] = None,
        vtid: str = "UNKNOWN",
        agent_role: str = "planner"
    ) -> Dict[str, Any]:
        """
        Get KB index (list of available documents).
        
        Args:
            query: Optional search term to filter documents
            vtid: VTID for telemetry
            agent_role: Agent role (planner/worker)
            
        Returns:
            Dictionary with documents list and metadata
        """
        start_time = time.time()
        
        # Emit invoked event
        await self._emit_oasis_event(
            "kb.skill_invoked",
            vtid,
            agent_role,
            "vitana.kb.get_index",
            {"query": query},
            "start"
        )
        
        try:
            # List all .md files in base_path
            all_docs = sorted([
                f.name for f in self.base_path.glob("*.md")
            ])
            
            # Filter by query if provided
            if query:
                query_lower = query.lower()
                filtered_docs = [
                    doc for doc in all_docs
                    if query_lower in doc.lower()
                ]
            else:
                filtered_docs = all_docs
            
            # Categorize documents
            categories = {
                "overview": [],
                "architecture": [],
                "deployment": [],
                "tracking": [],
                "reference": []
            }
            
            for doc in filtered_docs:
                doc_lower = doc.lower()
                if "overview" in doc_lower or "project" in doc_lower:
                    categories["overview"].append(doc)
                elif "architecture" in doc_lower or "services" in doc_lower or "schema" in doc_lower:
                    categories["architecture"].append(doc)
                elif "deployment" in doc_lower or "cicd" in doc_lower or "github" in doc_lower or "gcp" in doc_lower:
                    categories["deployment"].append(doc)
                elif "vtid" in doc_lower or "oasis" in doc_lower or "active" in doc_lower:
                    categories["tracking"].append(doc)
                else:
                    categories["reference"].append(doc)
            
            execution_time_ms = int((time.time() - start_time) * 1000)
            
            result = {
                "total": len(filtered_docs),
                "documents": [
                    {
                        "name": doc,
                        "category": next((cat for cat, docs in categories.items() if doc in docs), "reference"),
                        "size": (self.base_path / doc).stat().st_size
                    }
                    for doc in filtered_docs
                ],
                "categories": {k: len(v) for k, v in categories.items() if v},
                "bundles": list(self.bundles.keys()),
                "query": query,
                "execution_time_ms": execution_time_ms
            }
            
            # Emit index accessed event
            await self._emit_oasis_event(
                "kb.index_accessed",
                vtid,
                agent_role,
                "vitana.kb.get_index",
                {
                    "query": query,
                    "docs_count": len(filtered_docs),
                    "execution_time_ms": execution_time_ms,
                    "cache_hit": False
                },
                "success"
            )
            
            return result
            
        except Exception as e:
            execution_time_ms = int((time.time() - start_time) * 1000)
            await self._emit_oasis_event(
                "kb.index_accessed",
                vtid,
                agent_role,
                "vitana.kb.get_index",
                {
                    "query": query,
                    "error": str(e),
                    "execution_time_ms": execution_time_ms
                },
                "fail"
            )
            raise KBAccessError(f"Failed to get index: {e}")
    
    async def get_doc(
        self,
        doc_name: str,
        vtid: str = "UNKNOWN",
        agent_role: str = "planner"
    ) -> Dict[str, Any]:
        """
        Get a specific document by name.
        
        Args:
            doc_name: Document filename
            vtid: VTID for telemetry
            agent_role: Agent role (planner/worker)
            
        Returns:
            Dictionary with document content and metadata
            
        Raises:
            DocumentNotFoundError: If document doesn't exist
            InvalidPathError: If path validation fails
        """
        start_time = time.time()
        cache_hit = False
        
        # Emit invoked event
        await self._emit_oasis_event(
            "kb.skill_invoked",
            vtid,
            agent_role,
            "vitana.kb.get_doc",
            {"doc_name": doc_name},
            "start"
        )
        
        try:
            # Check cache first
            cached_content = self._get_cached_doc(doc_name)
            if cached_content:
                cache_hit = True
                content = cached_content
            else:
                # Validate path
                safe_path = self._validate_path(doc_name)
                
                if not safe_path.exists():
                    raise DocumentNotFoundError(f"Document not found: {doc_name}")
                
                # Check size
                file_size = safe_path.stat().st_size
                if file_size > self.max_doc_size:
                    raise KBAccessError(f"Document too large: {doc_name} ({file_size} bytes)")
                
                # Read document
                content = safe_path.read_text(encoding='utf-8')
                
                # Cache it
                self._cache_doc(doc_name, content)
            
            execution_time_ms = int((time.time() - start_time) * 1000)
            
            result = {
                "name": doc_name,
                "content": content,
                "size": len(content),
                "last_modified": datetime.fromtimestamp(
                    (self.base_path / doc_name).stat().st_mtime
                ).isoformat() if not cache_hit else None,
                "cache_hit": cache_hit,
                "execution_time_ms": execution_time_ms
            }
            
            # Emit doc accessed event
            await self._emit_oasis_event(
                "kb.doc_accessed",
                vtid,
                agent_role,
                "vitana.kb.get_doc",
                {
                    "doc_name": doc_name,
                    "doc_size": len(content),
                    "execution_time_ms": execution_time_ms,
                    "cache_hit": cache_hit
                },
                "success"
            )
            
            return result
            
        except (DocumentNotFoundError, InvalidPathError, KBAccessError) as e:
            execution_time_ms = int((time.time() - start_time) * 1000)
            await self._emit_oasis_event(
                "kb.doc_accessed",
                vtid,
                agent_role,
                "vitana.kb.get_doc",
                {
                    "doc_name": doc_name,
                    "error": str(e),
                    "execution_time_ms": execution_time_ms,
                    "cache_hit": False
                },
                "fail"
            )
            raise
        except Exception as e:
            execution_time_ms = int((time.time() - start_time) * 1000)
            await self._emit_oasis_event(
                "kb.doc_accessed",
                vtid,
                agent_role,
                "vitana.kb.get_doc",
                {
                    "doc_name": doc_name,
                    "error": str(e),
                    "execution_time_ms": execution_time_ms,
                    "cache_hit": False
                },
                "fail"
            )
            raise KBAccessError(f"Failed to get document {doc_name}: {e}")
    
    async def get_bundle(
        self,
        bundle_name: Optional[str] = None,
        doc_names: Optional[List[str]] = None,
        vtid: str = "UNKNOWN",
        agent_role: str = "worker"
    ) -> Dict[str, Any]:
        """
        Get multiple documents as a bundle.
        
        Args:
            bundle_name: Predefined bundle name (e.g., "cicd_docs")
            doc_names: Custom list of document names
            vtid: VTID for telemetry
            agent_role: Agent role (planner/worker)
            
        Returns:
            Dictionary with multiple document contents and metadata
            
        Raises:
            ValueError: If neither bundle_name nor doc_names provided
            KBAccessError: If bundle retrieval fails
        """
        start_time = time.time()
        
        # Determine which documents to fetch
        if bundle_name:
            if bundle_name not in self.bundles:
                raise ValueError(f"Unknown bundle: {bundle_name}. Available: {list(self.bundles.keys())}")
            docs_to_fetch = self.bundles[bundle_name]
        elif doc_names:
            docs_to_fetch = doc_names
        else:
            raise ValueError("Must provide either bundle_name or doc_names")
        
        # Emit invoked event
        await self._emit_oasis_event(
            "kb.skill_invoked",
            vtid,
            agent_role,
            "vitana.kb.get_bundle",
            {
                "bundle_name": bundle_name,
                "doc_count": len(docs_to_fetch)
            },
            "start"
        )
        
        try:
            # Fetch all documents
            documents = []
            failed_docs = []
            
            for doc_name in docs_to_fetch:
                try:
                    doc = await self.get_doc(doc_name, vtid, agent_role)
                    documents.append(doc)
                except Exception as e:
                    print(f"⚠️ Failed to fetch {doc_name}: {e}")
                    failed_docs.append({"name": doc_name, "error": str(e)})
            
            execution_time_ms = int((time.time() - start_time) * 1000)
            
            result = {
                "bundle_name": bundle_name,
                "document_count": len(documents),
                "documents": documents,
                "failed_documents": failed_docs,
                "total_size": sum(doc["size"] for doc in documents),
                "execution_time_ms": execution_time_ms
            }
            
            # Emit bundle created event
            await self._emit_oasis_event(
                "kb.bundle_created",
                vtid,
                agent_role,
                "vitana.kb.get_bundle",
                {
                    "bundle_name": bundle_name,
                    "doc_names": [doc["name"] for doc in documents],
                    "docs_count": len(documents),
                    "failed_count": len(failed_docs),
                    "total_size": result["total_size"],
                    "execution_time_ms": execution_time_ms
                },
                "success"
            )
            
            return result
            
        except Exception as e:
            execution_time_ms = int((time.time() - start_time) * 1000)
            await self._emit_oasis_event(
                "kb.bundle_created",
                vtid,
                agent_role,
                "vitana.kb.get_bundle",
                {
                    "bundle_name": bundle_name,
                    "error": str(e),
                    "execution_time_ms": execution_time_ms
                },
                "fail"
            )
            raise KBAccessError(f"Failed to get bundle: {e}")
