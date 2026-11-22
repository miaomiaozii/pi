import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import type { RpcCommand } from "../src/modes/rpc/rpc-types.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => rpcIo.outputLines.push(line),
}));

vi.mock("../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

function outputRecords(): Record<string, unknown>[] {
	return rpcIo.outputLines.flatMap((line) => line.trim().split("\n")).map((line) => JSON.parse(line));
}

describe("RPC session replacement lifecycle", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	let sequence = 0;

	beforeEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		sequence = 0;
		const signals = process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const);
		const signalListeners = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
		const endListeners = new Set(process.stdin.listeners("end"));
		cleanups.push(() => {
			for (const [signal, original] of signalListeners) {
				for (const listener of process.listeners(signal)) {
					if (!original.has(listener)) process.removeListener(signal, listener);
				}
			}
			for (const listener of process.stdin.listeners("end")) {
				// Node erases listener signatures; the stdin end event has no arguments.
				if (!endListeners.has(listener)) process.stdin.removeListener("end", listener as () => void);
			}
		});
	});

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function startRuntime(cancelResume = false) {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-rpc-replacement-476-"));
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("original"), fauxAssistantMessage("continued")]);
		const credentials = AuthStorage.inMemory();
		await credentials.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: join(tempDir, "models.json") });
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [model],
		});
		const starts: string[] = [];
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				modelRuntime,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					extensionFactories: [
						(pi) => {
							pi.on("session_start", (event, ctx) => {
								starts.push(event.reason);
								ctx.ui.notify(`Firefly-Canvas #476: ${event.reason}`, "info");
							});
							pi.on("session_before_switch", (event) => {
								if (cancelResume && event.reason === "resume") return { cancel: true };
							});
						},
					],
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model,
					noTools: "all",
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost: AgentSessionRuntime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});
		cleanups.push(() => runtimeHost.dispose());
		void runRpcMode(runtimeHost);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		await runtimeHost.session.prompt("original");
		return { runtimeHost, starts, tempDir };
	}

	async function request(command: RpcCommand) {
		const id = `replacement-${++sequence}`;
		rpcIo.lineHandler!(JSON.stringify({ ...command, id }));
		await vi.waitFor(() => {
			expect(outputRecords().filter((record) => record.type === "response" && record.id === id)).toHaveLength(1);
		});
		return outputRecords().find((record) => record.type === "response" && record.id === id)!;
	}

	// Firefly-Canvas #476: real runtime replacement must own the only post-switch bind.
	it("emits one resume event and notice, preserving history and the RPC event subscription", async () => {
		const { runtimeHost, starts } = await startRuntime();
		const originalSession = runtimeHost.session;
		const sessionFile = originalSession.sessionFile!;
		const sessionId = originalSession.sessionId;
		const originalMessages = structuredClone(originalSession.messages);
		expect(starts).toEqual(["startup"]);

		expect(await request({ type: "switch_session", sessionPath: sessionFile })).toMatchObject({
			success: true,
			data: { cancelled: false },
		});
		expect(runtimeHost.session).not.toBe(originalSession);
		expect(runtimeHost.session.messages).toEqual(originalMessages);
		expect(starts).toEqual(["startup", "resume"]);
		expect(
			outputRecords()
				.filter((record) => record.method === "notify")
				.map((record) => record.message),
		).toEqual(["Firefly-Canvas #476: startup", "Firefly-Canvas #476: resume"]);
		expect(await request({ type: "get_state" })).toMatchObject({
			success: true,
			data: { sessionId, sessionFile, messageCount: originalMessages.length },
		});
		const offset = rpcIo.outputLines.length;
		expect(await request({ type: "prompt", message: "continue" })).toMatchObject({ success: true });
		await vi.waitFor(() => {
			expect(
				outputRecords()
					.slice(offset)
					.some((record) => record.type === "agent_settled"),
			).toBe(true);
		});
		expect(await request({ type: "get_state" })).toMatchObject({
			success: true,
			data: { sessionId, sessionFile, messageCount: originalMessages.length + 2 },
		});
		expect(starts).toEqual(["startup", "resume"]);
	});

	it("does not bind or emit a resume notice when switching is cancelled", async () => {
		const { runtimeHost, starts } = await startRuntime(true);
		const originalSession = runtimeHost.session;
		expect(await request({ type: "switch_session", sessionPath: originalSession.sessionFile! })).toMatchObject({
			success: true,
			data: { cancelled: true },
		});
		expect(runtimeHost.session).toBe(originalSession);
		expect(starts).toEqual(["startup"]);
		expect(outputRecords().filter((record) => record.method === "notify")).toHaveLength(1);
	});

	it("does not replace or bind the session when switch preflight fails", async () => {
		const { runtimeHost, starts, tempDir } = await startRuntime();
		const originalSession = runtimeHost.session;
		const invalidSessionFile = join(tempDir, "missing-cwd.jsonl");
		const sessionLines = readFileSync(originalSession.sessionFile!, "utf8").split("\n");
		const header = JSON.parse(sessionLines[0]) as { cwd: string };
		header.cwd = join(tempDir, "missing-cwd");
		sessionLines[0] = JSON.stringify(header);
		writeFileSync(invalidSessionFile, sessionLines.join("\n"));
		expect(await request({ type: "switch_session", sessionPath: invalidSessionFile })).toMatchObject({
			success: false,
		});
		expect(runtimeHost.session).toBe(originalSession);
		expect(starts).toEqual(["startup"]);
		expect(outputRecords().filter((record) => record.method === "notify")).toHaveLength(1);
	});
});
