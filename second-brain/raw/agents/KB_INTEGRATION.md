# Vitana KB Skills Integration

## Overview
This implementation adds three knowledge base access skills to the Vitana AI crew system, enabling agents to query and retrieve documentation autonomously.

**VTID:** DEV-AICOR-0025  
**Branch:** `feature/DEV-AICOR-0025-kb-skills`

## Skills Added

### 1. vitana.kb.get_index
**Purpose:** Browse available documentation categories and files  
**Location:** `crew_template/skills/vitana.kb.get_index.yaml`

**Usage:**
```yaml
- name: vitana.kb.get_index
  input:
    query: "deployment"  # Optional: filter by keyword
```

**Returns:** List of categories and documents matching the query

### 2. vitana.kb.get_doc
**Purpose:** Retrieve a specific document by name  
**Location:** `crew_template/skills/vitana.kb.get_doc.yaml`

**Usage:**
```yaml
- name: vitana.kb.get_doc
  input:
    doc_name: "07-GCP-DEPLOYMENT.md"
```

**Returns:** Full document contents

### 3. vitana.kb.get_bundle
**Purpose:** Retrieve multiple related documents at once  
**Location:** `crew_template/skills/vitana.kb.get_bundle.yaml`

**Usage:**
```yaml
- name: vitana.kb.get_bundle
  input:
    bundle_name: "cicd_docs"
```

**Returns:** Combined contents of all documents in the bundle

## Skill Registration

Skills are registered in `crew_template/crew.yaml`:

```yaml
skills:
  - name: vitana.kb.get_index
    file: skills/vitana.kb.get_index.yaml
    agents: [planner]
    
  - name: vitana.kb.get_doc
    file: skills/vitana.kb.get_doc.yaml
    agents: [planner, worker]
    
  - name: vitana.kb.get_bundle
    file: skills/vitana.kb.get_bundle.yaml
    agents: [worker]
```

## Environment Configuration

Add to your `.env` files:

```bash
# Knowledge Base Configuration
KB_BASE_PATH=/mnt/project
KB_CACHE_TTL=3600
KB_MAX_DOC_SIZE=1048576  # 1MB
```

## Integration Examples

### Planner Agent Integration

```typescript
// services/agents/planner-core/src/skills/kb-integration.ts

import { Skill } from '@vitana/crew-types';

export class KBSkillIntegration {
  
  async executeGetIndex(query?: string): Promise<KBIndex> {
    const result = await this.crewExecutor.executeSkill('vitana.kb.get_index', {
      query
    });
    return result.data;
  }
  
  async executeGetDoc(docName: string): Promise<string> {
    const result = await this.crewExecutor.executeSkill('vitana.kb.get_doc', {
      doc_name: docName
    });
    return result.data.content;
  }
  
  // Use in planning phase
  async enrichPlanWithContext(task: Task): Promise<EnrichedPlan> {
    // 1. Search KB for relevant docs
    const index = await this.executeGetIndex(task.keywords.join(' '));
    
    // 2. Identify relevant documents
    const relevantDocs = index.documents.filter(doc => 
      doc.relevance_score > 0.7
    );
    
    // 3. Fetch top 3 documents
    const context = await Promise.all(
      relevantDocs.slice(0, 3).map(doc => 
        this.executeGetDoc(doc.name)
      )
    );
    
    // 4. Include in plan
    return {
      ...task.plan,
      contextual_knowledge: context,
      referenced_docs: relevantDocs.map(d => d.name)
    };
  }
}
```

### Worker Agent Integration

