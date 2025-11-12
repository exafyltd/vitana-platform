import { createOasisEvent } from './services/gateway/src/lib/oasis.js';

await createOasisEvent({
  vtid: "DEV-COMMU-0053",
  kind: "task.update",
  status: "in_progress",
  title: "Local tests passing, PR opened",
  message: "Gateway /api/v1/tasks endpoint ready for review. Response contract validated.",
  timestamp: new Date().toISOString()
});
console.log("✅ OASIS task.update emitted for DEV-COMMU-0053");
