import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDeferredToolGroupsFromCatalog,
  buildHostCapabilitiesFromBinding,
} from '../tool-catalog-derive.js';

describe('buildHostCapabilitiesFromBinding', () => {
  it('collects bound tool names and capability tags from catalog rows', () => {
    const host = buildHostCapabilitiesFromBinding(['Read', 'OfficeDocument', 'OfficeDocumentEdit']);
    assert.deepEqual([...host.toolNames].sort(), ['OfficeDocument', 'OfficeDocumentEdit', 'Read']);
    assert.deepEqual([...(host.capabilities ?? [])].sort(), ['office']);
  });

  it('omits capabilities when no bound tool carries tags', () => {
    const host = buildHostCapabilitiesFromBinding(['Read', 'Bash']);
    assert.equal(host.capabilities, undefined);
    assert.equal(host.toolNames.has('Bash'), true);
  });
});

describe('buildDeferredToolGroupsFromCatalog', () => {
  it('includes only supported deferred surfaces that have bound members', () => {
    const groups = buildDeferredToolGroupsFromCatalog('desktop', [
      'Read',
      'OfficeDocument',
      'agent_spawn',
      'agent_list',
      'RiveWorkflow',
    ]);
    assert.deepEqual(groups.map((group) => group.id).sort(), ['agent', 'office', 'rive']);
    const office = groups.find((group) => group.id === 'office');
    assert.deepEqual(office?.toolNames, ['OfficeDocument']);
    assert.equal(office?.label, 'Office');
    const agent = groups.find((group) => group.id === 'agent');
    assert.deepEqual(agent?.toolNames, ['agent_spawn', 'agent_list']);
  });

  it('never advertises desktop-only packs on cli or headless', () => {
    const bound = [
      'OfficeDocument',
      'browser_navigate',
      'maka_computer',
      'RiveWorkflow',
      'agent_spawn',
      'agent_swarm',
      'agent_list',
      'agent_output',
    ];
    for (const host of ['cli', 'headless'] as const) {
      const groups = buildDeferredToolGroupsFromCatalog(host, bound);
      assert.deepEqual(
        groups.map((group) => group.id),
        ['agent'],
      );
      assert.equal(
        groups.some((group) => ['office', 'browser', 'computer_use', 'rive'].includes(group.id)),
        false,
      );
    }
  });

  it('returns no group when a supported surface has zero bound members', () => {
    const groups = buildDeferredToolGroupsFromCatalog('desktop', ['Read', 'Bash']);
    assert.deepEqual(groups, []);
  });
});
