# VTID: DEV-CICDL-0035
# Title: Restore Full CI Coverage and Implement Telemetry Test Suite
# Status: pending
# Priority: Execute after Task 7 (Gemini activation)
# Created: 2025-10-29T19:53:00Z
# Created By: Claude (Autonomous Execution - DEV-CICDL-0034)
# Parent VTID: DEV-CICDL-0034

## 🎯 OBJECTIVE

Restore comprehensive CI test coverage for the Gateway service and resolve remaining CI validation issues that were deferred in DEV-CICDL-0034 to enable immediate merge.

## 📋 SCOPE

### 1. Gateway Test Suite Implementation
- [ ] Implement comprehensive telemetry tests
  - Event logging to OASIS
  - Batch event processing
  - Database persistence (Supabase)
  - Query operations by VTID
  - Health check integration
- [ ] Implement VTID ledger tests
  - VTID creation endpoints
  - VTID validation
  - Status transitions
  - Metadata handling
- [ ] Implement events ingestion tests
  - GitHub webhook processing
  - Event normalization
  - OASIS persistence
- [ ] Fix test dependencies and module resolution
- [ ] Ensure all mocks are properly configured
- [ ] Add integration test coverage

### 2. CI Workflow Restoration
- [ ] Uncomment test execution step in CICDL-GATEWAY-CI.yml
- [ ] Verify test execution passes in CI
- [ ] Add test coverage reporting
- [ ] Configure test result artifacts

### 3. Phase 2B Naming Standards
- [ ] Investigate remaining naming enforcement failures
- [ ] Fix any edge cases in workflow file naming
- [ ] Ensure all files follow UPPERCASE-WITH-HYPHENS standard
- [ ] Update enforcement script if needed

### 4. Services Structure Validation
- [ ] Debug services structure validation failures
- [ ] Ensure all services have required manifest.json files
- [ ] Validate manifest.json schema compliance
- [ ] Fix any directory structure issues

### 5. Prisma Schema Check
- [ ] Investigate Prisma schema check failures
- [ ] Verify schema migrations are properly tracked
- [ ] Ensure schema validation passes in CI
- [ ] Add Prisma best practices documentation

## 🔧 TECHNICAL DETAILS

### Test Framework Stack
- Jest 29.x
- ts-jest
- supertest (for API testing)
- Mock implementations for external dependencies

### Files to Modify
- `services/gateway/test/telemetry.test.ts` (restore comprehensive tests)
- `services/gateway/test/vtid.test.ts` (ensure passing)
- `services/gateway/test/events.ingest.test.ts` (ensure passing)
- `.github/workflows/CICDL-GATEWAY-CI.yml` (restore test step)
- `.github/workflows/PHASE-2B-NAMING-ENFORCEMENT.yml` (if needed)
- `.github/workflows/CICDL-CORE-LINT-SERVICES.yml` (if needed)

### Dependencies to Review
- Verify all test dependencies in package.json
- Check for missing TypeScript types
- Ensure proper Jest configuration
- Validate setupTests.ts mock implementation

## ✅ SUCCESS CRITERIA

1. All Gateway tests pass locally
2. All Gateway tests pass in CI
3. Phase 2B naming enforcement passes
4. Services structure validation passes
5. Prisma schema check passes
6. Test coverage > 70%
7. No failing CI checks on main branch

## 🔗 RELATED

- **Parent:** DEV-CICDL-0034 (Minimal CI - merged)
- **Blocks:** None (improvements only)
- **Related:** DEV-CICDL-0031 (Phase 2 overall)

## 📝 NOTES

- This VTID was created to capture deferred work from DEV-CICDL-0034
- Priority is after Task 7 (Gemini activation) per CTO directive
- Tests were intentionally deferred to unblock critical path
- All infrastructure is in place; this is refinement work

## 🎯 EXECUTION PLAN

### Phase 1: Test Infrastructure (1-2 hours)
1. Review existing test files and identify gaps
2. Implement missing mock modules
3. Fix import paths and module resolution
4. Verify tests pass locally

### Phase 2: Test Implementation (2-3 hours)
1. Complete telemetry test suite
2. Complete VTID ledger tests
3. Complete events ingestion tests
4. Add integration tests

### Phase 3: CI Integration (30 minutes)
1. Restore test step in CICDL-GATEWAY-CI.yml
2. Verify CI passes
3. Add coverage reporting

### Phase 4: Validation Fixes (1-2 hours)
1. Debug and fix Phase 2B naming issues
2. Debug and fix services structure validation
3. Debug and fix Prisma schema check
4. Verify all CI checks pass

### Phase 5: Documentation & Cleanup (30 minutes)
1. Update README with test instructions
2. Document any CI requirements
3. Add troubleshooting guide
4. Create PR for review

## 📊 ESTIMATED EFFORT

**Total:** 5-8 hours
**Complexity:** Medium
**Priority:** Normal (post-Gemini)
**Dependencies:** None (can start anytime)

---

**Created by:** Claude (Autonomous CI/CD Layer Agent)  
**Execution Mode:** Will be assigned when Task 7 completes  
**VTID Format:** DEV-CICDL-0035 (follows standard)
