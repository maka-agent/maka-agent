import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { validateSkillMetadata, type ScannedSkill } from '@maka/runtime';
import {
  SKILL_CATALOG_PAGE_MAX_BYTES,
  SKILL_CATALOG_PAGE_MAX_ITEMS,
  SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES,
  type OperationOutcome,
  type SkillCatalogDiagnostic,
  type SkillCatalogEntry,
  type SkillCatalogItem,
  type SkillCatalogMutateInput,
  type SkillCatalogQueryInput,
  type SkillCatalogQueryResult,
  type SkillCatalogRefreshInput,
  type SkillCatalogRevision,
  type SkillCatalogSourceEntry,
} from '../protocol/index.js';
import type { SkillCatalogOperationHandlerMap } from './operation-dispatcher.js';
import {
  HostSkillCatalogFilesystem,
  HostSkillCatalogFilesystemError,
  type HostInstalledSkill,
  type HostSkillCatalogDiagnostic,
  type HostSkillFilesystemSnapshot,
  type HostSkillSource,
} from './skill-catalog-filesystem.js';

interface CanonicalSkillCatalogSnapshot {
  readonly revision: SkillCatalogRevision;
  readonly installed: readonly SkillCatalogEntry[];
  readonly sources: readonly SkillCatalogSourceEntry[];
  readonly diagnostics: readonly SkillCatalogDiagnostic[];
  readonly modelSkills: readonly ScannedSkill[];
  readonly filesystem: HostSkillFilesystemSnapshot;
}

type SkillCatalogCommandOutcome<K extends 'skill.catalog.refresh' | 'skill.catalog.mutate'> =
  OperationOutcome<K>;

/** Serialized Host control-plane owner over one immutable root Skill projection. */
export class HostSkillCatalogCoordinator {
  readonly handlers: SkillCatalogOperationHandlerMap = {
    'skill.catalog.query': (input) => this.#query(input),
    'skill.catalog.refresh': (input) => this.#refresh(input),
    'skill.catalog.mutate': (input) => this.#mutate(input),
    'skill.catalog.preview-update': (input) => this.#preview(input),
  };

  readonly #filesystem: HostSkillCatalogFilesystem;
  #snapshot: CanonicalSkillCatalogSnapshot | undefined;
  #projectionUncertain = false;
  #accepting = true;
  #commandTail: Promise<void> = Promise.resolve();

  constructor(filesystem: HostSkillCatalogFilesystem) {
    this.#filesystem = filesystem;
  }

  async recover(): Promise<void> {
    await this.#filesystem.recover();
    this.#snapshot = createCanonicalSnapshot(await this.#filesystem.scan());
    this.#projectionUncertain = false;
  }

  /** Model-facing Skill scan derived only from the recovered canonical snapshot. */
  readCanonicalModelSkills(): readonly ScannedSkill[] {
    if (this.#projectionUncertain) {
      throw new Error('Skill catalog projection is uncertain after a committed write');
    }
    return this.#requireSnapshot().modelSkills;
  }

  beginDrain(): void {
    this.#accepting = false;
  }

  async close(): Promise<void> {
    this.beginDrain();
    await this.#commandTail;
  }

