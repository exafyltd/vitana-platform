import fs from 'fs';
import path from 'path';

describe('MCP SDK Version', () => {
  it('should use @modelcontextprotocol/sdk version 1.25.2 or greater to prevent ReDoS', () => {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    
    const mcpVersion = pkg.dependencies['@modelcontextprotocol/sdk'];
    
    expect(mcpVersion).toBeDefined();
    expect(mcpVersion.startsWith('^0.')).toBe(false);
    expect(mcpVersion.startsWith('~0.')).toBe(false);
    expect(mcpVersion.startsWith('0.')).toBe(false);
    
    // Match version string like "^1.25.2", "~1.25.2", or "1.25.2"
    const match = mcpVersion.match(/^[^\d]*(\d+)\.(\d+)\.(\d+)/);
    expect(match).not.toBeNull();
    
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      const patch = parseInt(match[3], 10);
      
      const isAtLeast1_25_2 = 
        major > 1 || 
        (major === 1 && minor > 25) || 
        (major === 1 && minor === 25 && patch >= 2);
        
      expect(isAtLeast1_25_2).toBe(true);
    }
  });
});