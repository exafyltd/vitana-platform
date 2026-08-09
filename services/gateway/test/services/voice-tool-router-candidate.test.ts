// BOOTSTRAP-PHASE1-W2-SHADOW-RUNTIME-WIRE — unit tests for the voice
// tool-router shadow candidate stub.
//
// W2 has no trained fine-tune served yet, so `predictVoiceToolRoute()` is a
// pure echo of `input.primaryTool` — the point of this stub is to prove the
// shadow-eval wire end-to-end (see file header). These tests lock in the
// echo contract so a future real-model swap can't silently regress it back
// to a no-op without a test failing, and so any accidental transformation
// (trimming, casing, transcript-based override) gets caught.

import { predictVoiceToolRoute } from '../../src/services/voice-tool-router-candidate';

describe('predictVoiceToolRoute — W2 shadow stub (echoes primaryTool)', () => {
  it('resolves to exactly the given primaryTool', async () => {
    const result = await predictVoiceToolRoute({
      transcript: 'what is the weather today',
      primaryTool: 'search_web',
    });

    expect(result).toBe('search_web');
  });

  it('echoes a different primaryTool unchanged for a different call', async () => {
    const result = await predictVoiceToolRoute({
      transcript: 'add this to my calendar',
      primaryTool: 'create_calendar_event',
    });

    expect(result).toBe('create_calendar_event');
  });

  it('ignores transcript content entirely — output tracks primaryTool, not any tool name mentioned in the transcript', async () => {
    const result = await predictVoiceToolRoute({
      transcript: 'please call search_web for me',
      primaryTool: 'unrelated_tool_name',
    });

    expect(result).toBe('unrelated_tool_name');
  });

  it('does not alter case, whitespace, or otherwise transform the tool name', async () => {
    const result = await predictVoiceToolRoute({
      transcript: 'irrelevant',
      primaryTool: '  Weird_Casing_Tool  ',
    });

    expect(result).toBe('  Weird_Casing_Tool  ');
  });

  it('handles an empty transcript', async () => {
    const result = await predictVoiceToolRoute({
      transcript: '',
      primaryTool: 'noop_tool',
    });

    expect(result).toBe('noop_tool');
  });

  it('handles an empty primaryTool string without substituting a default', async () => {
    const result = await predictVoiceToolRoute({
      transcript: 'some transcript',
      primaryTool: '',
    });

    expect(result).toBe('');
  });

  it('returns a Promise that resolves (not a bare synchronous value)', () => {
    const returned = predictVoiceToolRoute({ transcript: 'x', primaryTool: 'y' });

    expect(returned).toBeInstanceOf(Promise);
    return expect(returned).resolves.toBe('y');
  });
});
