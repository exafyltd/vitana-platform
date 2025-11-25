/**
 * Operator Service
 * DEV-AICOR-0027: Operator Chat Backend Fix
 */

import { naturalLanguageService } from './natural-language-service';
import fetch from 'node-fetch';

const OASIS_URL = process.env.OASIS_OPERATOR_URL || 'https://oasis-operator-86804897789.us-central1.run.app';

interface OperatorResponse {
  reply: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  } | null;
  oasis: {
    task_created: boolean;
    vtid?: string;
    task_id?: string;
  } | null;
}

export class OperatorService {
  async processOperatorMessage(message: string, vtid?: string): Promise<OperatorResponse> {
    if (message.trim().startsWith('/oasis create ')) {
      return await this.handleOasisCreate(message, vtid);
    }
    return await this.handleNaturalLanguage(message, vtid);
  }

  private async handleOasisCreate(message: string, vtid?: string): Promise<OperatorResponse> {
    try {
      const jsonStr = message.substring('/oasis create '.length).trim();
      let payload: any;
      try {
        payload = JSON.parse(jsonStr);
      } catch (parseError) {
        return {
          reply: 'Error: Invalid JSON format. Expected: /oasis create {\"title\":\"...\", \"description\":\"...\"}',
          model: 'none',
          usage: null,
          oasis: { task_created: false }
        };
      }

      const response = await fetch(`${OASIS_URL}/api/v1/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, vtid: vtid || payload.vtid || undefined })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('OASIS task creation failed:', response.status, errorText);
        return {
          reply: `Error creating OASIS task: ${errorText}`,
          model: 'none',
          usage: null,
          oasis: { task_created: false }
        };
      }

      const result: any = await response.json();
      return {
        reply: `✓ OASIS task created successfully: ${result.title || ''}`,
        model: 'none',
        usage: null,
        oasis: {
          task_created: true,
          vtid: result.vtid || undefined,
          task_id: result.id || undefined
        }
      };
    } catch (error: any) {
      console.error('Error handling /oasis create:', error);
      return {
        reply: `Error: ${error.message}`,
        model: 'none',
        usage: null,
        oasis: { task_created: false }
      };
    }
  }

  private async handleNaturalLanguage(message: string, vtid?: string): Promise<OperatorResponse> {
    try {
      const reply = await naturalLanguageService.processOperatorMessage(message, vtid);
      const useComplex = message.length > 300 || /analyze|compare|explain|detail/.test(message.toLowerCase());
      const model = useComplex ? 'gemini-2.0-pro-exp' : 'gemini-2.0-flash-exp';
      const inputTokens = Math.ceil(message.length / 4);
      const outputTokens = Math.ceil(reply.length / 4);

      return {
        reply,
        model,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        oasis: null
      };
    } catch (error: any) {
      console.error('Error in natural language processing:', error);
      return {
        reply: `⚠️ Error: ${error.message}`,
        model: 'error',
        usage: null,
        oasis: null
      };
    }
  }
}

export const operatorService = new OperatorService();
