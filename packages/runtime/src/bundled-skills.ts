import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUNDLED_REVERSE_ENGINEERED_SKILLS } from './bundled-skill-catalog.generated.js';
import { isPathInside, isSafeSkillId } from './path-containment.js';

export const BUNDLED_OFFICE_SKILL_SOURCE_NAME = 'maka-officecli';
export const BUNDLED_CATALOG_SOURCE_NAME = 'maka-bundled';
export const BUNDLED_SKILL_SOURCE_VERSION = '1';

export interface BundledSkillTemplateSource {
  id: string;
  body: string;
  sourceName: typeof BUNDLED_OFFICE_SKILL_SOURCE_NAME | typeof BUNDLED_CATALOG_SOURCE_NAME;
}

export const BUNDLED_OFFICE_SKILLS: ReadonlyArray<BundledSkillTemplateSource> = [
  {
    id: 'officecli-docx',
    body: officeCliDocxSkillTemplate(),
    sourceName: BUNDLED_OFFICE_SKILL_SOURCE_NAME,
  },
  {
    id: 'officecli-xlsx',
    body: officeCliXlsxSkillTemplate(),
    sourceName: BUNDLED_OFFICE_SKILL_SOURCE_NAME,
  },
  {
    id: 'officecli-pptx',
    body: officeCliPptxSkillTemplate(),
    sourceName: BUNDLED_OFFICE_SKILL_SOURCE_NAME,
  },
];

export const BUNDLED_SKILL_TEMPLATES: ReadonlyArray<BundledSkillTemplateSource> = [
  ...BUNDLED_OFFICE_SKILLS,
  ...BUNDLED_REVERSE_ENGINEERED_SKILLS.map<BundledSkillTemplateSource>((skill) => ({
    ...skill,
    sourceName: BUNDLED_CATALOG_SOURCE_NAME,
  })),
];

export type ActivateBundledSkillTemplateResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'not_found' | 'already_exists' | 'blocked_path' | 'write_failed' };

/**
 * Create one bundled template in the Maka workspace without following symlinks
 * or replacing an existing copy. Desktop and CLI call this exact service so
 * activation has one path-safety and lock-file contract.
 */
