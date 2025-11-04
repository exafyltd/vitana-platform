"""
Vitana Knowledge Base Client
Shared client for accessing the Vitana KB API from agents.
"""
import os
import requests
from typing import Optional, List, Dict, Any
from dataclasses import dataclass


class KBClientError(Exception):
    """Base exception for KB client errors"""
    pass


@dataclass
class KBDoc:
    """KB Document metadata"""
    doc_id: str
    title: str
    family_id: str
    family_name: str
    status: str
    version: str
    tags: List[str]
    word_count: int
    section_count: Optional[int] = None


@dataclass
class KBDocSnapshot:
    """Full KB document with sections"""
    doc_id: str
    title: str
    family_id: str
    family_name: str
    word_count: int
    sections: List[Dict[str, Any]]


@dataclass
class KBIndex:
    """KB Index response"""
    total_docs: int
    docs: List[KBDoc]
    families: Dict[str, Dict[str, Any]]
    generated_at: str


@dataclass
class KBBundleDoc:
    """Document in a bundle response"""
    doc_id: str
    title: str
    family_id: str
    family_name: str
    sections: List[Dict[str, Any]]
    word_count: int


@dataclass
class KBBundle:
    """KB Bundle response"""
    docs: List[KBBundleDoc]
    total_words: int
    truncated: bool


class VitanaKBClient:
    """
    Client for accessing Vitana Knowledge Base API.
    
    Usage:
        client = VitanaKBClient()
        index = client.get_index()
        doc = client.get_doc("00-foundation-doc-00-0001_vitana-vision-strategy-ecosystem")
        bundle = client.get_bundle([{"doc_id": "DOC-00-0001"}], max_total_words=500)
    """
    
    def __init__(self, base_url: Optional[str] = None, timeout: int = 30):
        """Initialize KB client."""
        self.base_url = (
            base_url 
            or os.getenv("VITANA_GATEWAY_URL")
            or "https://vitana-dev-gateway-q74ibpv6ia-uc.a.run.app"
        )
        self.timeout = timeout
        self.kb_endpoint = f"{self.base_url}/api/kb"
        
    def get_index(self, family_id: Optional[str] = None, status: Optional[str] = None, tag: Optional[str] = None) -> KBIndex:
        """Get KB index with optional filters."""
        try:
            params = {}
            if family_id:
                params["family_id"] = family_id
            if status:
                params["status"] = status
            if tag:
                params["tag"] = tag
                
            response = requests.get(f"{self.kb_endpoint}/index", params=params, timeout=self.timeout)
            response.raise_for_status()
            data = response.json()
            
            docs = [
                KBDoc(
                    doc_id=doc["doc_id"], title=doc["title"], family_id=doc["family_id"],
                    family_name=doc["family_name"], status=doc["status"], version=doc["version"],
                    tags=doc["tags"], word_count=doc["word_count"], section_count=doc.get("section_count")
                )
                for doc in data["docs"]
            ]
            
            return KBIndex(total_docs=data["total_docs"], docs=docs, families=data["families"], generated_at=data["generated_at"])
            
        except requests.RequestException as e:
            raise KBClientError(f"Failed to get KB index: {str(e)}")
        except (KeyError, ValueError) as e:
            raise KBClientError(f"Invalid KB index response: {str(e)}")
    
    def get_doc(self, doc_id: str) -> KBDocSnapshot:
        """Get full document with all sections."""
        try:
            response = requests.get(f"{self.kb_endpoint}/{doc_id}", timeout=self.timeout)
            response.raise_for_status()
            data = response.json()
            
            return KBDocSnapshot(
                doc_id=data["doc_id"], title=data["title"], family_id=data["family_id"],
                family_name=data["family_name"], word_count=data["word_count"], sections=data["sections"]
            )
            
        except requests.RequestException as e:
            if hasattr(e, 'response') and hasattr(e.response, 'status_code') and e.response.status_code == 404:
                raise KBClientError(f"Document not found: {doc_id}")
            raise KBClientError(f"Failed to get document: {str(e)}")
        except (KeyError, ValueError) as e:
            raise KBClientError(f"Invalid document response: {str(e)}")
    
    def get_bundle(self, docs: List[Dict[str, Any]], max_total_words: Optional[int] = None) -> KBBundle:
        """Create a custom bundle of documents with optional word limit."""
        try:
            payload = {"docs": docs}
            if max_total_words is not None:
                payload["max_total_words"] = max_total_words
                
            response = requests.post(f"{self.kb_endpoint}/bundle", json=payload, timeout=self.timeout)
            response.raise_for_status()
            data = response.json()
            
            bundle_docs = [
                KBBundleDoc(
                    doc_id=doc["doc_id"], title=doc["title"], family_id=doc["family_id"],
                    family_name=doc["family_name"], sections=doc["sections"], word_count=doc["word_count"]
                )
                for doc in data["docs"]
            ]
            
            return KBBundle(docs=bundle_docs, total_words=data["total_words"], truncated=data["truncated"])
            
        except requests.RequestException as e:
            raise KBClientError(f"Failed to create bundle: {str(e)}")
        except (KeyError, ValueError) as e:
            raise KBClientError(f"Invalid bundle response: {str(e)}")


_kb_client = None

def get_kb_client() -> VitanaKBClient:
    """Get singleton KB client instance"""
    global _kb_client
    if _kb_client is None:
        _kb_client = VitanaKBClient()
    return _kb_client
