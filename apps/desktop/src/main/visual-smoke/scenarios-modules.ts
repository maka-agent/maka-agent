import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson } from './seed-helpers.js';

/**
 * MCP module fixture: seeds an mcp.json with a couple of installed servers so
 * the 已安装 tab and the server rows render for the alignment auditor + CDP
 * capture. Both are `enabled: false` so no real `npx` / HTTP connection is
 * attempted in visual-smoke mode — the rows render deterministically in the
 * neutral 已停用 state (exception-only status: no color unless a real failure).
 * The 市场 tab is the default surface and is driven by the static MCP_CATALOG,
 * so it renders without any on-disk seed.
 */
export async function seedMcpFixture(workspaceRoot: string): Promise<void> {
  const config = {
    version: 1,
    mcpServers: {
      filesystem: {
        enabled: false,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace/maka'],
      },
      'linear-remote': {
        enabled: false,
        url: 'https://mcp.linear.app/sse',
        transport: 'sse',
      },
    },
  };
  await writeJson(join(workspaceRoot, 'mcp.json'), config);
}

/** Seeds project/workspace/user lifecycle examples for the Skills page. */
export async function seedSkillsFixture(workspaceRoot: string): Promise<void> {
  async function writeSkill(
    skillsRoot: string,
    skill: { id: string; name: string; description?: string; requiredTools?: string[] },
  ): Promise<void> {
    const dir = join(skillsRoot, skill.id);
    await mkdir(dir, { recursive: true });
    const content = [
      '---',
      `name: ${skill.name}`,
      ...(skill.description ? [`description: ${skill.description}`] : []),
      ...(skill.requiredTools?.length ? [`required-tools: [${skill.requiredTools.join(', ')}]`] : []),
      '---',
      '',
      `# ${skill.name}`,
      '',
      skill.description ?? '这是一个故意缺少 description 的视觉测试样例。',
      '',
    ].join('\n');
    await writeFile(join(dir, 'SKILL.md'), content, { encoding: 'utf8', mode: 0o600 });
  }

  const workspaceSkillsRoot = join(workspaceRoot, 'skills');
  await writeSkill(workspaceSkillsRoot, {
    id: 'meeting-followup',
    name: '会议跟进',
    description: '从会议记录里抽取决定、风险和 owner，生成下一步任务清单。',
  });
  await writeSkill(workspaceSkillsRoot, {
    id: 'daily-standup',
    name: '每日站会（工作区副本）',
    description: '低优先级副本，用于展示同名 id 被项目级 Skill 覆盖。',
  });
  await writeSkill(workspaceSkillsRoot, {
    id: 'visual-tool-required',
    name: '需要额外工具',
    description: '用于展示宿主缺少必需工具时的精确原因。',
    requiredTools: ['VisualSmokeMissingTool'],
  });
  await writeSkill(workspaceSkillsRoot, {
    id: 'paused-helper',
    name: '已停用助手',
    description: '用于展示用户主动停用后的生命周期状态。',
  });
  await writeSkill(workspaceSkillsRoot, {
    id: 'broken-metadata',
    name: '元数据异常样例',
  });

  await writeSkill(join(workspaceRoot, '.visual-project', '.maka', 'skills'), {
    id: 'daily-standup',
    name: '每日站会',
    description: '项目级高优先级副本，用于展示来源优先级。',
  });
  await writeSkill(join(workspaceRoot, '.visual-home', '.agents', 'skills'), {
    id: 'personal-notes',
    name: '个人笔记助手',
    description: '用于展示可读但不由当前工作区管理的用户级 Skill。',
  });
  await mkdir(join(workspaceRoot, '.maka'), { recursive: true });
  await writeFile(
    join(workspaceRoot, '.maka', 'skills-state.json'),
    `${JSON.stringify({ schemaVersion: 1, skills: { 'paused-helper': { enabled: false } } }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}
