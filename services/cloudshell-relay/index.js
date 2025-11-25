const http = require('http');
const { exec } = require('child_process');
const crypto = require('crypto');
const url = require('url');

// API key for authentication - set via environment variable
const API_KEY = process.env.RELAY_API_KEY || crypto.randomBytes(32).toString('hex');
const PORT = process.env.PORT || 8080;
const ALLOWED_COMMANDS = process.env.ALLOWED_COMMANDS?.split(',') || ['gcloud', 'docker', 'git', 'ls', 'cat', 'pwd', 'echo', 'npm', 'node'];

// Log API key on startup (only visible in Cloud Run logs)
if (!process.env.RELAY_API_KEY) {
  console.log(`Generated API Key: ${API_KEY}`);
  console.log('Set RELAY_API_KEY environment variable to use a fixed key');
}

function isCommandAllowed(cmd) {
  const firstWord = cmd.trim().split(/\s+/)[0];
  return ALLOWED_COMMANDS.some(allowed => firstWord === allowed || firstWord.endsWith('/' + allowed));
}

function executeCommand(cmd, workingDir = '/workspace') {
  return new Promise((resolve) => {
    const options = {
      cwd: workingDir,
      timeout: 300000, // 5 minutes
      maxBuffer: 10 * 1024 * 1024, // 10MB
      shell: '/bin/bash'
    };

    exec(cmd, options, (error, stdout, stderr) => {
      resolve({
        success: !error,
        exitCode: error?.code || 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error?.message || null
      });
    });
  });
}

async function handleExec(providedKey, command, workingDir, res) {
  // Check API key
  if (providedKey !== API_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid API key' }));
    return;
  }

  if (!command) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Command is required' }));
    return;
  }

  // Security check
  if (!isCommandAllowed(command)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Command not allowed',
      allowed: ALLOWED_COMMANDS
    }));
    return;
  }

  console.log(`Executing: ${command}`);
  const result = await executeCommand(command, workingDir || '/workspace');

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (pathname === '/health' || pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', service: 'cloudshell-relay' }));
    return;
  }

  // Command execution endpoint - GET method (for WebFetch compatibility)
  if (req.method === 'GET' && pathname === '/exec') {
    const providedKey = query.key;
    const command = query.cmd;
    const workingDir = query.cwd;
    await handleExec(providedKey, command, workingDir, res);
    return;
  }

  // Command execution endpoint - POST method
  if (req.method === 'POST' && pathname === '/exec') {
    const providedKey = req.headers['x-api-key'] || query.key;

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { command, workingDir } = JSON.parse(body);
        await handleExec(providedKey, command, workingDir, res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`CloudShell Relay running on port ${PORT}`);
  console.log(`Allowed commands: ${ALLOWED_COMMANDS.join(', ')}`);
});