export async function activateBundledSkillTemplate(
  root: string,
  id: string,
): Promise<ActivateBundledSkillTemplateResult> {
  if (!isSafeSkillId(id)) return { ok: false, reason: 'not_found' };
  const template = BUNDLED_SKILL_TEMPLATES.find((candidate) => candidate.id === id);
  if (!template) return { ok: false, reason: 'not_found' };

  const skillsDir = join(root, 'skills');
  let skillsReal: string;
  try {
    await mkdir(skillsDir, { recursive: true, mode: 0o700 });
    const skillsStat = await lstat(skillsDir);
    if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) {
      return { ok: false, reason: 'blocked_path' };
    }
    const rootReal = await realpath(root);
    skillsReal = await realpath(skillsDir);
    if (!isPathInside(rootReal, skillsReal)) return { ok: false, reason: 'blocked_path' };
  } catch {
    return { ok: false, reason: 'write_failed' };
  }

  const skillDir = join(skillsDir, id);
  let createdSkillDir = false;
  try {
    await mkdir(skillDir, { mode: 0o700 });
    createdSkillDir = true;
    const skillReal = await realpath(skillDir);
    if (!isPathInside(skillsReal, skillReal)) {
      await rm(skillDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, reason: 'blocked_path' };
    }

    await writeFile(join(skillDir, 'SKILL.md'), template.body, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await writeFile(
      join(skillDir, 'skill.lock.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id,
          sourceType: 'bundled',
          sourceName: template.sourceName,
          sourceVersion: BUNDLED_SKILL_SOURCE_VERSION,
          contentSha256: `sha256:${createHash('sha256').update(template.body).digest('hex')}`,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    return { ok: true, id };
  } catch (error) {
    if (createdSkillDir) await rm(skillDir, { recursive: true, force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, reason: 'already_exists' };
    }
    return { ok: false, reason: 'write_failed' };
  }
}

function officeCliDocxSkillTemplate(): string {
  return `---
name: OfficeCLI DOCX
description: Use when a .docx, Word document, report, memo, proposal, letter, tracked changes, comments, header/footer, table of contents, or Word template is involved.
allowed-tools:
  - OfficeDocument
  - OfficeDocumentEdit
  - Read
required-tools:
  - OfficeDocument
  - OfficeDocumentEdit
---

# OfficeCLI DOCX

Use this skill for Word document work. Route document inspection and edits through Maka's bounded Office document tools.

## Boundary

- Use \`OfficeDocument\` for read-only inspection: \`help\`, \`view\`, \`get\`, \`query\`, and \`validate\`.
- Use \`OfficeDocumentEdit\` only for supported writes: \`create\`, \`add\`, \`set\`, and \`remove\`. It is permission-gated and path-bound to the session cwd.
- Do not call Bash or raw \`officecli\` directly unless the user explicitly asks for shell-level debugging and the normal permission flow allows it.
- Prefer \`OfficeDocument\` \`help\` with \`topic: "docx"\` before guessing selectors or properties. Installed help is authoritative.
- Quote semantic paths: \`"/body/p[1]"\`, \`"/footer[1]"\`.
- Unsupported paths stay unsupported: no resident \`open\`/\`close\`, \`html\` view, \`raw\`, \`watch\`, or \`batch\`.

## Workflow

1. Orient with \`OfficeDocument\` \`view\` \`outline\`, then \`view\` \`text\` or \`get\` the needed paths.
2. For edits, use \`OfficeDocumentEdit\` in small steps and verify each structural step with \`OfficeDocument\` \`get\` or \`view\`.
3. For generated documents, build hierarchy first: Title, Heading 1, Heading 2, body; then tables/images/fields; then headers/footers.
4. Use explicit typography. Body 11-12pt; H1 at least 18pt; H2 around 14pt; spacing via paragraph properties, not blank paragraphs.
5. Add live page-number fields for documents longer than one page when the installed adapter supports the needed field properties. Verify fields with \`OfficeDocument\` \`get\` on \`"/footer[1]"\` at bounded depth.
6. Final QA: \`OfficeDocument\` \`validate\` plus \`view\` \`outline\`, \`stats\`, \`issues\`, or \`annotated\`. Fix placeholder tokens, clipped tables, empty-paragraph spacing, static page numbers, and missing TOC on heading-heavy documents before reporting done.
`;
}

function officeCliXlsxSkillTemplate(): string {
  return `---
name: OfficeCLI XLSX
description: Use when a .xlsx, Excel workbook, spreadsheet, CSV/TSV import, tracker, dashboard, financial model, formula, chart, pivot table, or worksheet template is involved.
allowed-tools:
  - OfficeDocument
  - OfficeDocumentEdit
  - Read
required-tools:
  - OfficeDocument
  - OfficeDocumentEdit
---

# OfficeCLI XLSX

Use this skill for spreadsheet work. Route workbook inspection and edits through Maka's bounded Office document tools.

## Boundary

- Use \`OfficeDocument\` for read-only inspection: \`help\`, \`view\`, \`get\`, \`query\`, and \`validate\`.
- Use \`OfficeDocumentEdit\` only for supported writes: \`create\`, \`add\`, \`set\`, and \`remove\`. It is permission-gated and path-bound to the session cwd.
- Do not call Bash or raw \`officecli\` directly unless the user explicitly asks for shell-level debugging and the normal permission flow allows it.
- Prefer \`OfficeDocument\` \`help\` with \`topic: "xlsx"\` before guessing selectors or properties. Installed help is authoritative.
- Quote paths such as \`"/Sheet1/A1"\`, \`"/Sheet1/col[B]"\`, and \`"/Sheet1/row[1]"\`.
- Single-quote values containing \`$\`, especially number formats: \`--prop numFmt='$#,##0'\`.
- Unsupported paths stay unsupported: no resident \`open\`/\`close\`, \`html\` view, \`raw\`, \`watch\`, or \`batch\`.

## Workflow

1. Orient with \`OfficeDocument\` \`view\` \`outline\`; use \`view\` \`text\`, \`get\`, and \`query\` for targeted inspection.
2. For CSV/TSV, prefer native import, then set widths and number formats.
3. For generated workbooks, create sheets, enter assumptions, formulas, formats, charts, then validate.
4. Use formulas rather than hardcoded derived values. Put assumptions in cells and cite sources in adjacent notes or comments.
5. Set readable widths explicitly; default Excel widths often render as \`###\`.
6. Financial-model convention: blue font for hardcoded inputs, black for formulas, green for same-workbook links, red for external links, yellow fill for assumptions needing review.
7. Final QA: \`OfficeDocument\` \`validate\` plus \`view\` \`outline\`, \`stats\`, \`issues\`, or \`annotated\`. Fix formula errors, \`###\`, truncated headers, hidden assumptions, placeholder tokens, and chart labels before reporting done.
`;
}

function officeCliPptxSkillTemplate(): string {
  return `---
name: OfficeCLI PPTX
description: Use when a .pptx, slide deck, presentation, pitch deck, speaker notes, layout, chart, template, or slides file is involved.
allowed-tools:
  - OfficeDocument
  - OfficeDocumentEdit
  - Read
required-tools:
  - OfficeDocument
  - OfficeDocumentEdit
---

# OfficeCLI PPTX

Use this skill for presentation work. Route deck inspection and edits through Maka's bounded Office document tools.

## Boundary

- Use \`OfficeDocument\` for read-only inspection: \`help\`, \`view\`, \`get\`, \`query\`, and \`validate\`.
- Use \`OfficeDocumentEdit\` only for supported writes: \`create\`, \`add\`, \`set\`, and \`remove\`. It is permission-gated and path-bound to the session cwd.
- Do not call Bash or raw \`officecli\` directly unless the user explicitly asks for shell-level debugging and the normal permission flow allows it.
- Prefer \`OfficeDocument\` \`help\` with \`topic: "pptx"\` before guessing selectors or properties. Installed help is authoritative.
- Quote paths such as \`"/slide[1]"\` and \`"/slide[1]/shape[2]"\`.
- Single-quote text containing \`$\`: \`--prop text='$15M ARR'\`.
- Unsupported paths stay unsupported: no resident \`open\`/\`close\`, \`html\` view, \`raw\`, \`watch\`, or \`batch\`.

## Workflow

1. Orient with \`OfficeDocument\` \`view\` \`outline\`, \`view\` \`text\`, and targeted \`get\` calls.
2. For generated decks, use one idea per slide. Dense multi-topic slides should be split.
3. Set explicit type hierarchy: titles at least 36pt, body text at least 18pt, captions 10-12pt.
4. Use two fonts max and one coherent palette. Every content slide should carry a non-text visual: chart, shape, icon, screenshot, or image region.
5. Add speaker notes to content slides.
6. Check layout math. For 16:9 slides, keep shapes inside 33.87cm x 19.05cm and maintain edge margins.
7. Final QA: \`OfficeDocument\` \`validate\` plus \`view\` \`outline\`, \`stats\`, \`issues\`, or \`annotated\`. Fix placeholders, overflow, clipped text, low contrast, bullet-only slides, and missing notes before reporting done.
`;
}
