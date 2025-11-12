import { createOasisEvent } from './services/gateway/src/lib/oasis.js';

await createOasisEvent({
  vtid: "DEV-COMMU-0053",
  kind: "task.complete",
  status: "success",
  title: "Task List API live in production",
  message: "Gateway deployed. /api/v1/tasks returning real VTID data.",
  timestamp: new Date().toISOString()
});
console.log("✅ OASIS task.complete emitted for DEV-COMMU-0053");