  async #query(input: SkillCatalogQueryInput): Promise<OperationOutcome<'skill.catalog.query'>> {
    if (this.#projectionUncertain) {
      return projectionUnavailable('Skill catalog projection is uncertain after a committed write');
    }
    const snapshot = this.#requireSnapshot();
    if (input.kind === 'continue' && input.revision !== snapshot.revision) {
      return {
        ok: true,
        result: {
          kind: 'revision_changed',
          expectedRevision: input.revision,
          actualRevision: snapshot.revision,
        },
      };
    }
    const items = itemsForView(snapshot, input.view);
    const offset = input.kind === 'start' ? 0 : decodeCursor(input.cursor, input.view);
    if (offset === undefined || offset > items.length) {
      return invalidRequest('Skill catalog cursor is invalid');
    }
    return {
      ok: true,
      result: createPage(snapshot.revision, input.view, items, offset),
    };
  }

  #refresh(
    input: SkillCatalogRefreshInput,
  ): Promise<SkillCatalogCommandOutcome<'skill.catalog.refresh'>> {
    return this.#runCommand(async () => {
      if (this.#projectionUncertain) {
        try {
          await this.#filesystem.recover();
          const recovered = createCanonicalSnapshot(await this.#filesystem.scan());
          this.#snapshot = recovered;
          this.#projectionUncertain = false;
          return {
            ok: true,
            result:
              input.expectedRevision === recovered.revision
                ? { kind: 'unchanged', revision: recovered.revision }
                : revisionConflict(input.expectedRevision, recovered.revision),
          };
        } catch (error) {
          return filesystemFailure(error, 'Skill catalog recovery refresh failed');
        }
      }
      const current = this.#requireSnapshot();
      if (input.expectedRevision !== current.revision) {
        return {
          ok: true,
          result: revisionConflict(input.expectedRevision, current.revision),
        };
      }
      try {
        const next = createCanonicalSnapshot(await this.#filesystem.scan());
        if (next.revision === current.revision) {
          return { ok: true, result: { kind: 'unchanged', revision: current.revision } };
        }
        this.#snapshot = next;
        return { ok: true, result: { kind: 'committed', revision: next.revision } };
      } catch (error) {
        return filesystemFailure(error, 'Skill catalog refresh failed');
      }
    });
  }

  #mutate(
    input: SkillCatalogMutateInput,
  ): Promise<SkillCatalogCommandOutcome<'skill.catalog.mutate'>> {
    return this.#runCommand(async () => {
      if (this.#projectionUncertain) {
        return commitOutcomeUnknown(
          'Skill catalog projection is uncertain after a committed write; refresh is required',
        );
      }
      const current = this.#requireSnapshot();
      if (input.expectedRevision !== current.revision) {
        return {
          ok: true,
          result: revisionConflict(input.expectedRevision, current.revision),
        };
      }

      try {
        const mutation = input.mutation;
        const outcome =
          mutation.kind === 'create_starter'
            ? await this.#filesystem.createStarter(current.filesystem)
            : mutation.kind === 'install'
              ? await this.#filesystem.install(current.filesystem, mutation)
              : mutation.kind === 'update_managed'
                ? await this.#filesystem.updateManaged(current.filesystem, mutation)
                : mutation.kind === 'delete'
                  ? await this.#filesystem.delete(current.filesystem, mutation.skillId)
                  : await this.#filesystem.setEnabled(
                      current.filesystem,
                      mutation.skillId,
                      mutation.enabled,
                    );
        if (!outcome.ok) {
          return { ok: true, result: { kind: 'rejected', reason: outcome.reason } };
        }
        if (!outcome.changed) {
          return {
            ok: true,
            result: {
              kind: 'unchanged',
              revision: current.revision,
              entry: current.installed.find((skill) => skill.id === outcome.skillId) ?? null,
            },
          };
        }

        let next: CanonicalSkillCatalogSnapshot;
        try {
          next = createCanonicalSnapshot(await this.#filesystem.scan());
        } catch (error) {
          await this.#reconcileAfterUnknown();
          return commitOutcomeUnknown(
            'Skill catalog changed but its projection could not be published',
          );
        }
        this.#snapshot = next;
        return {
          ok: true,
          result: {
            kind: next.revision === current.revision ? 'unchanged' : 'committed',
            revision: next.revision,
            entry: next.installed.find((skill) => skill.id === outcome.skillId) ?? null,
          },
        };
      } catch (error) {
        if (
          error instanceof HostSkillCatalogFilesystemError &&
          error.code === 'commit_outcome_unknown'
        ) {
          await this.#reconcileAfterUnknown();
        }
        return filesystemFailure(error, 'Skill catalog mutation failed');
      }
    });
  }

  async #preview(input: {
    readonly skillId: string;
    readonly expectedRevision: SkillCatalogRevision;
  }): Promise<OperationOutcome<'skill.catalog.preview-update'>> {
    if (this.#projectionUncertain) {
      return projectionUnavailable('Skill catalog projection is uncertain after a committed write');
    }
    const snapshot = this.#requireSnapshot();
    if (input.expectedRevision !== snapshot.revision) {
      return {
        ok: true,
        result: revisionConflict(input.expectedRevision, snapshot.revision),
      };
    }
    const preview = this.#filesystem.previewManaged(snapshot.filesystem, input.skillId);
    if (!preview.ok) {
      return { ok: true, result: { kind: 'rejected', reason: preview.reason } };
    }
    const result = {
      kind: 'preview' as const,
      revision: snapshot.revision,
      ...preview.preview,
    };
    if (
      Buffer.byteLength(JSON.stringify(result), 'utf8') > SKILL_CATALOG_PREVIEW_RESULT_MAX_BYTES
    ) {
      return { ok: true, result: { kind: 'rejected', reason: 'preview_too_large' } };
    }
    return { ok: true, result };
  }

  #runCommand<K extends 'skill.catalog.refresh' | 'skill.catalog.mutate'>(
    operation: () => Promise<SkillCatalogCommandOutcome<K>>,
  ): Promise<SkillCatalogCommandOutcome<K>> {
    if (!this.#accepting) {
      return Promise.resolve({
        ok: false,
        error: { code: 'host_draining', message: 'Runtime Host is draining' },
      } as SkillCatalogCommandOutcome<K>);
    }
    const pending = this.#commandTail.then(operation, operation);
    this.#commandTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #reconcileAfterUnknown(): Promise<void> {
    try {
      await this.#filesystem.recover();
      this.#snapshot = createCanonicalSnapshot(await this.#filesystem.scan());
      this.#projectionUncertain = false;
    } catch {
      this.#projectionUncertain = true;
    }
  }

  #requireSnapshot(): CanonicalSkillCatalogSnapshot {
    if (!this.#snapshot) throw new Error('Skill catalog is not recovered');
    return this.#snapshot;
  }
}

