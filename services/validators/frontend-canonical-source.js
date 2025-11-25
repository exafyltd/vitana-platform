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

module.exports = { validateFrontendCanonicalSource };
