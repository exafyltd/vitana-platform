import { Router, Request, Response } from 'express';

/**
 * VTID-01223: Interactive Visual Testing Endpoint
 *
 * Allows on-demand visual testing of frontend pages.
 * Claude can call this endpoint during conversation to:
 * - Navigate to pages
 * - Take screenshots
 * - Check accessibility
 * - Execute custom actions
 * - Report findings
 */

const router = Router();

// Configuration
const CONFIG = {
  mcpGatewayUrl: process.env.MCP_GATEWAY_URL || 'http://mcp-gateway:8080',
  frontendUrl: process.env.FRONTEND_URL || 'https://temp-vitana-v1.lovable.app',
  defaultViewport: { width: 1280, height: 720 },
};

interface InteractiveTestRequest {
  url?: string;                    // Full URL or relative path
  actions?: TestAction[];          // Optional actions to perform
  screenshot?: boolean;            // Capture screenshot (default: true)
  checkAccessibility?: boolean;    // Run accessibility checks (default: false)
  viewport?: { width: number; height: number };
}

interface TestAction {
  type: 'click' | 'type' | 'wait' | 'scroll' | 'hover';
  selector?: string;               // CSS selector for element
  text?: string;                   // Text to type
  ms?: number;                     // Milliseconds to wait
  x?: number;                      // Scroll/hover coordinates
  y?: number;
}

interface InteractiveTestResponse {
  ok: boolean;
  url: string;
  screenshot?: {
    data: string;                  // Base64 encoded image
    format: string;                // 'png'
  };
  accessibility?: {
    violations: number;
    passes: number;
    issues: any[];
  };
  performance?: {
    loadTime: number;
    domContentLoaded: number;
  };
  console?: {
    errors: string[];
    warnings: string[];
  };
  actions_performed?: string[];
  error?: string;
  duration_ms: number;
}

/**
 * Call Playwright MCP via MCP Gateway
 */
async function callPlaywrightMcp(method: string, params: any): Promise<any> {
  const response = await fetch(`${CONFIG.mcpGatewayUrl}/mcp/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      server: 'playwright',
      method: method,
      params: params,
    }),
  });

  const result = await response.json() as { ok: boolean; result?: any; error?: string };
  if (!result.ok) {
    throw new Error(result.error || 'MCP call failed');
  }
  return result.result;
}

/**
 * POST /api/v1/visual/interactive-test
 *
 * Execute an interactive visual test of a frontend page.
 *
 * Body:
 * {
 *   "url": "/messages",              // Optional: relative or absolute URL
 *   "actions": [                      // Optional: actions to perform
 *     { "type": "click", "selector": "#sidebar-messages" },
 *     { "type": "wait", "ms": 1000 },
 *     { "type": "type", "selector": "input", "text": "Hello" }
 *   ],
 *   "screenshot": true,               // Optional: capture screenshot
 *   "checkAccessibility": true,       // Optional: run a11y checks
 *   "viewport": { "width": 1280, "height": 720 }  // Optional
 * }
 *
 * Response:
 * {
 *   "ok": true,
 *   "url": "https://...",
 *   "screenshot": { "data": "base64...", "format": "png" },
 *   "accessibility": { "violations": 0, "passes": 12, "issues": [] },
 *   "performance": { "loadTime": 450, "domContentLoaded": 320 },
 *   "console": { "errors": [], "warnings": [] },
 *   "actions_performed": ["navigated", "clicked #sidebar", "waited 1000ms"],
 *   "duration_ms": 1250
 * }
 */
router.post('/interactive-test', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const {
      url = '/',
      actions = [],
      screenshot = true,
      checkAccessibility = false,
      viewport = CONFIG.defaultViewport,
    } = req.body as InteractiveTestRequest;

    // Resolve URL
    const fullUrl = url.startsWith('http') ? url : `${CONFIG.frontendUrl}${url}`;
    const actionsPerformed: string[] = [];

    // Navigate to page
    console.log(`[Interactive Test] Navigating to: ${fullUrl}`);
    await callPlaywrightMcp('browser.navigate', { url: fullUrl, viewport });
    actionsPerformed.push(`navigated to ${fullUrl}`);

    // Perform actions
    for (const action of actions) {
      console.log(`[Interactive Test] Performing action:`, action);

      switch (action.type) {
        case 'click':
          if (!action.selector) throw new Error('click action requires selector');
          await callPlaywrightMcp('browser.click', { selector: action.selector });
          actionsPerformed.push(`clicked ${action.selector}`);
          break;

        case 'type':
          if (!action.selector || !action.text) throw new Error('type action requires selector and text');
          await callPlaywrightMcp('browser.type', { selector: action.selector, text: action.text });
          actionsPerformed.push(`typed "${action.text}" into ${action.selector}`);
          break;

        case 'wait':
          if (!action.ms) throw new Error('wait action requires ms');
          await new Promise(resolve => setTimeout(resolve, action.ms));
          actionsPerformed.push(`waited ${action.ms}ms`);
          break;

        case 'scroll':
          await callPlaywrightMcp('browser.scroll', { x: action.x || 0, y: action.y || 0 });
          actionsPerformed.push(`scrolled to (${action.x || 0}, ${action.y || 0})`);
          break;

        case 'hover':
          if (!action.selector) throw new Error('hover action requires selector');
          await callPlaywrightMcp('browser.hover', { selector: action.selector });
          actionsPerformed.push(`hovered ${action.selector}`);
          break;

        default:
          throw new Error(`Unknown action type: ${(action as any).type}`);
      }
    }

    // Build response
    const response: InteractiveTestResponse = {
      ok: true,
      url: fullUrl,
      actions_performed: actionsPerformed,
      duration_ms: Date.now() - startTime,
    };

    // Capture screenshot
    if (screenshot) {
      console.log(`[Interactive Test] Capturing screenshot`);
      const screenshotResult = await callPlaywrightMcp('browser.screenshot', {
        fullPage: false,
      });
      response.screenshot = {
        data: screenshotResult.screenshot,
        format: 'png',
      };
    }

    // Check accessibility
    if (checkAccessibility) {
      console.log(`[Interactive Test] Checking accessibility`);
      const a11yResult = await callPlaywrightMcp('browser.checkAccessibility', {});
      response.accessibility = {
        violations: a11yResult.violations || 0,
        passes: a11yResult.passes || 0,
        issues: a11yResult.issues || [],
      };
    }

    console.log(`[Interactive Test] Completed in ${response.duration_ms}ms`);
    res.json(response);

  } catch (error: any) {
    const duration_ms = Date.now() - startTime;
    console.error(`[Interactive Test] Error:`, error);

    res.status(500).json({
      ok: false,
      error: error.message,
      duration_ms,
    });
  }
});

/**
 * GET /api/v1/visual/health
 *
 * Check if visual testing is available
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const mcpHealth = await fetch(`${CONFIG.mcpGatewayUrl}/mcp/health`);
    const mcpData = await mcpHealth.json() as { connectors?: any[] };

    const playwrightConnector = mcpData.connectors?.find((c: any) => c.name === 'playwright');

    res.json({
      status: 'ok',
      visual_testing: {
        available: playwrightConnector?.status === 'ok',
        mcp_gateway: CONFIG.mcpGatewayUrl,
        frontend_url: CONFIG.frontendUrl,
        playwright_status: playwrightConnector?.status || 'unknown',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