function createCanonicalSnapshot(
  filesystem: HostSkillFilesystemSnapshot,
): CanonicalSkillCatalogSnapshot {
  const hostDiagnostics: HostSkillCatalogDiagnostic[] = [...filesystem.diagnostics];
  const installed = Object.freeze(
    filesystem.installed.flatMap((skill) => {
      const entry = toCatalogEntry(skill);
      if (fitsSingleItemPage('installed', entry)) return [entry];
      hostDiagnostics.push({
        scope: 'installed',
        id: skill.id,
        codes: ['projection_too_large'],
      });
      return [];
    }),
  );
  const sources = Object.freeze(
    filesystem.sources.flatMap((source) => {
      const entry = toSourceEntry(source, isSourceInstalled(source, filesystem.installed));
      if (fitsSingleItemPage('sources', entry)) return [entry];
      hostDiagnostics.push({
        scope: 'source',
        id: source.id,
        codes: ['projection_too_large'],
      });
      return [];
    }),
  );
  const diagnostics = Object.freeze(
    hostDiagnostics
      .map(toCatalogDiagnostic)
      .sort(
        (left, right) => left.scope.localeCompare(right.scope) || left.id.localeCompare(right.id),
      ),
  );
  const modelSkills = Object.freeze(filesystem.installed.map(toScannedSkill));
  const revision = digestRevision({ installed, sources, diagnostics });
  return Object.freeze({ revision, installed, sources, diagnostics, modelSkills, filesystem });
}

function toScannedSkill(skill: HostInstalledSkill): ScannedSkill {
  const validation = validateSkillMetadata(skill.content);
  if (!validation.valid) {
    throw new Error(`Canonical Skill ${skill.id} is no longer valid`);
  }
  const declaredTools = [...skill.declaredTools];
  const requiredTools = [...skill.requiredTools];
  const requiredCapabilities = [...skill.requiredCapabilities];
  Object.freeze(declaredTools);
  Object.freeze(requiredTools);
  Object.freeze(requiredCapabilities);
  return Object.freeze({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    declaredTools,
    requiredTools,
    requiredCapabilities,
    enabled: skill.enabled,
    runtimeStatus: skill.runtimeStatus,
    content: validation.body,
    contentSha256: skill.contentSha256,
    discoveryRoot: dirname(dirname(skill.path)),
  });
}

function isSourceInstalled(
  source: HostSkillSource,
  installed: readonly HostInstalledSkill[],
): boolean {
  return installed.some((skill) =>
    source.sourceType === 'bundled'
      ? skill.ownerKind === 'bundled' && skill.id === source.id
      : skill.ownerKind === 'managed' && skill.sourceId === source.id,
  );
}

function fitsSingleItemPage(
  view: Extract<SkillCatalogQueryInput['view'], 'installed' | 'sources'>,
  item: SkillCatalogEntry | SkillCatalogSourceEntry,
): boolean {
  return (
    Buffer.byteLength(
      JSON.stringify({
        kind: 'page',
        view,
        revision: `sha256:${'0'.repeat(64)}`,
        items: [item],
        nextCursor: null,
      }),
      'utf8',
    ) <= SKILL_CATALOG_PAGE_MAX_BYTES
  );
}

function toCatalogEntry(skill: HostInstalledSkill): SkillCatalogEntry {
  return Object.freeze({
    kind: 'skill',
    id: skill.id,
    name: skill.name,
    description: skill.description,
    declaredTools: Object.freeze([...skill.declaredTools]),
    requiredTools: Object.freeze([...skill.requiredTools]),
    requiredCapabilities: Object.freeze([...skill.requiredCapabilities]),
    enabled: skill.enabled,
    runtimeStatus: skill.runtimeStatus,
    contentSha256: skill.contentSha256,
    sourceType: skill.sourceType,
    userModified: skill.userModified,
    validationStatus: skill.validationStatus,
    ...(skill.managedUpdateStatus ? { managedUpdateStatus: skill.managedUpdateStatus } : {}),
  });
}

