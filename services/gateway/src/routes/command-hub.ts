/**
 * Command Hub Route Handler
 * Serves the Command Hub Tasks UI and provides backend APIs
 *
 * Access Control: Requires developer, admin, or exafy_admin role.
 * Community/patient/professional users are blocked with 403.
 */
import { Router, Request, Response } from 'express';
import path from 'path';
import { naturalLanguageService } from '../services/natural-language-service';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { createUserSupabaseClient } from '../lib/supabase-user';

const router = Router();

/** Allowed roles for Command Hub access */
const COMMAND_HUB_ROLES = ['developer', 'admin', 'infra', 'staff'];

/**
 * Middleware: require developer/admin role for Command Hub.
 * Must be used AFTER requireAuth.
 */
async function requireDeveloperAccess(
  req: AuthenticatedRequest,
  res: Response,
  next: Function
): Promise<void> {
  // exafy_admin always has access
  if (req.identity?.exafy_admin) {
    return next();
  }

  // Look up active_role from database via me_context RPC
  try {
    const token = req.headers.authorization?.slice(7);
    if (!token) {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      return;
    }
    const userClient = createUserSupabaseClient(token);
    const { data: meData } = await userClient.rpc('me_context');
    const activeRole = meData?.active_role || null;

    if (activeRole && COMMAND_HUB_ROLES.includes(activeRole)) {
      return next();
    }

    console.warn(`[Command Hub] Access denied for role="${activeRole}" user="${req.identity?.email}"`);
    res.status(403).json({
      ok: false,
      error: 'FORBIDDEN',
      message: 'Command Hub requires developer or admin access',
    });
  } catch (err: any) {
    console.error('[Command Hub] Role check error:', err.message);
    res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
}

/**
 * Serve Command Hub UI
 * GET /command-hub
 */
router.get('/', (req: Request, res: Response) => {
  try {
    // CSP compliant - no inline scripts or styles
    // VTID-01230-FIX: img-src allows Supabase storage (avatar_url) and data: URIs.
    // Without this, avatar background-image was blocked by default-src 'self'.
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseDomain = supabaseUrl ? new URL(supabaseUrl).origin : '';
    res.setHeader('Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' ${supabaseDomain} data: blob:; media-src 'self' data:`);
    const htmlPath = path.join(__dirname, '../frontend/command-hub/index.html');
    res.sendFile(htmlPath);
  } catch (error) {
    console.error('[Command Hub] Error serving UI:', error);
    res.status(500).json({
      error: 'Failed to load Command Hub UI',
      timestamp: new Date().toISOString()
    });
  }
});

router.post('/api/chat', requireAuth, requireDeveloperAccess, async (req: Request, res: Response) => {
  const message = req.body?.message || '';
  
  if (!message.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }
  
  if (message.startsWith('/')) {
    const cmd = message.toLowerCase();
    
    if (cmd === '/help') {
      return res.json({ 
        response: 'Available commands:\n/status - System status\n/services - Service health\n/vtids - Active VTIDs\n/help - This message\n\nOr ask naturally - powered by Gemini AI!' 
      });
    }
    
    if (cmd === '/status') {
      return res.json({ 
        response: `System Status:\n✅ Gateway: Online\n✅ AI: Gemini Enabled\n⏰ Time: ${new Date().toISOString()}` 
      });
    }
    
    if (cmd === '/services') {
      try {
        const response = await fetch('https://oasis-operator-86804897789.us-central1.run.app/health/services');
        if (response.ok) {
          const data: any = await response.json();
          const serviceList = (data.services || [])
            .map((s: any) => `${s.status === 'healthy' ? '✅' : '❌'} ${s.name}: ${s.status}`)
            .join('\n');
          return res.json({ response: `Services:\n${serviceList || 'No services found'}` });
        }
      } catch (err) {
        console.error('[Command Hub] Service health check failed:', err);
      }
      return res.json({ response: 'Service health check unavailable' });
    }
    
    if (cmd === '/vtids') {
      return res.json({ 
        response: 'Active VTIDs:\n✅ DEV-COMMU-CMDTASKS-UI (Command Hub Tasks Integration)\n✅ DEV-COMMU-0042 (Command Hub Core)' 
      });
    }
    
    return res.json({ response: `Unknown command: ${message}\nType /help for available commands` });
  }
  
  try {
    const response = await naturalLanguageService.processMessage(message);
    res.json({ response });
  } catch (error) {
    console.error('[Command Hub] Chat error:', error);
    res.status(500).json({ 
      response: 'Sorry, I encountered an error processing your message. Please try again.' 
    });
  }
});

router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'command-hub',
    version: '2.0.0',
    features: {
      ui: 'tasks-enabled',
      ai: 'gemini-enabled',
      liveConsole: true,
      tasksPanel: true,
      modules: 17,
      screens: 87
    },
    timestamp: new Date().toISOString()
  });
});

/**
 * SPA Catch-all Route for Deep Linking
 * Serves index.html for all /command-hub/* routes (except static files and API)
 * This enables client-side routing for the 87-screen navigation
 */
router.get('/*', (req: Request, res: Response, next: Function) => {
  // Skip static files - let express.static handle them
  const staticExts = ['.js', '.css', '.html', '.png', '.jpg', '.svg', '.ico', '.json'];
  if (staticExts.some(ext => req.path.endsWith(ext))) {
    return next();
  }

  // Skip API routes
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }

  try {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' data:");
    const htmlPath = path.join(__dirname, '../frontend/command-hub/index.html');
    res.sendFile(htmlPath);
  } catch (error) {
    console.error('[Command Hub] Error serving SPA:', error);
    res.status(500).json({
      error: 'Failed to load Command Hub UI',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
