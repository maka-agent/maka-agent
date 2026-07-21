import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TUI, visibleWidth } from '@earendil-works/pi-tui';
import type { BundledSkillTemplateSource, SkillInspectionEntry } from '@maka/runtime';
import {
  buildSkillTemplateManagementEntries,
  canToggleSkillManagementEntry,
  filterSkillTemplateManagementEntries,
  filterSkillManagementEntries,
  formatSkillDiagnostic,
  formatSkillTemplateReview,
  matchesSkillManagementFilter,
  sanitizeSkillTerminalText,
} from '../skill-management.js';
import { SkillManagementOverlay, SkillTemplateManagementOverlay } from '../pi-tui-pickers.js';
import { FakeTerminal } from './tui-terminal-mock.js';

describe('TUI Skill management', () => {
  test('uses the same status filter buckets as Desktop', () => {
    const entries = [
      entry('ok', 'eligible'),
      entry('invalid', 'invalid'),
      entry('state', 'state_error'),
      entry('disabled', 'disabled'),
      entry('shadowed', 'shadowed'),
      entry('host', 'host_incompatible'),
    ];

    assert.deepEqual(
      entries
        .filter((candidate) => matchesSkillManagementFilter(candidate, 'usable'))
        .map((candidate) => candidate.id),
      ['ok'],
    );
    assert.deepEqual(
      entries
        .filter((candidate) => matchesSkillManagementFilter(candidate, 'attention'))
        .map((candidate) => candidate.id),
      ['invalid', 'state'],
    );
    assert.deepEqual(
      entries
        .filter((candidate) => matchesSkillManagementFilter(candidate, 'unavailable'))
        .map((candidate) => candidate.id),
      ['disabled', 'shadowed', 'host'],
    );
  });

  test('allows toggles only for effective safe entries', () => {
    assert.equal(canToggleSkillManagementEntry(entry('ok', 'eligible')), true);
    assert.equal(canToggleSkillManagementEntry(entry('disabled', 'disabled')), true);
    assert.equal(canToggleSkillManagementEntry(entry('host', 'host_incompatible')), true);
    assert.equal(canToggleSkillManagementEntry(entry('shadowed', 'shadowed')), false);
    assert.equal(canToggleSkillManagementEntry(entry('state', 'state_error')), false);
    assert.equal(canToggleSkillManagementEntry(entry('invalid', 'invalid')), false);
    assert.equal(
      canToggleSkillManagementEntry(
        entry('blocked', 'eligible', {
          issues: [{ code: 'blocked_path', severity: 'error', message: 'blocked' }],
        }),
      ),
      false,
    );
  });

  test('searches id, name, description, and source while preserving source precedence', () => {
    const entries = [
      entry('user', 'eligible', { discoveryOrigin: 'user_agents', name: 'Writer' }),
      entry('project', 'eligible', { discoveryOrigin: 'project_maka', name: 'Writer' }),
    ];
    assert.deepEqual(
      filterSkillManagementEntries(entries, 'all', 'writer').map((candidate) => candidate.id),
      ['project', 'user'],
    );
    assert.deepEqual(
      filterSkillManagementEntries(entries, 'all', '用户 · 通用').map((candidate) => candidate.id),
      ['user'],
    );
  });

  test('sanitizes local metadata before rendering diagnostics', () => {
    const effective = entry('safe', 'eligible', { name: 'Safe' });
    const shadowed = entry('bad', 'shadowed', {
      name: '\u001b[31mSpoof\u001b[0m',
      shadowedBy: effective.entryKey,
      issues: [{ code: 'duplicate_id', severity: 'error', message: '\u001b[2Jclear' }],
    });
    const text = formatSkillDiagnostic(shadowed, [shadowed, effective]);
    assert.doesNotMatch(text, /\u001b|\u202e/);
    assert.match(text, /实际生效项：Safe/);
    assert.match(text, /声明工具仅表示请求，不代表已经获得权限/);
    assert.equal(sanitizeSkillTerminalText('a\u202eb\n c'), 'a b c');
  });

  test('derives template activation state from the shared workspace discovery layer', () => {
    const templates: BundledSkillTemplateSource[] = [
      template('available'),
      template('active'),
      template('attention'),
    ];
    const discovered = [
      entry('active', 'eligible', { discoveryOrigin: 'workspace' }),
      entry('attention', 'state_error', { discoveryOrigin: 'workspace' }),
      entry('available', 'eligible', { discoveryOrigin: 'project_maka' }),
    ];
    const states = Object.fromEntries(
      buildSkillTemplateManagementEntries(templates, discovered).map((candidate) => [
        candidate.id,
        candidate.activationState,
      ]),
    );
    assert.deepEqual(states, {
      active: 'active',
      attention: 'attention',
      available: 'available',
    });
    assert.deepEqual(
      filterSkillTemplateManagementEntries(
        buildSkillTemplateManagementEntries(templates, discovered),
        '',
      ).map((candidate) => candidate.id),
      ['available'],
    );
  });

  test('renders non-selectable scope headings while arrows visit only entries', () => {
    const terminal = new FakeTerminal();
    const tui = new TUI(terminal);
    let selected = '';
    const overlay = new SkillManagementOverlay(tui, {
      entries: [
        entry('user', 'eligible', { discoveryOrigin: 'user_agents' }),
        entry('workspace', 'eligible', { discoveryOrigin: 'workspace' }),
        entry('project', 'eligible', { discoveryOrigin: 'project_maka' }),
      ],
      onSelect: (candidate) => {
        selected = candidate.id;
      },
      onCancel: () => {},
    });
    const rendered = overlay.render(80).join('\n');
    assert.match(rendered, /项目级 Skill/);
    assert.match(rendered, /Maka 工作区 Skill/);
    assert.match(rendered, /用户级 Skill/);
    overlay.handleInput('\x1b[B');
    overlay.handleInput('\r');
    assert.equal(selected, 'workspace');
  });

  test('renders discovered and template search overlays at 80 and 120 columns', () => {
    const terminal = new FakeTerminal();
    const tui = new TUI(terminal);
    const discovered = new SkillManagementOverlay(tui, {
      entries: [entry('alpha', 'eligible')],
      onSelect: () => {},
      onCancel: () => {},
    });
    const templates = new SkillTemplateManagementOverlay(tui, {
      entries: buildSkillTemplateManagementEntries(
        [template('beta'), template('active')],
        [entry('active', 'eligible', { discoveryOrigin: 'workspace' })],
      ),
      onSelect: () => {},
      onCancel: () => {},
    });

    for (const width of [80, 120]) {
      for (const line of [...discovered.render(width), ...templates.render(width)]) {
        assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
      }
    }
    assert.match(
      formatSkillTemplateReview(buildSkillTemplateManagementEntries([template('beta')], [])[0]!),
      /不会授予工具权限/,
    );
    assert.doesNotMatch(templates.render(80).join('\n'), /active/);
  });
});

