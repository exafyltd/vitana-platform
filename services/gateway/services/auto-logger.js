"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auto-logger-service = void 0;
const eventsource_1 = __importDefault(require("eventsource"));
const yaml = __importStar(require("js-yaml"));
const fs = __importStar(require("fs"));
const CONFIG = {
    OASIS_API_URL: process.env.OASIS_API_URL || 'https://oasis-api.vitana.app',
    DEVOPS_CHAT_WEBHOOK: process.env.DEVOPS_CHAT_WEBHOOK || '',
};
class auto-logger-service {
    templates = {};
    eventSource = null;
    constructor() {
        const config = yaml.load(fs.readFileSync(__dirname + '/../config/auto-logger_templates.yaml', 'utf8'));
        this.templates = config.templates;
        console.log(`Loaded ${Object.keys(this.templates).length} templates`);
    }
    async start() {
        const url = `${CONFIG.OASIS_API_URL}/events/stream`;
        console.log(`Connecting to: ${url}`);
        this.eventSource = new eventsource_1.default(url);
        this.eventSource.onopen = () => console.log('✅ Connected to OASIS');
        this.eventSource.onmessage = (e) => this.handleEvent(JSON.parse(e.data));
        this.eventSource.onerror = (err) => console.error('SSE error:', err);
    }
    async stop() {
        if (this.eventSource)
            this.eventSource.close();
    }
    handleEvent(event) {
        const template = this.templates[event.event_type] || this.templates['default'];
        if (!template)
            return;
        const message = template.message
            .replace(/{vtid}/g, event.vtid || 'N/A')
            .replace(/{event_type}/g, event.event_type)
            .replace(/{actor}/g, event.actor)
            .replace(/{environment}/g, event.environment)
            .replace(/{metadata\.(\w+)}/g, (_, k) => event.metadata?.[k] || '');
        // Post to OASIS
        fetch(`${CONFIG.OASIS_API_URL}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event_type: 'vtid.update',
                vtid: event.vtid,
                source_service: 'auto-logger',
                actor: 'auto-logger',
                environment: event.environment,
                metadata: { summary: message },
            }),
        }).catch(e => console.error('OASIS post failed:', e));
        // Post to Google Chat (Command HUB)
        if (CONFIG.DEVOPS_CHAT_WEBHOOK) {
            fetch(CONFIG.DEVOPS_CHAT_WEBHOOK, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: message }),
            }).catch(e => console.error('Chat post failed:', e));
        }
    }
}
exports.auto-logger-service = auto-logger-service;
//# sourceMappingURL=auto-logger.js.map