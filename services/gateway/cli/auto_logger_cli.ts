#!/usr/bin/env node
import { AutoLoggerService } from '../services/auto_logger';
const service = new AutoLoggerService();
process.on('SIGINT', async () => { await service.stop(); process.exit(0); });
service.start().then(() => console.log('Running. Ctrl+C to stop.'));