function template(id: string): BundledSkillTemplateSource {
  return {
    id,
    sourceName: 'maka-bundled',
    body: `---\nname: ${id}\ndescription: ${id} description\nallowed-tools: [Read]\n---\n# ${id}`,
  };
}

function entry(
  id: string,
  operationalStatus: SkillInspectionEntry['operationalStatus'],
  overrides: Partial<SkillInspectionEntry> = {},
): SkillInspectionEntry {
  return {
    entryKey: `workspace:${id}`,
    id,
    name: id,
    description: `${id} description`,
    path: `/repo/skills/${id}`,
    discoveryOrigin: 'workspace',
    effective: operationalStatus !== 'shadowed' && operationalStatus !== 'invalid',
    metadataStatus: operationalStatus === 'invalid' ? 'invalid' : 'valid',
    operationalStatus,
    issues: [],
    declaredTools: [],
    requiredTools: [],
    requiredCapabilities: [],
    missingDeclaredTools: [],
    missingRequiredTools: [],
    missingRequiredCapabilities: [],
    enabled: operationalStatus !== 'disabled',
    runtimeStatus:
      operationalStatus === 'state_error'
        ? 'state_error'
        : operationalStatus === 'disabled'
          ? 'disabled'
          : 'enabled',
    ...overrides,
  };
}
