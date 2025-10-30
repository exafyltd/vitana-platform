# VITANA DevOps - Current State
Last Updated: 2025-10-30 07:30 UTC

## Active VTID
**DEV-AICOR-0009** - OASIS Operator + Command Hub (IN PROGRESS)

## Completed VTIDs
- ✅ DEV-AICOR-0007 - Gemini Routing Layer
- ✅ DEV-AICOR-0008 - Autonomous PR + Deploy

## Deployed Services
- planner-core: https://planner-core-86804897789.us-central1.run.app ✅
- worker-core: https://worker-core-86804897789.us-central1.run.app ✅
- validator-core: https://validator-core-86804897789.us-central1.run.app ✅
- conductor: https://conductor-86804897789.us-central1.run.app ✅
- oasis-approval: https://oasis-approval-86804897789.us-central1.run.app ✅
- oasis-operator: https://oasis-operator-86804897789.us-central1.run.app ✅

## DEV-AICOR-0009 Progress
### Phase A: Backend - ✅ COMPLETE
- [x] OASIS Operator deployed
- [x] Chat endpoint working (creates VTIDs)
- [x] Thread endpoint working
- [x] Events API working
- [x] SSE stream implemented
- [x] OASIS event logging

### Phase B: Event Mappings - TODO
- [ ] Register event kinds in Supabase
- [ ] Update Live Console filters

### Phase C: Frontend - TODO (manual)
- [ ] Wire chat composer
- [ ] Wire Live Console
- [ ] Test end-to-end

### Phase D: Config - ✅ COMPLETE
- [x] Supabase seed created

### Phase E: CI/CD - ✅ COMPLETE
- [x] GitHub workflow created

## Test Results
- Chat creates VTID: ✅ DEV-OPER-0692CCE5
- Events logged: ✅ task.created, chat.message.*
- SSE endpoint: Ready for testing