```typescript
// services/agents/worker-core/src/skills/kb-integration.ts

export class WorkerKBIntegration {
  
  async executeGetBundle(bundleName: string): Promise<DocumentBundle> {
    const result = await this.crewExecutor.executeSkill('vitana.kb.get_bundle', {
      bundle_name: bundleName
    });
    return result.data;
  }
  
  // Use during task execution
  async executeWithContext(task: WorkItem): Promise<ExecutionResult> {
    // Determine required knowledge bundle
    const bundle = this.determineBundleForTask(task);
    
    if (bundle) {
      // Load relevant documentation
      const docs = await this.executeGetBundle(bundle);
      
      // Inject into execution context
      task.context = {
        ...task.context,
        kb_docs: docs.documents,
        kb_bundle: bundle
      };
    }
    
    return this.execute(task);
  }
  
  private determineBundleForTask(task: WorkItem): string | null {
    if (task.tags.includes('deployment')) return 'deployment_docs';
    if (task.tags.includes('cicd')) return 'cicd_docs';
    if (task.vtid.startsWith('DEV-API')) return 'api_docs';
    return null;
  }
}
```

## Skill Implementation

Each skill needs a corresponding implementation in the skill executor:

```typescript
// packages/crew-executor/src/skills/kb-skills.ts

export class KBSkills {
  
  private kbBasePath = process.env.KB_BASE_PATH || '/mnt/project';
  
  async getIndex(input: { query?: string }): Promise<KBIndexResult> {
    const files = await fs.readdir(this.kbBasePath);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    
    let results = mdFiles.map(file => ({
      name: file,
      category: this.categorizeDoc(file),
      size: fs.statSync(path.join(this.kbBasePath, file)).size
    }));
    
    // Apply query filter if provided
    if (input.query) {
      results = results.filter(doc =>
        doc.name.toLowerCase().includes(input.query!.toLowerCase())
      );
    }
    
    return {
      total: results.length,
      documents: results,
      categories: [...new Set(results.map(r => r.category))]
    };
  }
  
  async getDoc(input: { doc_name: string }): Promise<KBDocResult> {
    const filePath = path.join(this.kbBasePath, input.doc_name);
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`Document not found: ${input.doc_name}`);
    }
    
    const content = await fs.readFile(filePath, 'utf-8');
    const stats = fs.statSync(filePath);
    
    return {
      name: input.doc_name,
      content,
      size: stats.size,
      last_modified: stats.mtime.toISOString()
    };
  }
  
  async getBundle(input: { bundle_name: string }): Promise<KBBundleResult> {
    const bundles = {
      cicd_docs: [
        '05-CI-CD-PATTERNS.md',
        '06-GITHUB-WORKFLOW.md',
        '07-GCP-DEPLOYMENT.md'
      ],
      deployment_docs: [
        '07-GCP-DEPLOYMENT.md',
        '04-SERVICES-ARCHITECTURE.md'
      ],
      api_docs: [
        '04-SERVICES-ARCHITECTURE.md',
        '03-OASIS-SCHEMA.md'
      ]
    };
    
    const docNames = bundles[input.bundle_name];
    if (!docNames) {
      throw new Error(`Bundle not found: ${input.bundle_name}`);
    }
    
    const documents = await Promise.all(
      docNames.map(name => this.getDoc({ doc_name: name }))
    );
    
    return {
      bundle_name: input.bundle_name,
      document_count: documents.length,
      documents
    };
  }
  
  private categorizeDoc(filename: string): string {
    if (filename.includes('CICD') || filename.includes('GITHUB') || filename.includes('GCP')) {
      return 'deployment';
    }
    if (filename.includes('VTID') || filename.includes('OASIS')) {
      return 'tracking';
    }
    if (filename.includes('ARCHITECTURE') || filename.includes('SERVICES')) {
      return 'architecture';
    }
    return 'general';
  }
}
```

## Testing

### Unit Tests

