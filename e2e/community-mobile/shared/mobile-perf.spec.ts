import { MOBILE_PERF_TARGETS } from '../../fixtures/mobile-perf-targets';
import { createMobilePerfTests } from '../../fixtures/smoke-helper';

// Runs under the `mobile-shared` project (iPhone-14 emulation, community auth).
// Fails CI when any of the 9 complained-about screens loads over its budget.
createMobilePerfTests('Mobile — Screen Load Budgets', MOBILE_PERF_TARGETS);
