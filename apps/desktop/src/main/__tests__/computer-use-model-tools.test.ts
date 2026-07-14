import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MakaTool, ToolAvailabilityConfig } from '@maka/runtime';
import {
  computerUseAvailabilityForModel,
  computerUseToolsForModel,
} from '../computer-use-model-tools.js';

const tool = (name: string): MakaTool => ({ name } as MakaTool);

describe('Computer Use model tool visibility', () => {
  const computer = tool('maka_computer');
  const shell = tool('Bash');
  const availability: ToolAvailabilityConfig = {
    economy: true,
    groups: [
      { id: 'browser', toolNames: ['browser_navigate'] },
      { id: 'computer_use', toolNames: ['maka_computer'] },
    ],
  };

  it('removes screenshot-returning Computer Use tools and their group for text-only models', () => {
    assert.deepEqual(
      computerUseToolsForModel([shell, computer], [computer], false).map((candidate) => candidate.name),
      ['Bash'],
    );
    assert.deepEqual(
      computerUseAvailabilityForModel(availability, false).groups?.map((group) => group.id),
      ['browser'],
    );
  });

  it('preserves the complete tool surface for visual models', () => {
    assert.deepEqual(
      computerUseToolsForModel([shell, computer], [computer], true).map((candidate) => candidate.name),
      ['Bash', 'maka_computer'],
    );
    assert.equal(computerUseAvailabilityForModel(availability, true), availability);
  });
});
