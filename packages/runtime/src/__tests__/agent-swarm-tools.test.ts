import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LlmConnection, SessionHeader } from "@maka/core";
import {
	AGENT_SWARM_DEFAULT_CONCURRENCY,
	AGENT_SWARM_MAX_CONCURRENCY,
	AGENT_SWARM_MAX_ITEMS,
	AGENT_SWARM_TOOL_NAME,
	buildAgentSwarmTool,
	type AgentSwarmToolInput,
	type AgentSwarmToolResult,
} from "../agent-swarm-tools.js";
import {
	AGENT_WORKSPACE_SAME_WORKSPACE,
	AGENT_WORKSPACE_WORKTREE,
	AGENT_WRITE_BACK_PATCH,
	AGENT_WRITE_BACK_SUMMARY,
	IMPLEMENTATION_AGENT_PROFILE,
	LOCAL_READ_AGENT_PROFILE,
} from "../agent-catalog.js";
import { buildChildAgentTools, AGENT_TOOL_NAMES } from "../subagent-tools.js";
import type { SpawnChildAgentResult } from "../session-manager.js";
import { PermissionEngine } from "../permission-engine.js";
import {
	MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN,
	ToolRuntime,
	type MakaTool,
	type MakaToolContext,
} from "../tool-runtime.js";

