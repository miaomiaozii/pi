import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { VIRTUAL_MODULES } from "../src/core/extensions/virtual-modules.ts";

// Extensions in ~/.pi/agent/extensions import the fork-local specifiers
// (pi-stable, pi-stable-ai, pi-stable-tui). The loader resolves those names from
// two tables: jiti aliases for unbundled Node runs and VIRTUAL_MODULES for
// source and compiled-binary runs. When only the npm names were registered,
// startup failed with: Failed to load extension ... Cannot find module 'pi-stable'.

/** Fork specifier -> the npm specifier that must map to the same module. */
const FORK_TO_NPM: Record<string, string> = {
	"pi-stable": "@mariozechner/pi-coding-agent",
	"pi-stable-agent-core": "@mariozechner/pi-agent-core",
	"pi-stable-tui": "@mariozechner/pi-tui",
	"pi-stable-ai": "@mariozechner/pi-ai",
	"pi-stable-ai/compat": "@mariozechner/pi-ai/compat",
	"pi-stable-ai/oauth": "@mariozechner/pi-ai/oauth",
	"pi-stable-ai/providers/all": "@mariozechner/pi-ai/providers/all",
};

describe("pi-stable extension specifiers", () => {
	it("maps every fork specifier to the same virtual module as its npm name", () => {
		for (const [fork, npm] of Object.entries(FORK_TO_NPM)) {
			expect(VIRTUAL_MODULES[npm], `missing npm specifier ${npm}`).toBeDefined();
			expect(VIRTUAL_MODULES[fork], `missing virtual module ${fork}`).toBe(VIRTUAL_MODULES[npm]);
		}
	});

	it("loads an extension that imports the fork specifiers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-stable-specifiers-"));
		const probeFile = join(dir, "probes.json");
		const extensionPath = join(dir, "extension.ts");
		writeFileSync(
			extensionPath,
			`import { writeFileSync } from "node:fs";
import { createEventBus, type ExtensionAPI } from "pi-stable";
import { Box } from "pi-stable-tui";
import { Type } from "pi-stable-ai/compat";

writeFileSync(
	process.env.PI_STABLE_PROBE_FILE!,
	JSON.stringify({
		createEventBus: typeof createEventBus,
		Box: typeof Box,
		Type: typeof Type,
	}),
);

export default function (pi: ExtensionAPI) {}
`,
		);

		process.env.PI_STABLE_PROBE_FILE = probeFile;
		try {
			const result = await loadExtensions([extensionPath], dir);
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(1);
			expect(JSON.parse(readFileSync(probeFile, "utf8"))).toEqual({
				createEventBus: "function",
				Box: "function",
				Type: "object",
			});
		} finally {
			delete process.env.PI_STABLE_PROBE_FILE;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
