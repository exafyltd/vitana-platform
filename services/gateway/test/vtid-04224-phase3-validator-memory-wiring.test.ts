/**
 * VTID-04224 Phase 3: runLlmMergeReview (Validator) only recalls file-scoped
 * dev_agent_memory when DEV_AUTOPILOT_VALIDATOR_MEMORY_ENABLED='true', and
 * a recall failure never blocks or degrades the review (fail-open, same
 * posture as this module's own diff-fetch/LLM-call/parse failure paths).
 */

jest.mock('../src/services/github-service', () => ({
  __esModule: true,
  default: { getPrFiles: jest.fn() },
}));

jest.mock('../src/services/llm-router', () => ({
  callViaRouter: jest.fn(),
}));

jest.mock('../src/services/dev-agent-memory-file-recall', () => ({
  isValidatorMemoryRecallEnabled: jest.fn(),
  buildFileScopedMemoryBlock: jest.fn(),
}));

import githubService from '../src/services/github-service';
import { callViaRouter } from '../src/services/llm-router';
import { isValidatorMemoryRecallEnabled, buildFileScopedMemoryBlock } from '../src/services/dev-agent-memory-file-recall';
import { runLlmMergeReview } from '../src/services/dev-autopilot-llm-review';

const mockGetPrFiles = githubService.getPrFiles as jest.Mock;
const mockCallViaRouter = callViaRouter as jest.Mock;
const mockIsEnabled = isValidatorMemoryRecallEnabled as jest.Mock;
const mockBuildBlock = buildFileScopedMemoryBlock as jest.Mock;

describe('runLlmMergeReview — dev_agent_memory recall gating (VTID-04224 Phase 3)', () => {
  beforeEach(() => {
    mockGetPrFiles.mockReset();
    mockCallViaRouter.mockReset();
    mockIsEnabled.mockReset();
    mockBuildBlock.mockReset();
    mockGetPrFiles.mockResolvedValue([{ filename: 'services/gateway/src/services/a.ts', status: 'modified', patch: '+x' }]);
    mockCallViaRouter.mockResolvedValue({ ok: true, text: '{"verdict":"pass"}' });
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
    const promptArg = mockCallViaRouter.mock.calls[0][1] as string;
    expect(promptArg).toContain('a recalled gotcha');
  });

  it('fails open — a thrown recall error never blocks the review', async () => {
    mockIsEnabled.mockReturnValue(true);
    mockBuildBlock.mockRejectedValue(new Error('rpc exploded'));
    const result = await runLlmMergeReview({ repo: 'exafyltd/vitana-platform', prNumber: 1, vtid: 'VTID-09999' });
    expect(result.ok).toBe(true);
    expect(result.passed).toBe(true);
    expect(mockCallViaRouter).toHaveBeenCalled();
  });
});