describe("AgentSwarm adapter", () => {
	test("declares a bounded schema and reserves the name without host registration", () => {
		const tool = buildAgentSwarmTool();
		const schema = tool.parameters as {
			safeParse(input: unknown): {
				success: boolean;
				data?: AgentSwarmToolInput;
			};
		};

		assert.equal(tool.name, AGENT_SWARM_TOOL_NAME);
		assert.equal(tool.permissionRequired, true);
		assert.equal(tool.categoryHint, "subagent");
		assert.equal(
			([...AGENT_TOOL_NAMES] as string[]).includes(AGENT_SWARM_TOOL_NAME),
			false,
		);
		assert.deepEqual(
			schema.safeParse({
				items: [
					{
						item_id: "auth",
						profile: LOCAL_READ_AGENT_PROFILE,
						task: "Inspect auth.",
					},
				],
			}).data,
			{
				items: [
					{
						item_id: "auth",
						profile: LOCAL_READ_AGENT_PROFILE,
						task: "Inspect auth.",
					},
				],
				max_concurrency: AGENT_SWARM_DEFAULT_CONCURRENCY,
			},
		);
		assert.equal(
			schema.safeParse({
				items: Array.from({ length: AGENT_SWARM_MAX_ITEMS + 1 }, (_, index) =>
					swarmItem(index),
				),
			}).success,
			false,
		);
		assert.equal(
			schema.safeParse({
				items: [swarmItem(0), swarmItem(0)],
			}).success,
			false,
		);
		assert.equal(
			schema.safeParse({
				items: [swarmItem(0)],
				max_concurrency: AGENT_SWARM_MAX_CONCURRENCY + 1,
			}).success,
			false,
		);
		assert.equal(
			schema.safeParse({
				items: [
					{
						...swarmItem(0),
						write_back: AGENT_WRITE_BACK_PATCH,
					},
				],
			}).success,
			false,
		);
		assert.equal(
			schema.safeParse({
				items: [
					{
						...swarmItem(0),
						isolation: AGENT_WORKSPACE_WORKTREE,
					},
				],
			}).success,
			false,
		);
	});

	test("preflights the complete batch before starting any child", async () => {
		const tool = buildAgentSwarmTool();
		let starts = 0;

		await assert.rejects(
			Promise.resolve(
				tool.impl(
					{
						items: [
							swarmItem(0),
							{
								item_id: "implementation",
								profile: IMPLEMENTATION_AGENT_PROFILE,
								task: "Edit the repository.",
								write_back: AGENT_WRITE_BACK_PATCH,
								isolation: AGENT_WORKSPACE_WORKTREE,
							},
						],
					},
					context({
						spawnChildAgent: async () => {
							starts += 1;
							return childResult(0);
						},
					}),
				),
			),
			/worktree child executor/,
		);
		assert.equal(starts, 0);
	});

	test("fails at the tool boundary when child spawning is unavailable", async () => {
		const tool = buildAgentSwarmTool();

		await assert.rejects(
			Promise.resolve(tool.impl({ items: [swarmItem(0)] }, context())),
			/spawnChildAgent capability is unavailable/,
		);
	});

	test("preserves input order and successful refs across partial failure", async () => {
		const clock = sequence([100, 180]);
		const tool = buildAgentSwarmTool({ now: clock });
		const gates = Array.from({ length: 3 }, () =>
			deferred<SpawnChildAgentResult>(),
		);
		const started: number[] = [];
		const completionOrder: number[] = [];
		const pending = (async () =>
			await tool.impl(
				{
					items: [swarmItem(0), swarmItem(1), swarmItem(2)],
					max_concurrency: 3,
				},
				context({
					spawnChildAgent: async (input) => {
						const index = Number(input.prompt.slice("task-".length));
						started.push(index);
						await input.onReady?.({
							turnId: `turn-${index}`,
							agentId: input.spec.id,
							agentName: input.spec.name,
						});
						const result = await gates[index]!.promise;
						completionOrder.push(index);
						return result;
					},
				}),
			))();

		await waitFor(() => started.length === 3);
		gates[2]!.resolve(childResult(2));
		await waitFor(() => completionOrder.length === 1);
		gates[0]!.resolve(childResult(0));
		await waitFor(() => completionOrder.length === 2);
		gates[1]!.resolve(childResult(1, "failed"));

		const result = await pending;
		assert.deepEqual(completionOrder, [2, 0, 1]);
		assert.equal(result.status, "partial");
		assert.deepEqual(
			result.items.map((item) => ({
				itemId: item.itemId,
				index: item.index,
				runId: item.runId,
				status: item.status,
				summary: item.summary,
			})),
			[
				{
					itemId: "item-0",
					index: 0,
					runId: "run-0",
					status: "completed",
					summary: "summary-0",
				},
				{
					itemId: "item-1",
					index: 1,
					runId: "run-1",
					status: "failed",
					summary: "summary-1",
				},
				{
					itemId: "item-2",
					index: 2,
					runId: "run-2",
					status: "completed",
					summary: "summary-2",
				},
			],
		);
		assert.deepEqual(
			result.items.map((item) => item.artifactIds),
			[["artifact-0"], ["artifact-1"], ["artifact-2"]],
		);
		assert.deepEqual(
			{
				startedAt: result.startedAt,
				completedAt: result.completedAt,
				durationMs: result.durationMs,
			},
			{ startedAt: 100, completedAt: 180, durationMs: 80 },
		);
	});

	test("isolates a thrown child startup while retaining successful siblings", async () => {
		const tool = buildAgentSwarmTool();
		const result = await tool.impl(
			{
				items: [swarmItem(0), swarmItem(1), swarmItem(2)],
				max_concurrency: 2,
			},
			context({
				spawnChildAgent: async (input) => {
					const index = Number(input.prompt.slice("task-".length));
					if (index === 1) throw new Error("provider startup failed");
					await input.onReady?.({
						turnId: `turn-${index}`,
						agentId: input.spec.id,
						agentName: input.spec.name,
					});
					return childResult(index);
				},
			}),
		);

		assert.equal(result.status, "partial");
		assert.deepEqual(
			result.items.map((item) => item.status),
			["completed", "failed", "completed"],
		);
		assert.equal(result.items[1]?.started, false);
		assert.match(result.items[1]?.summary ?? "", /provider startup failed/);
		assert.equal(result.items[1]?.failureClass, "Error");
	});

	test("distinguishes active cancellation from items that never started", async () => {
		const controller = new AbortController();
		const tool = buildAgentSwarmTool();
		const started: number[] = [];
		const pending = invokeAgentSwarm(
			tool,
			{
				items: [swarmItem(0), swarmItem(1), swarmItem(2), swarmItem(3)],
				max_concurrency: 2,
			},
			context({
				abortSignal: controller.signal,
				spawnChildAgent: async (input) => {
					const index = Number(input.prompt.slice("task-".length));
					started.push(index);
					await input.onReady?.({
						turnId: `turn-${index}`,
						agentId: input.spec.id,
						agentName: input.spec.name,
					});
					await onceAborted(controller.signal);
					return childResult(index, "cancelled");
				},
			}),
		);

		await waitFor(() => started.length === 2);
		controller.abort(new Error("parent cancelled"));
		const result = await withTimeout(
			pending,
			"cancelled AgentSwarm did not join active children",
		);

		assert.equal(result.status, "cancelled");
		assert.deepEqual(started, [0, 1]);
		assert.deepEqual(
			result.items.map((item) => ({
				started: item.started,
				turnId: item.turnId,
				runId: item.runId,
				status: item.status,
			})),
			[
				{
					started: true,
					turnId: "turn-0",
					runId: "run-0",
					status: "cancelled",
				},
				{
					started: true,
					turnId: "turn-1",
					runId: "run-1",
					status: "cancelled",
				},
				{
					started: false,
					turnId: undefined,
					runId: undefined,
					status: "cancelled",
				},
				{
					started: false,
					turnId: undefined,
					runId: undefined,
					status: "cancelled",
				},
			],
		);
	});

	test("composes local width with the shared child-run permit pool", async () => {
		const active = new Set<string>();
		const started: string[] = [];
		const releases = new Map<string, () => void>();
		let maxActive = 0;
		const runtime = buildRuntime(async (input) => {
			started.push(input.prompt);
			active.add(input.prompt);
			maxActive = Math.max(maxActive, active.size);
			await input.onReady?.({
				turnId: `turn-${input.prompt}`,
				agentId: input.spec.id,
				agentName: input.spec.name,
			});
			return await new Promise((resolve) => {
				releases.set(input.prompt, () => {
					active.delete(input.prompt);
					resolve(childResultForPrompt(input.prompt));
				});
			});
		});
		const single = executeTool(
			runtime,
			singleChildProbeTool(),
			{},
			new AbortController(),
		);
		await waitFor(() => started.length === 1);

		const swarm = executeTool(
			runtime,
			{
				...buildAgentSwarmTool(),
				permissionRequired: false,
			},
			{
				items: Array.from({ length: 5 }, (_, index) => swarmItem(index)),
				max_concurrency: 5,
			},
			new AbortController(),
		);
		await waitFor(
			() => started.length === MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN,
		);

		assert.equal(maxActive, MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);
		assert.equal(
			started.filter((prompt) => prompt.startsWith("task-")).length,
			MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN - 1,
		);

		releases.get("single")?.();
		await waitFor(() => started.length === 6);
		assert.equal(maxActive, MAX_ACTIVE_CHILD_AGENT_RUNS_PER_TURN);

		for (const release of releases.values()) release();
		await Promise.all([single, swarm]);
		assert.equal(active.size, 0);
	});

	test("persists partial as settled and cancellation as interrupted", async () => {
		const events: Array<{
			type: string;
			toolUseId?: string;
			isError?: boolean;
		}> = [];
		const runtime = buildRuntime(async (input) => {
			const index = Number(input.prompt.slice("task-".length));
			return childResult(index, index === 1 ? "failed" : "completed");
		});
		const swarmTool = {
			...buildAgentSwarmTool(),
			permissionRequired: false,
		};
		await executeTool(
			runtime,
			swarmTool,
			{
				items: [swarmItem(0), swarmItem(1)],
				max_concurrency: 2,
			},
			new AbortController(),
			events,
			"tool-partial",
		);

		const cancelledController = new AbortController();
		cancelledController.abort(new Error("stop before start"));
		await executeTool(
			runtime,
			swarmTool,
			{ items: [swarmItem(2)] },
			cancelledController,
			events,
			"tool-cancelled",
		);

		assert.equal(
			events.find(
				(event) =>
					event.type === "tool_result" && event.toolUseId === "tool-partial",
			)?.isError,
			false,
		);
		assert.equal(
			events.find(
				(event) =>
					event.type === "tool_result" && event.toolUseId === "tool-cancelled",
			)?.isError,
			true,
		);
	});

	test("child tool construction excludes agent_swarm", () => {
		const tools = buildChildAgentTools([
			...["Read", "Glob", "Grep", "WebSearch"].map((name) => ({
				name,
				description: name,
				parameters: {},
				permissionRequired: false,
				categoryHint: "read" as const,
				impl: async () => ({}),
			})),
			buildAgentSwarmTool(),
		]);

		assert.equal(
			tools.some((tool) => tool.name === AGENT_SWARM_TOOL_NAME),
			false,
		);
	});
});

