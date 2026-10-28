#!/usr/bin/env node
import { auto-logger-service } from '../services/auto-logger';
const service = new auto-logger-service();
process.on('SIGINT', async () => { await service.stop(); process.exit(0); });
service.start().then(() => console.log('Running. Ctrl+C to stop.'));
