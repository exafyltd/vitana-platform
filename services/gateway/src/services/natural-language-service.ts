import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyDCbka2qbs9ql_UxzAtLIfz_n-9g985KCc';
const OASIS_URL = process.env.OASIS_OPERATOR_URL || 'https://oasis-operator-86804897789.us-central1.run.app';

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const flashModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
const proModel = genAI.getGenerativeModel({ model: 'gemini-2.0-pro-exp' });

export class NaturalLanguageService {
  async processMessage(message: string): Promise<string> {
    try {
      const context = await this.buildContext(message);
      const useComplex = message.length > 300 || /analyze|compare|explain|detail/.test(message.toLowerCase());
      const model = useComplex ? proModel : flashModel;
      
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

      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error: any) {
      console.error('[natural-language-service] Gemini error:', error);
      
      // Check for authentication/permission errors
      if (error.message && (error.message.includes('403') || error.message.includes('401') || error.message.includes('API key') || error.message.includes('Forbidden'))) {
        return '⚠️ AI service temporarily unavailable (API key issue). Please contact the administrator to update the Gemini API key.';
      }
      
      // Rate limit errors
      if (error.message && (error.message.includes('429') || error.message.includes('quota'))) {
        return '⚠️ AI service rate limit reached. Please try again in a moment.';
      }
      
      // Generic error
      return '⚠️ AI service error. Please try again or contact support if the issue persists.';
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
