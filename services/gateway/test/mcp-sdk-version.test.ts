import fs from 'fs';
import path from 'path';

describe('MCP SDK Version Verification', () => {
  it('should explicitly use @modelcontextprotocol/sdk version 1.25.2 or higher to prevent ReDoS', () => {
    const pkgPath = path.resolve(__dirname, '../package.json');
    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const mcpVersion: string = pkgJson.dependencies['@modelcontextprotocol/sdk'];

    expect(mcpVersion).toBeDefined();

    // Must not be a 0.x version to prevent regressions
    expect(mcpVersion).not.toMatch(/^[~^]?0\./);

    const cleanVersion = mcpVersion.replace(/^[~^]/, '');
    const [majorStr, minorStr, patchStr] = cleanVersion.split('.');
    
    const major = parseInt(majorStr, 10);
    const minor = parseInt(minorStr, 10);
    const patch = parseInt(patchStr, 10);

    expect(major).toBeGreaterThanOrEqual(1);

    if (major === 1) {
      if (minor === 25) {
        expect(patch).toBeGreaterThanOrEqual(2);
      } else {
        expect(minor).toBeGreaterThan(25);
      }
    }
  });
});