/**
 * Playwright MCP Connector - VTID-01200
 *
 * Browser automation connector for visual testing and user journey validation.
 * Integrates with Microsoft's Playwright MCP Server.
 *
 * Features:
 * - Navigate pages and capture screenshots
 * - Execute user journeys (login, navigation, interactions)
 * - Validate accessibility tree (WCAG compliance)
 * - Test user flows end-to-end
 * - Visual regression testing
 */

import { chromium, Browser, Page, BrowserContext } from '@playwright/test';

interface NavigateParams {
  url: string;
  waitUntil?: 'load' | 'networkidle' | 'domcontentloaded';
  timeout?: number;
}

interface ScreenshotParams {
  url?: string;
  selector?: string;
  fullPage?: boolean;
  path?: string;
}

interface UserJourneyParams {
  name: string;
  steps: JourneyStep[];
  baseUrl: string;
  screenshots?: boolean;
}

interface JourneyStep {
  action: 'navigate' | 'click' | 'type' | 'wait' | 'assert' | 'screenshot';
  selector?: string;
  url?: string;
  text?: string;
  expected?: string;
  timeout?: number;
}

interface AccessibilityCheckParams {
  url: string;
  rules?: string[];
  include?: string[];
  exclude?: string[];
}

interface PlaywrightMcpConfig {
  headless: boolean;
  viewport: { width: number; height: number };
  timeout: number;
}

class PlaywrightMcpConnector {
  private config: PlaywrightMcpConfig;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor() {
    this.config = {
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
      viewport: {
        width: parseInt(process.env.PLAYWRIGHT_VIEWPORT_WIDTH || '1280', 10),
        height: parseInt(process.env.PLAYWRIGHT_VIEWPORT_HEIGHT || '720', 10),
      },
      timeout: parseInt(process.env.PLAYWRIGHT_TIMEOUT || '30000', 10),
    };
  }

  async health() {
    try {
      // Test browser launch
      const testBrowser = await chromium.launch({ headless: true });
      await testBrowser.close();
      return { status: 'ok', message: 'Playwright browser available' };
    } catch (error: any) {
      return { status: 'error', message: error.message };
    }
  }

