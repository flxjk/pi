import { setKeybindings } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldRunFirstTimeSetup } from "../src/cli/startup-ui.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { FirstTimeSetupComponent } from "../src/modes/interactive/components/first-time-setup.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("shouldRunFirstTimeSetup", () => {
	const originalPiExperimental = process.env.PI_EXPERIMENTAL;
	const originalAgentDir = process.env[ENV_AGENT_DIR];
	let tempDir: string;
	let settingsPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-first-time-setup-"));
		settingsPath = join(tempDir, "settings.json");
		process.env.PI_EXPERIMENTAL = "1";
		delete process.env[ENV_AGENT_DIR];
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		if (originalPiExperimental === undefined) {
			delete process.env.PI_EXPERIMENTAL;
		} else {
			process.env.PI_EXPERIMENTAL = originalPiExperimental;
		}
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("returns true when experimental, default agent dir, and no settings.json", () => {
		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(true);
	});

	it("returns false when experimental features are disabled", () => {
		delete process.env.PI_EXPERIMENTAL;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when a custom agent dir is set", () => {
		process.env[ENV_AGENT_DIR] = tempDir;

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});

	it("returns false when settings.json already exists", () => {
		writeFileSync(settingsPath, "{}", "utf-8");

		expect(shouldRunFirstTimeSetup(settingsPath)).toBe(false);
	});
});

describe("FirstTimeSetupComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("offers the theme choices", () => {
		const component = new FirstTimeSetupComponent({
			onThemePreview: () => {},
			onSubmit: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(component.render(120).join("\n"));

		expect(output).toContain("Pick a theme.");
		expect(output).toContain("System (matches your terminal colors)");
		expect(output).toContain("Dark");
		expect(output).toContain("Light");
	});

	it("previews the highlighted theme and submits it", () => {
		const onThemePreview = vi.fn();
		const onSubmit = vi.fn();
		const component = new FirstTimeSetupComponent({
			onThemePreview,
			onSubmit,
			onCancel: () => {},
		});

		component.handleInput("\x1b[B");
		expect(onThemePreview).toHaveBeenLastCalledWith("dark");

		component.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledWith({ theme: "dark" });
	});

	it("submits the system theme without moving the selection", () => {
		const onSubmit = vi.fn();
		const component = new FirstTimeSetupComponent({
			onThemePreview: () => {},
			onSubmit,
			onCancel: () => {},
		});

		component.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledWith({ theme: "system" });
	});

	it("cancels setup on escape", () => {
		const onCancel = vi.fn();
		const component = new FirstTimeSetupComponent({
			onThemePreview: () => {},
			onSubmit: () => {},
			onCancel,
		});

		component.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalled();
	});
});
