#!/usr/bin/env node
/**
 * Vitana Work MCP Server
 *
 * Enables Claude Code to discover, pick up, and manage Vitana tasks via MCP tools.
 * This server does NOT make routing decisions - it calls the existing orchestrator endpoint.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { listPendingTasks } from './tools/list-pending.js';
import { pickupTask } from './tools/pickup-task.js';
import { reportProgress } from './tools/report-progress.js';
import { submitEvidence } from './tools/submit-evidence.js';
import { completeTask } from './tools/complete-task.js';
import { discoverTasks } from './tools/discover-tasks.js';

// Create server instance
const server = new Server(
  {
    name: 'vitana-work',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
const TOOLS = [
  {
    name: 'list_pending_tasks',
    description: 'List pending Vitana work orders available for pickup',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'pickup_task',
    description:
      'Pick up a Vitana task by VTID. Fetches the spec and gets routing decision from orchestrator. Returns session_name for renaming the Claude Code session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        vtid: {
          type: 'string',
          description: 'The VTID of the task to pick up (e.g., "VTID-01165")',
        },
      },
      required: ['vtid'],
    },
  },
  {
    name: 'report_progress',
    description: 'Report progress on a task. Emits an OASIS event for tracking.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        vtid: {
          type: 'string',
          description: 'The VTID of the task',
        },
        message: {
          type: 'string',
          description: 'Progress message to record',
        },
      },
      required: ['vtid', 'message'],
    },
  },
  {
    name: 'submit_evidence',
    description: 'Submit evidence for a task (PR, commit, or deploy URL)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        vtid: {
          type: 'string',
          description: 'The VTID of the task',
        },
        type: {
          type: 'string',
          enum: ['pr', 'commit', 'deploy'],
          description: 'Type of evidence',
        },
        url: {
          type: 'string',
          description: 'URL of the evidence (PR link, commit link, or deploy URL)',
        },
      },
      required: ['vtid', 'type', 'url'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task as completed with a summary',
    inputSchema: {
      type: 'object' as const,
      properties: {
        vtid: {
          type: 'string',
          description: 'The VTID of the task to complete',
        },
        summary: {
          type: 'string',
          description: 'Summary of what was accomplished',
        },
      },
      required: ['vtid', 'summary'],
    },
  },
  {
    name: 'discover_tasks',
    description:
      'VTID-01161: Discover pending tasks from OASIS (read-only). Returns ONLY tasks with status in {scheduled, allocated, in_progress} and valid VTID format (VTID-\\d{4,5}). Legacy DEV-* items are listed as ignored.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tenant: {
          type: 'string',
          description: 'Tenant identifier (default: "vitana")',
        },
        environment: {
          type: 'string',
          description: 'Environment identifier (default: "dev_sandbox")',
        },
        statuses: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['scheduled', 'allocated', 'in_progress'],
          },
          description:
            'Filter by status. Must be subset of {scheduled, allocated, in_progress}',
        },
        limit: {
          type: 'number',
          description: 'Max tasks to return (1-200, default: 50)',
        },
        include_events: {
          type: 'boolean',
          description: 'Include events in response (default: false)',
        },
      },
      required: [],
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'list_pending_tasks': {
        const result = await listPendingTasks();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'pickup_task': {
        const vtid = (args as { vtid: string }).vtid;
        const result = await pickupTask({ vtid });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'report_progress': {
        const { vtid, message } = args as { vtid: string; message: string };
        const result = await reportProgress({ vtid, message });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'submit_evidence': {
        const { vtid, type, url } = args as {
          vtid: string;
          type: 'pr' | 'commit' | 'deploy';
          url: string;
        };
        const result = await submitEvidence({ vtid, type, url });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'complete_task': {
        const { vtid, summary } = args as { vtid: string; summary: string };
        const result = await completeTask({ vtid, summary });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'discover_tasks': {
        const { tenant, environment, statuses, limit, include_events } = args as {
          tenant?: string;
          environment?: string;
          statuses?: ('scheduled' | 'allocated' | 'in_progress')[];
          limit?: number;
          include_events?: boolean;
        };
        const result = await discoverTasks({
          tenant,
          environment,
          statuses,
          limit,
          include_events,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: false, error: errorMessage }),
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Vitana Work MCP Server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
