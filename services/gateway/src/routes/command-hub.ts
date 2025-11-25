/**
 * Command Hub Route Handler
 * Serves the Command Hub Tasks UI and provides backend APIs
 */
import express, { Router, Request, Response } from 'express';
import path from 'path';
import { naturalLanguageService } from '../services/natural-language-service';

const router = Router();

// Serve static files (CSS, JS)
router.use(express.static(path.join(__dirname, '../frontend/command-hub')));

/**
 * Serve Command Hub UI
 * GET /command-hub
 */
router.get('/', (req: Request, res: Response) => {
  try {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
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

router.post('/api/chat', async (req: Request, res: Response) => {
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
    const result = await naturalLanguageService.processOperatorMessage(message);
    res.json({ response: result.reply });
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
      tasksPanel: true
    },
    timestamp: new Date().toISOString()
  });
});

export default router;
