import { describe, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('OASIS Event Emission Contract', () => {
  it('enforces that state-mutating routes emit an OASIS event', () => {
    const routesDir = path.join(__dirname, '../src/routes');
    if (!fs.existsSync(routesDir)) {
      console.warn('Routes directory not found, skipping');
      return;
    }

    const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.ts') && !f.includes('.test.ts'));

    for (const file of files) {
      const content = fs.readFileSync(path.join(routesDir, file), 'utf-8');

      // Match things like router.post('/path', ...), router.put(...)
      const mutatingRouteRegex = /router\.(post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g;
      let match;

      while ((match = mutatingRouteRegex.exec(content)) !== null) {
        const method = match[1];
        const routePath = match[2];

        // Extract body of this specific route definition.
        // We look from the current match up to the next router method call or end of file.
        const startIndex = match.index;
        const nextRouteMatch = content.slice(startIndex + 1).match(/router\.(get|post|put|patch|delete|use|all)\s*\(/);
        const endIndex = nextRouteMatch ? startIndex + 1 + nextRouteMatch.index! : content.length;
        const routeBody = content.slice(startIndex, endIndex);

        // Check for known emission signatures inside the route logic
        const hasEmission = routeBody.includes('emitOasisEvent') ||
                            routeBody.includes('emitApprovalDecision') ||
                            routeBody.includes('emitEvent');

        if (!hasEmission) {
          throw new Error(`Contract Violation: Route ${method.toUpperCase()} '${routePath}' in ${file} mutates state but does not emit an OASIS event. Please add a call to emitOasisEvent.`);
        }
      }
    }
  });
});