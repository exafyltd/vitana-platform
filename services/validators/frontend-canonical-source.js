const fs = require('fs');
const path = require('path');

function validateFrontendCanonicalSource(repoRoot) {
  const canonical = [
    'services/gateway/src/frontend/command-hub',
    'services/gateway/dist/frontend/command-hub'
  ];

  const forbidden = [
    'services/gateway/src/static/command-hub',
    'services/gateway/public/command-hub',
    'services/gateway/frontend/command-hub',
    'services/gateway/src/frontend/commandHub',
    'services/gateway/src/frontend/command_hub'
  ];

  const errors = [];

  forbidden.forEach(dir => {
    if (fs.existsSync(path.join(repoRoot, dir))) {
      errors.push(`Forbidden directory exists: ${dir}`);
    }
  });

  canonical.forEach(dir => {
    if (!fs.existsSync(path.join(repoRoot, dir))) {
      errors.push(`Canonical directory missing: ${dir}`);
    }
  });

  return {
    ok: errors.length === 0,
    errors
  };
}

// Execute validation when run directly
if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '../..');
  const result = validateFrontendCanonicalSource(repoRoot);

  if (!result.ok) {
    console.error('❌ Frontend canonical source validation failed:');
    result.errors.forEach(err => console.error(`   - ${err}`));
    process.exit(1);
  }

  console.log('✅ Frontend canonical source validation passed');
  process.exit(0);
}

module.exports = { validateFrontendCanonicalSource };