function swarmItem(index: number): AgentSwarmToolInput["items"][number] {
	return {
		item_id: `item-${index}`,
		profile: LOCAL_READ_AGENT_PROFILE,
		task: `task-${index}`,
		write_back: AGENT_WRITE_BACK_SUMMARY,
		isolation: AGENT_WORKSPACE_SAME_WORKSPACE,
	};
}

function childResult(
	index: number,
	status: SpawnChildAgentResult["status"] = "completed",
): SpawnChildAgentResult {
	return {
		agentId: "local-read",
		agentName: "Local Read",
		turnId: `turn-${index}`,
		runId: `run-${index}`,
		status,
		permissionMode: "explore",
		summary: `summary-${index}`,
		artifactIds: [`artifact-${index}`],
		startedAt: index * 10,
		completedAt: index * 10 + 5,
		durationMs: 5,
		eventCount: 1,
		...(status === "failed" ? { failureClass: "ChildFailed" } : {}),
	};
}

function childResultForPrompt(prompt: string): SpawnChildAgentResult {
	const index = prompt === "single" ? 99 : Number(prompt.slice("task-".length));
	return childResult(index);
}

function context(overrides: Partial<MakaToolContext> = {}): MakaToolContext {
	return {
		sessionId: "session-1",
		turnId: "parent-turn",
		cwd: "/tmp",
		toolCallId: "tool-swarm",
		abortSignal: new AbortController().signal,
		emitOutput: () => {},
		...overrides,
	};
}

