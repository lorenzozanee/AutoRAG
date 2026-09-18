import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ProcessRunner,
	type ProcessRunResult,
	SpotlightConnector,
} from "../../../src/datasource/skills/spotlight/connector.ts";
import { SpotlightSkill } from "../../../src/datasource/skills/spotlight/skill.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "autorag-spotlight-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function runner(overrides: Partial<Record<string, ProcessRunResult>>): {
	run: ProcessRunner;
	calls: Array<{ command: string; args: readonly string[] }>;
} {
	const calls: Array<{ command: string; args: readonly string[] }> = [];
	const run: ProcessRunner = (command, args) => {
		calls.push({ command, args });
		if (command === "mdutil") {
			return Promise.resolve({ ok: true, stdout: "/:\n\tIndexing enabled.\n", stderr: "", code: 0 });
		}
		if (command === "mdfind") {
			return Promise.resolve(overrides.mdfind ?? { ok: true, stdout: "", stderr: "", code: 0 });
		}
		return Promise.resolve({ ok: false, stdout: "", stderr: `unexpected command ${command}`, code: 1 });
	};
	return { run, calls };
}

describe("SpotlightConnector", () => {
	it("is unavailable on non-macOS platforms", async () => {
		const { run, calls } = runner({});
		const connector = new SpotlightConnector({ queries: ["alpha"], platform: "linux", run });
		const result = await connector.fetch();
		expect(result).toMatchObject({ ok: false, reason: "unavailable" });
		if (!result.ok) expect(result.message).toContain("macOS");
		expect(calls).toHaveLength(0);
	});

	it("is not-configured without queries", async () => {
		const { run } = runner({});
		expect(await new SpotlightConnector({ platform: "darwin", run }).fetch()).toMatchObject({
			ok: false,
			reason: "not-configured",
		});
		expect(await new SpotlightConnector({ queries: [], platform: "darwin", run }).fetch()).toMatchObject({
			ok: false,
			reason: "not-configured",
		});
	});

	it("is unavailable when Spotlight indexing is disabled", async () => {
		const run: ProcessRunner = (command) =>
			Promise.resolve(
				command === "mdutil"
					? { ok: true, stdout: "/:\n\tIndexing disabled.\n", stderr: "", code: 0 }
					: { ok: true, stdout: "", stderr: "", code: 0 },
			);
		const result = await new SpotlightConnector({ queries: ["alpha"], platform: "darwin", run }).fetch();
		expect(result).toMatchObject({ ok: false, reason: "unavailable" });
		if (!result.ok) expect(result.message).toContain("mdutil -i on");
	});

	it("is unavailable when mdfind is missing", async () => {
		const run: ProcessRunner = (command) =>
			Promise.resolve(
				command === "mdutil"
					? { ok: true, stdout: "Indexing enabled.", stderr: "", code: 0 }
					: { ok: false, stdout: "", stderr: "spawn mdfind ENOENT", code: null, error: "ENOENT" },
			);
		const result = await new SpotlightConnector({ queries: ["alpha"], platform: "darwin", run }).fetch();
		expect(result).toMatchObject({ ok: false, reason: "unavailable" });
	});

	it("collects mdfind hits, dedupes, and hydrates text content with traceable metadata", async () => {
		writeFileSync(join(root, "alpha.txt"), "alpha body text about budgets");
		writeFileSync(join(root, "beta.md"), "# Beta\nbeta note body");
		mkdirSync(join(root, "adir"));
		const { run, calls } = runner({
			mdfind: {
				ok: true,
				stdout: [
					join(root, "alpha.txt"),
					join(root, "beta.md"),
					join(root, "alpha.txt"),
					join(root, "adir"),
					"",
				].join("\n"),
				stderr: "",
				code: 0,
			},
		});
		const connector = new SpotlightConnector({ queries: ["budget"], platform: "darwin", run });
		const result = await connector.fetch();
		expect(result.ok).toBe(true);
		expect(calls.find((c) => c.command === "mdfind")?.args).toEqual(["budget"]);
		if (result.ok) {
			expect(result.documents).toHaveLength(2);
			for (const document of result.documents) {
				expect(document.docId).toMatch(/^[a-z0-9-]+$/u);
				expect(document.hierarchy).toEqual(["files"]);
			}
			const alpha = result.documents.find((d) => d.title === "alpha.txt");
			expect(alpha?.content).toBe("alpha body text about budgets");
			expect(alpha?.metadata).toMatchObject({ path: join(root, "alpha.txt"), extension: ".txt" });
		}
	});

	it("passes -onlyin when a trusted directory is configured", async () => {
		const { run, calls } = runner({});
		await new SpotlightConnector({ queries: ["alpha"], onlyIn: root, platform: "darwin", run }).fetch();
		expect(calls.find((c) => c.command === "mdfind")?.args).toEqual(["-onlyin", root, "alpha"]);
	});

	it("caps results per query and total documents", async () => {
		const paths: string[] = [];
		for (let index = 0; index < 10; index += 1) {
			const file = join(root, `f${index}.txt`);
			writeFileSync(file, `body ${index}`);
			paths.push(file);
		}
		const { run } = runner({ mdfind: { ok: true, stdout: paths.join("\n"), stderr: "", code: 0 } });
		const result = await new SpotlightConnector({
			queries: ["body"],
			maxResultsPerQuery: 5,
			maxDocuments: 3,
			platform: "darwin",
			run,
		}).fetch();
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.documents).toHaveLength(3);
	});

	it("maps EPERM content reads to a permission failure with Full Disk Access guidance", async () => {
		const protectedPath = join(root, "mail.emlx");
		writeFileSync(protectedPath, "secret");
		const { run } = runner({ mdfind: { ok: true, stdout: `${protectedPath}\n`, stderr: "", code: 0 } });
		const connector = new SpotlightConnector({
			queries: ["secret"],
			platform: "darwin",
			run,
			readFile: () => {
				const error = new Error("operation not permitted") as NodeJS.ErrnoException;
				error.code = "EPERM";
				return Promise.reject(error);
			},
		});
		const result = await connector.fetch();
		expect(result).toMatchObject({ ok: false, reason: "permission" });
		if (!result.ok) {
			expect(result.message).toContain("Full Disk Access");
			expect(result.message).not.toContain(root);
		}
	});

	it("warns with counts when some reads fail", async () => {
		writeFileSync(join(root, "ok.txt"), "fine");
		writeFileSync(join(root, "denied.txt"), "nope");
		const { run } = runner({
			mdfind: { ok: true, stdout: `${join(root, "ok.txt")}\n${join(root, "denied.txt")}\n`, stderr: "", code: 0 },
		});
		const result = await new SpotlightConnector({
			queries: ["x"],
			platform: "darwin",
			run,
			readFile: (path) =>
				path.endsWith("denied.txt")
					? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
					: Promise.resolve("fine"),
		}).fetch();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.documents).toHaveLength(1);
			expect(result.warnings?.join(" ")).toContain("1");
			expect(result.warnings?.join(" ")).toContain("Full Disk Access");
		}
	});
});

describe("SpotlightSkill", () => {
	it("describes and documents a macOS-only Spotlight datasource with FDA guidance", async () => {
		const skill = new SpotlightSkill({
			connector: new SpotlightConnector({ queries: ["alpha"], platform: "linux" }),
		});
		const descriptor = skill.describe();
		expect(descriptor).toMatchObject({ name: "spotlight", type: "spotlight-search", status: "active" });
		const manifest = skill.skillManifest();
		expect(manifest.name).toBe("datasource-spotlight");
		expect(manifest.content).toContain("macOS");
		expect(manifest.content).toContain("mdfind");
		expect(manifest.content).toContain("mdls");
		expect(manifest.content).toContain("mdutil");
		expect(manifest.content).toContain("Full Disk Access");

		const indexResult = await skill.index();
		expect(indexResult.ok).toBe(false);
		if (!indexResult.ok) expect(indexResult.code).toBe("datasource-unavailable");
	});
});