function toSourceEntry(source: HostSkillSource, installed: boolean): SkillCatalogSourceEntry {
  return Object.freeze({
    kind: 'source',
    sourceType: source.sourceType,
    id: source.id,
    name: source.name,
    description: source.description,
    category: source.category,
    contentSha256: source.contentSha256,
    installed,
  });
}

function toCatalogDiagnostic(diagnostic: HostSkillCatalogDiagnostic): SkillCatalogDiagnostic {
  return Object.freeze({
    kind: 'diagnostic',
    scope: diagnostic.scope,
    id: diagnostic.id,
    codes: Object.freeze([...new Set(diagnostic.codes)].sort()),
  });
}

function digestRevision(input: {
  readonly installed: readonly SkillCatalogEntry[];
  readonly sources: readonly SkillCatalogSourceEntry[];
  readonly diagnostics: readonly SkillCatalogDiagnostic[];
}): SkillCatalogRevision {
  return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

function itemsForView(
  snapshot: CanonicalSkillCatalogSnapshot,
  view: SkillCatalogQueryInput['view'],
): readonly SkillCatalogItem[] {
  if (view === 'installed') return snapshot.installed;
  if (view === 'sources') return snapshot.sources;
  return snapshot.diagnostics;
}

function createPage(
  revision: SkillCatalogRevision,
  view: SkillCatalogQueryInput['view'],
  allItems: readonly SkillCatalogItem[],
  offset: number,
): SkillCatalogQueryResult {
  const items: SkillCatalogItem[] = [];
  for (let index = offset; index < allItems.length; index += 1) {
    if (items.length >= SKILL_CATALOG_PAGE_MAX_ITEMS) break;
    const item = allItems[index];
    if (!item) break;
    const candidate = [...items, item];
    const nextOffset = index + 1;
    const candidatePage = {
      kind: 'page' as const,
      view,
      revision,
      items: candidate,
      nextCursor: nextOffset < allItems.length ? encodeCursor(view, nextOffset) : null,
    };
    if (Buffer.byteLength(JSON.stringify(candidatePage), 'utf8') > SKILL_CATALOG_PAGE_MAX_BYTES) {
      if (items.length === 0) throw new Error('Skill catalog item exceeds page capacity');
      break;
    }
    items.push(item);
  }
  const nextOffset = offset + items.length;
  return {
    kind: 'page',
    view,
    revision,
    items,
    nextCursor: nextOffset < allItems.length ? encodeCursor(view, nextOffset) : null,
  };
}

function encodeCursor(view: SkillCatalogQueryInput['view'], offset: number): string {
  return `${view}:${offset}`;
}

function decodeCursor(cursor: string, view: SkillCatalogQueryInput['view']): number | undefined {
  const match = /^(installed|sources|diagnostics):(0|[1-9][0-9]*)$/.exec(cursor);
  if (!match || match[1] !== view) return undefined;
  const offset = Number(match[2]);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

function revisionConflict(
  expectedRevision: SkillCatalogRevision,
  actualRevision: SkillCatalogRevision,
) {
  return { kind: 'revision_conflict' as const, expectedRevision, actualRevision };
}

function invalidRequest(message: string): OperationOutcome<'skill.catalog.query'> {
  return { ok: false, error: { code: 'invalid_request', message } };
}

function projectionUnavailable<K extends 'skill.catalog.query' | 'skill.catalog.preview-update'>(
  message: string,
): OperationOutcome<K> {
  return { ok: false, error: { code: 'internal_failure', message } } as OperationOutcome<K>;
}

function commitOutcomeUnknown(message: string): SkillCatalogCommandOutcome<'skill.catalog.mutate'> {
  return { ok: false, error: { code: 'commit_outcome_unknown', message } };
}

function filesystemFailure<K extends 'skill.catalog.refresh' | 'skill.catalog.mutate'>(
  error: unknown,
  message: string,
): SkillCatalogCommandOutcome<K> {
  if (error instanceof HostSkillCatalogFilesystemError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message:
          error.code === 'commit_outcome_unknown'
            ? 'Skill catalog commit outcome is unknown; query before retrying'
            : 'Skill catalog persistence failed',
      },
    } as SkillCatalogCommandOutcome<K>;
  }
  return {
    ok: false,
    error: { code: 'internal_failure', message },
  } as SkillCatalogCommandOutcome<K>;
}
