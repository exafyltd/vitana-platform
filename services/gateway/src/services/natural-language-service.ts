import { callViaRouter } from './llm-router'; // VTID-03579: provider from llm_routing_policy, never hardcoded
import fetch from 'node-fetch';
import { GeminiParsedCommand, COMMAND_PARSE_PROMPT } from '../types/operator-command';

// VTID-03579: this module used to REQUIRE a Gemini API key and threw at import
// if it was absent. That was correct while it held its own Gemini client — a
// missing key meant a dead service, and failing loudly beat failing silently.
// It is actively harmful now: the key is deliberately unset platform-wide, and
// a module-load throw on an unused credential would take the whole gateway down
// at import for a dependency this file no longer has. Provider credentials are
// the router's concern; this module has none of its own left to check.
const OASIS_URL = process.env.OASIS_OPERATOR_URL || 'https://oasis-operator-86804897789.us-central1.run.app';

// VTID-03579: the fast/complex split survives, but as a STAGE choice rather
// than two pinned Gemini models. `triage` is the cheap stage, `operator` the
// capable one — which concrete models those resolve to is `llm_routing_policy`'s
// business, so this file no longer has to change when the platform changes
// provider.

export class NaturalLanguageService {
  async processMessage(message: string): Promise<string> {
    try {
      const context = await this.buildContext(message);
      const useComplex = message.length > 300 || /analyze|compare|explain|detail/.test(message.toLowerCase());
      const stage = useComplex ? 'operator' : 'triage';

      const prompt = `You are the Vitana Command Hub AI assistant for the VITANA DevOps platform.

You can answer:
- General knowledge questions (geography, science, history, etc.)
- Vitana platform questions using the context below
- DevOps and technical questions
- Health and longevity topics

CONTEXT:
${context}

USER QUESTION: ${message}

Provide a helpful, concise answer:`;

      const r = await callViaRouter(stage, prompt, {
        service: 'natural-language-service',
      });
      if (!r.ok || !r.text) {
        throw new Error(r.error ?? 'empty response');
      }
      return r.text;
    } catch (error: any) {
      console.error('[natural-language-service] Gemini error:', error);

      // Check for authentication/permission errors
      if (error.message && (error.message.includes('403') || error.message.includes('401') || error.message.includes('API key') || error.message.includes('Forbidden'))) {
        return 'AI service temporarily unavailable (API key issue). Please contact the administrator to update the Gemini API key.';
      }

      // Rate limit errors
      if (error.message && (error.message.includes('429') || error.message.includes('quota'))) {
        return 'AI service rate limit reached. Please try again in a moment.';
      }

      // Generic error
      return 'AI service error. Please try again or contact support if the issue persists.';
    }
  }

  /**
   * Parse a natural language message into a structured command using Gemini.
   * Returns the parsed command or an error if parsing fails.
   * VTID-0525: Operator Command Hub
   */
  async parseCommand(message: string): Promise<GeminiParsedCommand> {
    try {
      console.log('[natural-language-service] Parsing command:', message.substring(0, 100));

      const prompt = COMMAND_PARSE_PROMPT + message + '\n\nRespond with valid JSON only:';

      // Command parsing is the cheap path — `triage` stage.
      const r = await callViaRouter('triage', prompt, {
        service: 'natural-language-service-parse',
      });
      if (!r.ok || !r.text) {
        throw new Error(r.error ?? 'empty response');
      }
      const text = r.text.trim();

      console.log('[natural-language-service] Gemini response:', text);

      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = text;
      if (text.includes('```json')) {
        jsonStr = text.split('```json')[1].split('```')[0].trim();
      } else if (text.includes('```')) {
        jsonStr = text.split('```')[1].split('```')[0].trim();
      }

      const parsed: GeminiParsedCommand = JSON.parse(jsonStr);
      return parsed;

    } catch (error: any) {
      console.error('[natural-language-service] Parse command error:', error);

      // Check for authentication/permission errors
      if (error.message && (error.message.includes('403') || error.message.includes('401') || error.message.includes('API key') || error.message.includes('Forbidden'))) {
        return { error: 'AI service temporarily unavailable (API key issue)' };
      }

      // Rate limit errors
      if (error.message && (error.message.includes('429') || error.message.includes('quota'))) {
        return { error: 'AI service rate limit reached. Please try again.' };
      }

      // JSON parse errors
      if (error instanceof SyntaxError) {
        return { error: 'Could not parse command response' };
      }

      return { error: error.message || 'Failed to parse command' };
    }
  }

  private async buildContext(message: string): Promise<string> {
    let context = 'Vitana platform - health, longevity ecosystem & DevOps infrastructure\n';
    const lower = message.toLowerCase();

    if (lower.includes('status') || lower.includes('health') || lower.includes('service')) {
      try {
        const res = await fetch(`${OASIS_URL}/health/services`, { timeout: 3000 } as any);
        if (res.ok) {
          const data: any = await res.json();
          context += `\nSYSTEM STATUS:\n${JSON.stringify(data, null, 2)}`;
        }
      } catch (err) {
        // Silently fail - context is optional
      }
    }

    if (lower.includes('event') || lower.includes('error') || lower.includes('recent') || lower.includes('vtid')) {
      try {
        const res = await fetch(`${OASIS_URL}/events?limit=10`, { timeout: 3000 } as any);
        if (res.ok) {
          const events: any = await res.json();
          if (Array.isArray(events)) {
            context += `\nRECENT EVENTS:\n${JSON.stringify(events.slice(0, 5), null, 2)}`;
          }
        }
      } catch (err) {
        // Silently fail - context is optional
      }
    }

    return context;
  }
}

export const naturalLanguageService = new NaturalLanguageService();