  async call(method: string, params: any) {
    switch (method) {
      case 'browser.navigate':
        return this.navigate(params);
      case 'browser.screenshot':
        return this.screenshot(params);
      case 'browser.accessibility':
        return this.checkAccessibility(params);
      case 'journey.execute':
        return this.executeJourney(params);
      case 'journey.validate':
        return this.validateJourney(params);
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /**
   * Initialize browser and context
   */
  private async initBrowser(): Promise<void> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.config.headless,
      });
    }

    if (!this.context) {
      this.context = await this.browser.newContext({
        viewport: this.config.viewport,
        permissions: ['clipboard-read', 'clipboard-write'],
      });
    }
  }

  /**
   * Navigate to a URL
   */
  private async navigate(params: NavigateParams): Promise<{ ok: boolean; url: string; title: string }> {
    await this.initBrowser();
    const page = await this.context!.newPage();

    try {
      await page.goto(params.url, {
        waitUntil: params.waitUntil || 'networkidle',
        timeout: params.timeout || this.config.timeout,
      });

      const title = await page.title();

      return {
        ok: true,
        url: page.url(),
        title,
      };
    } finally {
      await page.close();
    }
  }

  /**
   * Capture screenshot
   */
  private async screenshot(params: ScreenshotParams): Promise<{ ok: boolean; screenshot?: string; path?: string }> {
    await this.initBrowser();
    const page = await this.context!.newPage();

    try {
      if (params.url) {
        await page.goto(params.url, { waitUntil: 'networkidle' });
      }

      const screenshotOptions: any = {
        fullPage: params.fullPage !== false,
      };

      if (params.path) {
        screenshotOptions.path = params.path;
      } else {
        screenshotOptions.type = 'png';
      }

      let screenshot: Buffer | void;

      if (params.selector) {
        const element = await page.locator(params.selector).first();
        screenshot = await element.screenshot(screenshotOptions);
      } else {
        screenshot = await page.screenshot(screenshotOptions);
      }

      return {
        ok: true,
        screenshot: screenshot ? screenshot.toString('base64') : undefined,
        path: params.path,
      };
    } finally {
      await page.close();
    }
  }

  /**
   * Run accessibility checks using Playwright's accessibility tree
   */
  private async checkAccessibility(params: AccessibilityCheckParams): Promise<{
    ok: boolean;
    violations: Array<{ id: string; impact: string; description: string; nodes: string[] }>;
    passes: number;
  }> {
    await this.initBrowser();
    const page = await this.context!.newPage();

    try {
      await page.goto(params.url, { waitUntil: 'networkidle' });

      // Get accessibility tree snapshot
      const snapshot = await page.accessibility.snapshot();

      // Basic accessibility validation
      // In production, integrate with axe-core or similar
      const violations: Array<{ id: string; impact: string; description: string; nodes: string[] }> = [];

      // Check for common issues
      const missingAltImages = await page.locator('img:not([alt])').count();
      if (missingAltImages > 0) {
        violations.push({
          id: 'image-alt',
          impact: 'critical',
          description: `Found ${missingAltImages} images without alt text`,
          nodes: ['img:not([alt])'],
        });
      }

      const missingLabels = await page.locator('input:not([aria-label]):not([id]):not([name])').count();
      if (missingLabels > 0) {
        violations.push({
          id: 'label-missing',
          impact: 'serious',
          description: `Found ${missingLabels} form inputs without labels`,
          nodes: ['input:not([aria-label]):not([id]):not([name])'],
        });
      }

      return {
        ok: true,
        violations,
        passes: snapshot ? 1 : 0,
      };
    } finally {
      await page.close();
    }
  }

  /**
   * Execute a user journey
   */
  private async executeJourney(params: UserJourneyParams): Promise<{
    ok: boolean;
    steps: Array<{ step: number; action: string; ok: boolean; error?: string; screenshot?: string }>;
    duration_ms: number;
  }> {
    await this.initBrowser();
    const page = await this.context!.newPage();

    const startTime = Date.now();
    const results: Array<{ step: number; action: string; ok: boolean; error?: string; screenshot?: string }> = [];

    try {
      for (let i = 0; i < params.steps.length; i++) {
        const step = params.steps[i];
        const stepNum = i + 1;

        try {
          await this.executeJourneyStep(page, step, params.baseUrl);

          // Capture screenshot if requested
          let screenshot: string | undefined;
          if (params.screenshots) {
            const buffer = await page.screenshot({ type: 'png' });
            screenshot = buffer.toString('base64');
          }

          results.push({
            step: stepNum,
            action: `${step.action} ${step.selector || step.url || ''}`.trim(),
            ok: true,
            screenshot,
          });
        } catch (error: any) {
          results.push({
            step: stepNum,
            action: `${step.action} ${step.selector || step.url || ''}`.trim(),
            ok: false,
            error: error.message,
          });

          // Fail fast on journey errors
          break;
        }
      }

      const duration = Date.now() - startTime;
      const allOk = results.every((r) => r.ok);

      return {
        ok: allOk,
        steps: results,
        duration_ms: duration,
      };
    } finally {
      await page.close();
    }
  }

  /**
   * Execute a single journey step
   */
  private async executeJourneyStep(page: Page, step: JourneyStep, baseUrl: string): Promise<void> {
    switch (step.action) {
      case 'navigate':
        const url = step.url?.startsWith('http') ? step.url : `${baseUrl}${step.url}`;
        await page.goto(url, { waitUntil: 'networkidle', timeout: step.timeout || this.config.timeout });
        break;

      case 'click':
        if (!step.selector) throw new Error('selector required for click action');
        await page.click(step.selector, { timeout: step.timeout || this.config.timeout });
        break;

      case 'type':
        if (!step.selector || !step.text) throw new Error('selector and text required for type action');
        await page.fill(step.selector, step.text, { timeout: step.timeout || this.config.timeout });
        break;

      case 'wait':
        if (step.selector) {
          await page.waitForSelector(step.selector, { timeout: step.timeout || this.config.timeout });
        } else {
          await page.waitForTimeout(step.timeout || 1000);
        }
        break;

      case 'assert':
        if (!step.selector || !step.expected) throw new Error('selector and expected required for assert action');
        const element = page.locator(step.selector).first();
        const text = await element.textContent({ timeout: step.timeout || this.config.timeout });
        if (!text?.includes(step.expected)) {
          throw new Error(`Assertion failed: expected "${step.expected}", got "${text}"`);
        }
        break;

      case 'screenshot':
        // Screenshot handled by executeJourney
        break;

      default:
        throw new Error(`Unknown journey action: ${step.action}`);
    }
  }

  /**
   * Validate a user journey (smoke test)
   */
  private async validateJourney(params: UserJourneyParams): Promise<{
    ok: boolean;
    passed: boolean;
    journey: string;
    steps_passed: number;
    steps_failed: number;
    errors: string[];
  }> {
    const result = await this.executeJourney(params);

    const stepsPassed = result.steps.filter((s) => s.ok).length;
    const stepsFailed = result.steps.filter((s) => !s.ok).length;
    const errors = result.steps.filter((s) => !s.ok).map((s) => s.error || 'Unknown error');

    return {
      ok: true,
      passed: result.ok,
      journey: params.name,
      steps_passed: stepsPassed,
      steps_failed: stepsFailed,
      errors,
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const playwrightMcpConnector = new PlaywrightMcpConnector();
