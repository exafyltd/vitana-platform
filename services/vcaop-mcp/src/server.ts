/**
 * Per-request MCP server construction.
 *
 * A fresh McpServer is built for each authenticated request with ONLY the
 * tools the token's scopes authorize — so `tools/list` discovery itself is
 * scope-filtered (brief DoD item 8). A second scope check runs at call time
 * (defense in depth), and every call emits a sanitized audit event.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ZodRawShape } from 'zod';
import { AuthContext, ToolError } from './types';
import { hasScopes } from './auth/scopes';
import { READ_TOOLS } from './tools/registry';
import { MeshReadBackend } from './backend/read-backend';
import { AuditSink, assertAuditSafe } from './audit/audit-sink';

export interface ServerDeps {
  backend: MeshReadBackend;
  audit: AuditSink;
  now?: () => number;
}

function stableError(code: string, message: string) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ error: { code, message } }) },
    ],
    isError: true,
  };
}

export function buildMcpServerForAuth(deps: ServerDeps, ctx: AuthContext): McpServer {
  const server = new McpServer({ name: 'vitanaland-mcp-server', version: '0.1.0' });
  const now = deps.now ?? (() => Date.now());

  // Narrow, explicitly-typed view of registerTool: the SDK's generic inference
  // over a DYNAMIC ZodRawShape (tools registered from data, not literals) hits
  // TS2589 (excessively deep instantiation); the runtime behavior is identical.
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: ZodRawShape;
      annotations: Record<string, boolean>;
    },
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ) => void;

  for (const tool of READ_TOOLS) {
    if (!hasScopes(ctx.scopes, tool.decl.requiredScopes)) continue; // scope-filtered discovery

    registerTool(
      tool.decl.name,
      {
        title: tool.decl.title,
        description: tool.decl.description,
        inputSchema: tool.inputShape,
        annotations: {
          readOnlyHint: tool.decl.readOnly,
          destructiveHint: tool.decl.destructive,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        const started = now();
        const emit = async (status: 'success' | 'error' | 'denied', outcome: string) => {
          const event = {
            service: 'vcaop-mcp' as const,
            topic: tool.decl.auditEventType,
            status,
            message: `${tool.decl.name} ${outcome}`,
            payload: {
              tool: tool.decl.name,
              tenant_id: ctx.tenantId,
              user_id: ctx.userId,
              client_id: ctx.clientId,
              outcome,
              duration_ms: now() - started,
            },
            createdAt: new Date(now()).toISOString(),
          };
          assertAuditSafe(event); // fail loudly rather than emit an unsafe event
          await deps.audit.emit(event);
        };

        // Defense in depth: re-check scopes at call time.
        if (!hasScopes(ctx.scopes, tool.decl.requiredScopes)) {
          await emit('denied', 'forbidden_scope');
          return stableError(
            'forbidden_scope',
            `Missing required scope(s): ${tool.decl.requiredScopes.join(', ')}`,
          );
        }

        try {
          const result = await tool.handler(deps.backend, ctx, args);
          await emit('success', 'ok');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (err) {
          if (err instanceof ToolError) {
            await emit('error', err.code);
            return stableError(err.code, err.message);
          }
          await emit('error', 'internal');
          // Never leak internal error details to external AI clients.
          return stableError('internal', 'Unexpected error. The failure has been recorded.');
        }
      },
    );
  }

  return server;
}
