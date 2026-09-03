import { describe, expect, it } from 'vitest';
import { describeExit } from './stdio';
import type { AgentClosed } from '../types';

const closed = (over: Partial<AgentClosed> = {}): AgentClosed => ({
  agent_id: 'a1',
  exit_code: null,
  stderr_tail: [],
  ...over,
});

describe('describeExit', () => {
  it('falls back to the bare reason when nothing was captured', () => {
    expect(describeExit(closed())).toBe('agent process exited');
  });

  it('names the exit code when the process was reaped', () => {
    expect(describeExit(closed({ exit_code: 1 }))).toBe('agent process exited with code 1');
  });

  // The localacp-6cw regression: a failed `npx` spawn used to surface as a bare
  // "agent process exited", with the actionable npm error dropped at DEBUG.
  it('quotes the stderr tail so a failed spawn explains itself', () => {
    const reason = describeExit(
      closed({
        exit_code: 1,
        stderr_tail: [
          'npm error code ENOTEMPTY',
          "npm error ENOTEMPTY: directory not empty, rename '.../copilot-darwin-arm64'",
        ],
      })
    );

    expect(reason).toContain('agent process exited with code 1');
    expect(reason).toContain('npm error code ENOTEMPTY');
    expect(reason).toContain('directory not empty');
  });

  it('quotes only the last lines of a long tail', () => {
    const reason = describeExit(
      closed({
        exit_code: 1,
        stderr_tail: Array.from({ length: 30 }, (_, i) => `line ${i}`),
      })
    );

    expect(reason).toContain('line 29');
    expect(reason).toContain('line 20');
    expect(reason).not.toContain('line 19');
  });

  it('ignores a tail that is only blank lines', () => {
    expect(describeExit(closed({ exit_code: 2, stderr_tail: ['', '   '] }))).toBe(
      'agent process exited with code 2'
    );
  });
});
