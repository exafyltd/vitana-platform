import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OASIS_URL = process.env.OASIS_OPERATOR_URL || 'https://oasis-operator-86804897789.us-central1.run.app';

export class NaturalLanguageService {
  private genAI: GoogleGenerativeAI;

  constructor() {
    this.genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  }

  async processOperatorMessage(message: string, vtid?: string): Promise<any> {
    // 1. Check for Safe OASIS Write Command (Validation Requirement)
    const oasisMatch = message.match(/^\/oasis create\s+(.*)/);
    if (oasisMatch) {
      try {
        const jsonStr = oasisMatch[1];
        const taskData = JSON.parse(jsonStr);

        // Call OASIS to create task
        const res = await fetch(`${OASIS_URL}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(taskData)
        });

        if (!res.ok) {
          throw new Error(`OASIS error: ${res.statusText}`);
        }

        const createdTask = await res.json() as any;

        return {
          reply: `✅ OASIS Task Created Successfully.\n\nID: ${createdTask.id || 'Unknown'}\nVTID: ${createdTask.vtid || 'Pending'}`,
          model: 'models/gemini-3.0-pro',
          oasis: {
            task_created: true,
            task_id: createdTask.id,
            vtid: createdTask.vtid
          },
          timestamp: new Date().toISOString()
        };
      } catch (err: any) {
        return {
          reply: `❌ Failed to create OASIS task.\nError: ${err.message}\n\nPlease ensure valid JSON format: /oasis create {"title": "...", ...}`,
          model: 'models/gemini-3.0-pro',
          timestamp: new Date().toISOString()
        };
      }
    }

    // 2. Legacy Context Building (Restored)
    let context = `You are the Vitana Command Hub AI assistant. Answer based on the text provided.`;

    try {
      // Fetch recent events from OASIS (Knowledge Hub)
      const res = await fetch(`${OASIS_URL}/events?limit=10`);
      if (res.ok) {
        const events: any = await res.json();
        if (Array.isArray(events)) {
          context += `\nRECENT EVENTS:\n${JSON.stringify(events.slice(0, 5), null, 2)}`;
        }
      }
    } catch (err) {
      console.warn('Failed to fetch OASIS events for context:', err);
    }

    context += `\nUSER MESSAGE: ${message}\n\nProvide a helpful, concise answer:`;

    // 3. Generate Content
    try {
      const model = this.genAI.getGenerativeModel({ model: 'models/gemini-3.0-pro' });
      const result = await model.generateContent(context);
      const response = await result.response;
      const text = response.text();

      return {
        reply: text,
        model: 'models/gemini-3.0-pro',
        timestamp: new Date().toISOString()
      };
    } catch (error: any) {
      console.error('[natural-language-service] Operator error:', error);
      return {
        reply: "⚠️ Operator Brain Offline. (Gemini API Error)",
        model: 'models/gemini-3.0-pro',
        timestamp: new Date().toISOString()
      };
    }
  }
}

export const naturalLanguageService = new NaturalLanguageService();
