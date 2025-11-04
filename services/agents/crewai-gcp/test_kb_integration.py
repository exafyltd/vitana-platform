#!/usr/bin/env python3
"""
Demo script to test KB integration with agents
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../shared'))

from vitana_kb_client import get_kb_client, KBClientError
from kb_tools import get_kb_tools

def test_kb_client():
    """Test KB client directly"""
    print("=" * 60)
    print("TEST 1: KB Client - Get Index")
    print("=" * 60)
    
    client = get_kb_client()
    
    try:
        # Test get_index
        index = client.get_index(family_id="foundation")
        print(f"✅ Index loaded: {index.total_docs} docs")
        for doc in index.docs:
            print(f"   - {doc.doc_id}: {doc.title} ({doc.word_count} words)")
        print()
        
        # Test get_doc
        print("=" * 60)
        print("TEST 2: KB Client - Get Document")
        print("=" * 60)
        doc_id = "00-foundation-doc-00-0001_vitana-vision-strategy-ecosystem"
        doc = client.get_doc(doc_id)
        print(f"✅ Document loaded: {doc.title}")
        print(f"   - Word count: {doc.word_count}")
        print(f"   - Sections: {len(doc.sections)}")
        print()
        
        # Test get_bundle
        print("=" * 60)
        print("TEST 3: KB Client - Get Bundle")
        print("=" * 60)
        bundle = client.get_bundle(
            docs=[{"doc_id": doc_id}],
            max_total_words=300
        )
        print(f"✅ Bundle created:")
        print(f"   - Total words: {bundle.total_words}")
        print(f"   - Truncated: {bundle.truncated}")
        print(f"   - Documents: {len(bundle.docs)}")
        print()
        
        return True
        
    except KBClientError as e:
        print(f"❌ Error: {e}")
        return False

def test_kb_tools():
    """Test KB tools (agent interface)"""
    print("=" * 60)
    print("TEST 4: KB Tools - Agent Interface")
    print("=" * 60)
    
    tools = get_kb_tools()
    
    try:
        # Test index
        result = tools.get_index(family_id="foundation", rid="demo-001")
        print(f"✅ KB Tools - Index: {result['total_docs']} docs")
        
        # Test doc
        doc_id = "00-foundation-doc-00-0001_vitana-vision-strategy-ecosystem"
        result = tools.get_doc(doc_id, rid="demo-002")
        print(f"✅ KB Tools - Doc: {result['title']}")
        
        # Test bundle
        result = tools.get_bundle(
            docs=[{"doc_id": doc_id}],
            max_total_words=400,
            rid="demo-003"
        )
        print(f"✅ KB Tools - Bundle: {result['total_words']} words")
        print()
        
        return True
        
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

def demo_kb_powered_task():
    """Simulate a KB-powered agent task"""
    print("=" * 60)
    print("TEST 5: Demo KB-Powered Task Simulation")
    print("=" * 60)
    
    tools = get_kb_tools()
    
    # Scenario: Agent needs to explain Vitana vision
    prompt = "Explain the Vitana vision and ecosystem strategy in 5 bullet points."
    
    # Step 1: Agent fetches relevant KB context
    print("Step 1: Agent fetching KB context...")
    bundle = tools.get_bundle(
        docs=[{"doc_id": "00-foundation-doc-00-0001_vitana-vision-strategy-ecosystem"}],
        max_total_words=500,
        rid="demo-task-001"
    )
    
    if "error" in bundle:
        print(f"❌ Failed to fetch KB context: {bundle['error']}")
        return False
    
    print(f"✅ KB context loaded: {bundle['total_words']} words from {len(bundle['docs'])} doc(s)")
    
    # Step 2: Format context for LLM
    kb_context = "\n=== VITANA KB CONTEXT ===\n"
    for doc in bundle["docs"]:
        kb_context += f"\nDocument: {doc['title']}\n"
        for section in doc["sections"][:3]:  # First 3 sections
            kb_context += f"- {section.get('title', 'Section')}\n"
    
    print(f"\nStep 2: Context formatted for LLM ({len(kb_context)} chars)")
    
    # Step 3: Would call LLM with context + prompt
    enhanced_prompt = f"{kb_context}\n\n=== TASK ===\n{prompt}"
    
    print(f"\nStep 3: Enhanced prompt ready:")
    print(f"  - Original prompt: {len(prompt)} chars")
    print(f"  - KB context: {len(kb_context)} chars")
    print(f"  - Total: {len(enhanced_prompt)} chars")
    
    # Step 4: Log metadata
    print(f"\nStep 4: OASIS metadata:")
    print(f"  - RID: demo-task-001")
    print(f"  - KB docs used: {[doc['doc_id'] for doc in bundle['docs']]}")
    print(f"  - KB words: {bundle['total_words']}")
    print(f"  - KB truncated: {bundle['truncated']}")
    
    print("\n✅ Demo task simulation complete!")
    print("   (In production, this would call LLM and return result)")
    print()
    
    return True

if __name__ == "__main__":
    print("\n" + "=" * 60)
    print("VITANA KB INTEGRATION TEST SUITE")
    print("=" * 60 + "\n")
    
    results = []
    
    # Run tests
    results.append(("KB Client", test_kb_client()))
    results.append(("KB Tools", test_kb_tools()))
    results.append(("Demo Task", demo_kb_powered_task()))
    
    # Summary
    print("=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    for name, passed in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"{status} - {name}")
    
    all_passed = all(result for _, result in results)
    
    if all_passed:
        print("\n🎉 All tests passed! KB integration is working.")
        sys.exit(0)
    else:
        print("\n⚠️ Some tests failed. Check errors above.")
        sys.exit(1)