async function invokeAgentSwarm(
	tool: ReturnType<typeof buildAgentSwarmTool>,
	input: AgentSwarmToolInput,
	ctx: MakaToolContext,
): Promise<AgentSwarmToolResult> {
	return await tool.impl(input, ctx);
}

function singleChildProbeTool(): MakaTool {
	return {
		name: "single_child_probe",
		description: "test-only single child probe",
		parameters: {},
		permissionRequired: false,
		categoryHint: "subagent",
		impl: async (_input, ctx) => {
			if (!ctx.spawnChildAgent) throw new Error("missing spawn capability");
			return await ctx.spawnChildAgent({
				spec: {
					id: "local-read",
					name: "Local Read",
					systemPrompt: "Test.",
				},
				prompt: "single",
			});
		},
	};
}

function buildRuntime(
	spawnChildAgent: NonNullable<
		ConstructorParameters<typeof ToolRuntime>[0]["spawnChildAgent"]
	>,
): ToolRuntime {
	const permissionEngine = new PermissionEngine({
		newId: nextId(),
		now: () => 1,
	});
	permissionEngine.beginTurn("turn-1");
	return new ToolRuntime({
		sessionId: "session-1",
		header: testHeader(),
		connection: testConnection(),
		modelId: "mock-model",
		appendMessage: async () => {},
		permissionEngine,
		newId: nextId(),
		now: () => 1,
		getPermissionPauseTarget: () => null,
		getCurrentRunId: () => "parent-run",
		spawnChildAgent,
	});
}

async function executeTool(
	runtime: ToolRuntime,
	tool: MakaTool,
	input: unknown,
	controller: AbortController,
	events: Array<{
		type: string;
		toolUseId?: string;
		isError?: boolean;
	}> = [],
	toolCallId = "tool-test",
): Promise<unknown> {
	return await runtime.wrapToolExecute(tool, "turn-1", {
		push: (event) => events.push(event),
	})(input, {
		toolCallId,
		abortSignal: controller.signal,
	});
}

function testHeader(): SessionHeader {
	return {
		id: "session-1",
		workspaceRoot: "/tmp",
		cwd: "/tmp",
		createdAt: 1,
		lastUsedAt: 1,
		name: "Test",
		isFlagged: false,
		labels: [],
		isArchived: false,
		status: "active",
		statusUpdatedAt: 1,
		hasUnread: false,
		backend: "ai-sdk",
		llmConnectionSlug: "anthropic-main",
		connectionLocked: true,
		model: "mock-model",
		permissionMode: "execute",
		schemaVersion: 1,
	};
}

function testConnection(): LlmConnection {
	return {
		slug: "anthropic-main",
		name: "Anthropic",
		providerType: "anthropic",
		defaultModel: "mock-model",
		enabled: true,
		createdAt: 1,
		updatedAt: 1,
	};
}

function nextId(): () => string {
	let id = 0;
	return () => `id-${++id}`;
}

interface Deferred<Value> {
	readonly promise: Promise<Value>;
	resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
	let resolvePromise: ((value: Value) => void) | undefined;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value) => resolvePromise!(value),
	};
}

function sequence(values: readonly number[]): () => number {
	let index = 0;
	return () => values[Math.min(index++, values.length - 1)]!;
}

async function onceAborted(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	await new Promise<void>((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

async function withTimeout<Value>(
	promise: Promise<Value>,
	message: string,
	timeoutMs = 1_000,
): Promise<Value> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
