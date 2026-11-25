import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-read-video-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("read tool video attachments", () => {
	it("returns a local MP4 as a base64 video tool result", async () => {
		const cwd = createTempDir();
		const path = join(cwd, "clip.mp4");
		const bytes = Buffer.from([
			0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
		]);
		writeFileSync(path, bytes);

		const result = await createReadTool(cwd).execute("read-video", { path });

		expect(result.content).toEqual([
			{ type: "text", text: "Read video file [video/mp4] (16B)" },
			{ type: "video", data: bytes.toString("base64"), mimeType: "video/mp4" },
		]);
	});

	it("rejects oversized videos before reading their contents", async () => {
		const readFile = vi.fn(async () => Buffer.alloc(0));
		const tool = createReadTool(process.cwd(), {
			operations: {
				access: async () => {},
				readFile,
				detectImageMimeType: async () => null,
				detectVideoMimeType: async () => "video/mp4",
				getSize: async () => 51 * 1024 * 1024,
			},
		});

		await expect(tool.execute("read-large-video", { path: "large.mp4" })).rejects.toThrow("exceeds 50.0MB limit");
		expect(readFile).not.toHaveBeenCalled();
	});

	it("keeps a text-only model's video warning in the display, out of what the model gets", async () => {
		const cwd = createTempDir();
		const path = join(cwd, "clip.mp4");
		const bytes = Buffer.from([
			0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00,
		]);
		writeFileSync(path, bytes);
		const ctx = { cwd, model: { id: "text-only", input: ["text"] } } as unknown as ExtensionToolContext;

		const result = await createReadToolDefinition(cwd).execute(
			"read-video-text-model",
			{ path },
			undefined,
			undefined,
			ctx,
		);

		// The result is replayed after a switch to a video-capable model, so it keeps the video and
		// no note saying the model cannot see it; pi-ai replaces the video per request instead.
		expect(result.content).toEqual([
			{ type: "text", text: "Read video file [video/mp4] (16B)" },
			{ type: "video", data: bytes.toString("base64"), mimeType: "video/mp4" },
		]);

		// The user still sees the warning, collapsed and expanded.
		initTheme("dark");
		const component = new ToolExecutionComponent(
			"read",
			"read-video-text-model",
			{ path },
			{},
			createReadToolDefinition(cwd),
			// SAFETY: ToolExecutionComponent only calls ui.requestRender(), which this stub implements.
			{ requestRender() {} } as TUI,
			cwd,
		);
		component.updateResult({ ...result, isError: false });
		const warning = "[text-only does not support videos; it saw a placeholder instead]";
		expect(stripVTControlCharacters(component.render(120).join("\n"))).toContain(warning);
		component.setExpanded(true);
		expect(stripVTControlCharacters(component.render(120).join("\n"))).toContain(warning);
	});
});
