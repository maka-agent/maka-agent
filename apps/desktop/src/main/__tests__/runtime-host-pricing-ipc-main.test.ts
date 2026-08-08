import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { registerRuntimeHostPricingIpc } from "../runtime-host-pricing-ipc-main.js";

type Handler = (event: unknown, ...args: any[]) => unknown;

describe("Runtime Host Pricing IPC", () => {
  test("forwards Host snapshots and normalizes mutation inputs", async () => {
    const handlers = new Map<string, Handler>();
    const snapshot = {
      hostEpoch: "epoch",
      connectionId: "connection",
      revision: 3,
      entries: [],
    };
    let received: unknown;
    const outcome = {
      kind: "reconciliation_unavailable",
      reason: "outcome_unknown",
    } as const;
    const client = {
      async loadPricingSnapshot() {
        return snapshot;
      },
      async applyPricingMutation(input: unknown) {
        received = input;
        return outcome;
      },
    };
    register(handlers, client);

    assert.deepEqual(
      await handlers.get("settings:pricing:load")?.({}),
      snapshot,
    );
    assert.deepEqual(
      await handlers.get("settings:pricing:mutate")?.(
        {},
        {
          base: snapshot,
          mutation: { kind: "delete", modelKey: "provider:model" },
        },
      ),
      outcome,
    );
    assert.deepEqual(received, {
      base: snapshot,
      mutation: { kind: "delete", modelKey: "provider:model" },
    });
  });

  test("rejects a mutation whose base snapshot is malformed", async () => {
    const handlers = new Map<string, Handler>();
    register(handlers, {
      async loadPricingSnapshot() {
        return { hostEpoch: "epoch", connectionId: "connection", revision: 0, entries: [] };
      },
      async applyPricingMutation() {
        throw new Error("must not reach Host client");
      },
    });
    const mutate = handlers.get("settings:pricing:mutate")!;

    await assert.rejects(
      async () => mutate({}, {
        base: {
          hostEpoch: "",
          connectionId: "connection",
          revision: 0,
          entries: [],
        },
        mutation: { kind: "delete", modelKey: "provider:model" },
      }),
      /Invalid pricing host epoch/,
    );
  });
});

function register(handlers: Map<string, Handler>, client: object): void {
  registerRuntimeHostPricingIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as Handler);
      },
    },
    client: client as never,
  });
}
