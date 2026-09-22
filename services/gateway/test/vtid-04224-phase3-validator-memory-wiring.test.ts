/**
 * VTID-04224 Phase 3: runLlmMergeReview (Validator) only recalls file-scoped
 * dev_agent_memory when DEV_AUTOPILOT_VALIDATOR_MEMORY_ENABLED='true', and a
 * recall failure never blocks or degrades the review (fail-open, same
 * posture as this module's own diff-fetch/LLM-call/parse failure paths).
 *
 * VTID-04231 (merged into main after this test was first written) replaced
 * the single `callViaRouter` call this module used to make with a bounded
 * tool loop (`runStageToolLoop`) — the review-tools-enabled path also does
 * a `getPullRequest` lookup to resolve the PR head. This suite pins
 * `DEV_AUTOPILOT_LLM_REVIEW_TOOLS_ENABLED=false` so it exercises only the
 * single-shot leg (tools disabled), keeping this test focused on the
 * memory-recall gating rather than re-testing the tool loop itself, which
 * `vtid-04231-validator-tools.test.ts` already covers.
 */

jest.mock('../src/services/github-service', () => ({
  __esModule: true,
  default: { getPrFiles: jest.fn(), getPullRequest: jest.fn() },
}));

jest.mock('../src/services/llm-stage-tool-loop', () => ({
  runStageToolLoop: jest.fn(),
}));

jest.mock('../src/services/dev-agent-memory-file-recall', () => ({
  isValidatorMemoryRecallEnabled: jest.fn(),
  buildFileScopedMemoryBlock: jest.fn(),
}));

import githubService from '../src/services/github-service';
import { runStageToolLoop } from '../src/services/llm-stage-tool-loop';
import { isValidatorMemoryRecallEnabled, buildFileScopedMemoryBlock } from '../src/services/dev-agent-memory-file-recall';
import { runLlmMergeReview } from '../src/services/dev-autopilot-llm-review';

const mockGetPrFiles = githubService.getPrFiles as jest.Mock;
const mockLoop = runStageToolLoop as jest.Mock;
const mockIsEnabled = isValidatorMemoryRecallEnabled as jest.Mock;
const mockBuildBlock = buildFileScopedMemoryBlock as jest.Mock;

describe('runLlmMergeReview — dev_agent_memory recall gating (VTID-04224 Phase 3)', () => {
  const ORIGINAL_TOOLS_FLAG = process.env.DEV_AUTOPILOT_LLM_REVIEW_TOOLS_ENABLED;

  beforeEach(() => {
    mockGetPrFiles.mockReset();
    mockLoop.mockReset();
    mockIsEnabled.mockReset();
    mockBuildBlock.mockReset();
    process.env.DEV_AUTOPILOT_LLM_REVIEW_TOOLS_ENABLED = 'false';
    mockGetPrFiles.mockResolvedValue([{ filename: 'services/gateway/src/services/a.ts', status: 'modified', patch: '+x' }]);
    mockLoop.mockResolvedValue({ ok: true, text: '{"verdict":"pass"}', toolCalls: 0, toolNames: [] });
  });

  afterEach(() => {
    if (ORIGINAL_TOOLS_FLAG === undefined) delete process.env.DEV_AUTOPILOT_LLM_REVIEW_TOOLS_ENABLED;
    else process.env.DEV_AUTOPILOT_LLM_REVIEW_TOOLS_ENABLED = ORIGINAL_TOOLS_FLAG;
  });

  it('does not call buildFileScopedMemoryBlock when the flag is off', async () => {
    mockIsEnabled.mockReturnValue(false);
    await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 1, vtid: 'VTID-09999' });
    expect(mockBuildBlock).not.toHaveBeenCalled();
  });

  it('calls buildFileScopedMemoryBlock with the PR\'s changed filenames when the flag is on, and splices the result into the prompt', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockBuildBlock.mockResolvedValue('**Engineering memory for these specific files**\n\n- a recalled gotcha');
    await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 1, vtid: 'VTID-09999' });
    expect(mockBuildBlock).toHaveBeenCalledWith(['services/gateway/src/services/a.ts'], 'vitana-platform');
    const promptArg = mockLoop.mock.calls[0][0].prompt as string;
    expect(promptArg).toContain('a recalled gotcha');
  });

  it('fails open — a thrown recall error never blocks the review', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockBuildBlock.mockRejectedValue(new Error('rpc exploded'));
    const result = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 1, vtid: 'VTID-09999' });
    expect(result.ok).toBe(true);
    expect(result.passed).toBe(true);
    expect(mockLoop).toHaveBeenCalled();
  });
});
