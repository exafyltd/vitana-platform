import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('OASIS Emission Contract', () => {
  it('requires state-mutating routes to emit an OASIS event', () => {
    const routesDir = path.resolve(__dirname, '../src/routes');
    if (!fs.existsSync(routesDir)) return;
    
    const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    
    for (const file of files) {
      const content = fs.readFileSync(path.join(routesDir, file), 'utf-8');
      
      // Look for standard Express mutator methods
      const hasMutatingRoutes = /router\.(post|put|patch|delete)\(/.test(content);
      
      if (hasMutatingRoutes) {
        // Enforce the presence of OASIS event emission calls or standard wrappers
        const hasEmission = /emitOasisEvent|emitEvent|emitApprovalDecision/.test(content);
        
        expect(
          hasEmission, 
          `Contract Violation: Route file '${file}' contains state-mutating endpoints (POST/PUT/PATCH/DELETE) but does not emit an OASIS event. Import and use 'emitOasisEvent' from 'services/oasis-event-service'.`
        ).toBe(true);
      }
    }
  });
});