import { Router, Request, Response } from 'express';

interface SseClient {
  id: string;
  res: Response;
}

class SseService {
  private clients: SseClient[] = [];
  private eventBuffer: any[] = [];
  private readonly BUFFER_SIZE = 10;
  public router: Router;

  constructor() {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    this.router.get('/api/v1/events/stream', (req: Request, res: Response) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.flushHeaders();

      const client: SseClient = {
        id: Math.random().toString(36).substring(7),
        res
      };

      this.clients.push(client);
      console.log(`[SSE] Client ${client.id} connected (${this.clients.length} total)`);

      res.write(`data: ${JSON.stringify({ type: 'connected', clientId: client.id })}\n\n`);

      this.eventBuffer.forEach(event => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      req.on('close', () => {
        this.clients = this.clients.filter(c => c.id !== client.id);
        console.log(`[SSE] Client ${client.id} disconnected (${this.clients.length} remaining)`);
      });
    });
  }

  public broadcast(event: any): void {
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.BUFFER_SIZE) {
      this.eventBuffer.shift();
    }

    const message = `data: ${JSON.stringify(event)}\n\n`;
    this.clients.forEach(client => {
      try {
        client.res.write(message);
      } catch (error) {
        console.error(`[SSE] Error sending to client ${client.id}:`, error);
      }
    });

    console.log(`[SSE] Broadcasted event to ${this.clients.length} clients`);
  }
}

export const sseService = new SseService();
