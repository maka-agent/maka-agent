import type { ipcMain as electronIpcMain } from "electron";
import { comparePricingModelKeys } from "@maka/core/usage-stats/pricing";
import {
  decodePricingMutateInput,
  decodePricingQueryResult,
  PRICING_PAGE_MAX_ITEMS,
  type EffectivePricingEntry,
} from "@maka/runtime-host/protocol";
import type {
  DesktopPricingMutationInput,
  DesktopPricingSnapshot,
} from "../shared/runtime-host-pricing.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

interface RuntimeHostPricingIpcDeps {
  readonly ipcMain: Pick<typeof electronIpcMain, "handle">;
  readonly client: Pick<
    DesktopRuntimeHostClient,
    "loadPricingSnapshot" | "applyPricingMutation"
  >;
}

export function registerRuntimeHostPricingIpc(
  deps: RuntimeHostPricingIpcDeps,
): void {
  deps.ipcMain.handle("settings:pricing:load", () =>
    deps.client.loadPricingSnapshot(),
  );
  deps.ipcMain.handle(
    "settings:pricing:mutate",
    (_event, input: unknown) =>
      deps.client.applyPricingMutation(
        decodeDesktopPricingMutationInput(input),
      ),
  );
}

export function decodeDesktopPricingMutationInput(
  value: unknown,
): DesktopPricingMutationInput {
  const input = requireRecord(value, "pricing mutation input");
  const base = decodeDesktopPricingSnapshot(input.base);
  const mutation = decodePricingMutateInput({
    expectedRevision: base.revision,
    mutation: input.mutation,
  });
  return { base, mutation: mutation.mutation };
}

function decodeDesktopPricingSnapshot(value: unknown): DesktopPricingSnapshot {
  const snapshot = requireRecord(value, "pricing snapshot");
  const hostEpoch = requireNonEmptyString(snapshot.hostEpoch, "pricing host epoch");
  const connectionId = requireNonEmptyString(
    snapshot.connectionId,
    "pricing connection id",
  );
  const revision = requireCount(snapshot.revision, "pricing revision");
  if (!Array.isArray(snapshot.entries)) {
    throw new TypeError("Invalid pricing snapshot entries");
  }

  const entries: EffectivePricingEntry[] = [];
  for (
    let offset = 0;
    offset < snapshot.entries.length || offset === 0;
    offset += PRICING_PAGE_MAX_ITEMS
  ) {
    const pageEntries = snapshot.entries.slice(
      offset,
      offset + PRICING_PAGE_MAX_ITEMS,
    );
    const page = decodePricingQueryResult({
      kind: "page",
      revision,
      offset,
      entries: pageEntries,
      nextOffset:
        offset + pageEntries.length < snapshot.entries.length
          ? offset + pageEntries.length
          : null,
    });
    if (page.kind !== "page") {
      throw new TypeError("Invalid pricing snapshot page");
    }
    entries.push(...page.entries);
    if (page.nextOffset === null) break;
  }

  for (let index = 1; index < entries.length; index += 1) {
    if (
      comparePricingModelKeys(
        entries[index - 1]!.pricing.modelKey,
        entries[index]!.pricing.modelKey,
      ) >= 0
    ) {
      throw new TypeError("Pricing snapshot entries are not canonically ordered");
    }
  }

  return { hostEpoch, connectionId, revision, entries };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function requireCount(value: unknown, label: string): number {
  const count = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`Invalid ${label}`);
  }
  return count;
}