```typescript
// __tests__/kb-skills.test.ts

describe('KB Skills', () => {
  
  test('get_index returns all documents', async () => {
    const kb = new KBSkills();
    const result = await kb.getIndex({});
    
    expect(result.total).toBeGreaterThan(0);
    expect(result.documents).toBeDefined();
    expect(result.categories).toBeDefined();
  });
  
  test('get_index filters by query', async () => {
    const kb = new KBSkills();
    const result = await kb.getIndex({ query: 'deployment' });
    
    expect(result.documents.every(doc => 
      doc.name.toLowerCase().includes('deployment')
    )).toBe(true);
  });
  
  test('get_doc retrieves specific document', async () => {
    const kb = new KBSkills();
    const result = await kb.getDoc({ 
      doc_name: '07-GCP-DEPLOYMENT.md' 
    });
    
    expect(result.content).toBeDefined();
    expect(result.name).toBe('07-GCP-DEPLOYMENT.md');
  });
  
  test('get_bundle retrieves multiple documents', async () => {
    const kb = new KBSkills();
    const result = await kb.getBundle({ 
      bundle_name: 'cicd_docs' 
    });
    
    expect(result.document_count).toBe(3);
    expect(result.documents).toHaveLength(3);
  });
});
```

### Integration Tests

```typescript
// __tests__/integration/planner-kb.test.ts

describe('Planner KB Integration', () => {
  
  test('planner enriches plan with KB context', async () => {
    const planner = new PlannerCore();
    
    const task = {
      description: 'Deploy gateway service to production',
      keywords: ['deployment', 'production', 'gateway']
    };
    
    const enrichedPlan = await planner.enrichPlanWithContext(task);
    
    expect(enrichedPlan.contextual_knowledge).toBeDefined();
    expect(enrichedPlan.referenced_docs).toContain('07-GCP-DEPLOYMENT.md');
  });
});
```

## Demo Task

To verify the implementation works:

```bash
# Start the crew system
npm run dev

# Submit a test task
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "vtid": "TEST-KB-0001",
    "description": "Explain the deployment process for the gateway service",
    "type": "query"
  }'

# Expected behavior:
# 1. Planner uses get_index to find deployment docs
# 2. Planner uses get_doc to retrieve 07-GCP-DEPLOYMENT.md
# 3. Planner creates execution plan referencing deployment steps
# 4. Worker uses get_bundle to load cicd_docs bundle
# 5. Worker generates comprehensive deployment explanation
```

## Rollout Plan

### Phase 1: Dev Environment (Current)
- ✅ Skills defined and registered
- ⏳ Implement skill executors
- ⏳ Add integration to Planner/Worker
- ⏳ Unit tests
- ⏳ Integration tests

### Phase 2: Testing
- Run demo task
- Verify correct document retrieval
- Verify performance (response time <500ms)
- Test error handling

### Phase 3: Production
- Merge to main
- Deploy to staging
- Monitor for 24 hours
- Deploy to production

## Performance Considerations

- **Caching:** Implement 1-hour cache for KB index
- **Lazy Loading:** Only load documents when needed
- **Bundle Optimization:** Pre-define common bundles
- **Size Limits:** Max 1MB per document retrieval

## Security

- KB files are read-only
- No user-supplied file paths (prevent directory traversal)
- All file access goes through skill abstraction
- Audit log all KB access in OASIS

## Monitoring

Add OASIS events for KB usage:

```typescript
await oasis.emitEvent({
  event_type: 'kb.skill_executed',
  metadata: {
    skill_name: 'vitana.kb.get_doc',
    doc_name: '07-GCP-DEPLOYMENT.md',
    agent: 'planner',
    execution_time_ms: 45
  }
});
```

## Troubleshooting

**Issue:** Skill execution fails with "Document not found"
- Verify KB_BASE_PATH is correctly set
- Check document name matches exactly (case-sensitive)
- Ensure /mnt/project is mounted

**Issue:** Slow skill execution
- Check KB_CACHE_TTL setting
- Verify documents aren't too large
- Consider implementing pagination for get_index

## Next Steps

1. Implement skill executors in `packages/crew-executor`
2. Add KB integration to Planner-Core
3. Add KB integration to Worker-Core
4. Write tests
5. Run demo task
6. Create PR for review

## References

- VTID: DEV-AICOR-0025
- Branch: feature/DEV-AICOR-0025-kb-skills
- Related Docs: 01-PROJECT-OVERVIEW.md, 04-SERVICES-ARCHITECTURE.md
