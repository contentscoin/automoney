import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { execFile, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const codexMocks = vi.hoisted(() => ({
  find: vi.fn((): string | null => "codex"),
  status: vi.fn(() => ({ installed: true, loggedIn: true, detail: "Logged in" })),
  version: vi.fn((): string | null => "codex-cli 1.2.3"),
}));

vi.mock("../src/agent/codex", () => ({
  findCodexExecutable: codexMocks.find,
  codexStatus: codexMocks.status,
  codexVersion: codexMocks.version,
}));

import { codexGenerateText } from "../src/agent/codexText";

const SUPPORTED_HELP = "Options:\n  --ignore-user-config\n  --ephemeral\n  --disable <FEATURE>\n";
const probe = (help = SUPPORTED_HELP) => vi.fn(() => ({ status: 0, stdout: help, stderr: "" })) as unknown as typeof spawnSync;

function executor(options: { error?: Error | null; output?: string | null; thrown?: Error; emitted?: Error; stdinError?: Error } = {}) {
  const end = vi.fn();
  const stdin = Object.assign(new EventEmitter(), { end });
  const child = Object.assign(new EventEmitter(), { stdin });
  let directory: string | undefined;
  const exec = vi.fn((_file: string, args: string[], _options, callback) => {
    if (options.thrown) throw options.thrown;
    directory = args[args.indexOf("-C") + 1];
    const outputPath = args[args.indexOf("-o") + 1]!;
    queueMicrotask(() => {
      if (options.output !== null) fs.writeFileSync(outputPath, options.output ?? '[{"channel":"THREADS"}]');
      if (options.emitted) child.emit("error", options.emitted);
      else if (options.stdinError) stdin.emit("error", options.stdinError);
      else callback(options.error ?? null, "stdout must not become the result", "stderr must not leak");
    });
    return child;
  }) as unknown as typeof execFile;
  return { exec, end, get directory() { return directory; } };
}

afterEach(() => {
  vi.unstubAllEnvs();
  codexMocks.find.mockReturnValue("codex");
  codexMocks.status.mockReturnValue({ installed: true, loggedIn: true, detail: "Logged in" });
  codexMocks.version.mockReturnValue("codex-cli 1.2.3");
});

describe("codexGenerateText", () => {
  it("isolates personal config/apps, retains auth and safety rules, and sends the prompt over stdin with EOF", async () => {
    const promptText = "채널별 비공개 콘텐츠를 생성해 주세요";
    const cli = executor();
    const help = probe();
    const authHome = process.env.CODEX_HOME;

    const result = await codexGenerateText(promptText, { exec: cli.exec, probe: help });

    expect(cli.end).toHaveBeenCalledExactlyOnceWith(promptText);
    expect(result).toEqual({ ok: true, text: '[{"channel":"THREADS"}]', metadata: { model: null, cliVersion: "codex-cli 1.2.3" } });
    const [, args, options] = vi.mocked(cli.exec).mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining(["exec", "--ignore-user-config", "--ephemeral", "--disable", "apps", "-s", "read-only"]));
    expect(args?.at(-1)).toBe("-");
    expect(args).not.toContain(promptText);
    expect(args).not.toContain("--ignore-rules");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("danger-full-access");
    expect(args).toContain('shell_environment_policy.inherit="none"');
    expect(options).toMatchObject({ timeout: 180_000, windowsHide: true });
    expect((options as { env: NodeJS.ProcessEnv }).env.CODEX_HOME).toBe(authHome);
    expect(vi.mocked(help).mock.calls[0]?.[1]).toEqual(["exec", "--help"]);
    expect(vi.mocked(help).mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
    expect(fs.existsSync(cli.directory!)).toBe(false);
  });

  it("passes and records an explicitly configured model without migration", async () => {
    vi.stubEnv("AUTOMONEY_CODEX_MODEL", "environment-model");
    const cli = executor({ output: "[]" });
    const result = await codexGenerateText("prompt", { exec: cli.exec, probe: probe(), model: "gpt-test-model" });
    expect(vi.mocked(cli.exec).mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["-m", "gpt-test-model"]));
    expect(result).toMatchObject({ ok: true, metadata: { model: "gpt-test-model", cliVersion: "codex-cli 1.2.3" } });
  });

  it("retains AUTOMONEY_CODEX_MODEL when no per-call model is supplied", async () => {
    vi.stubEnv("AUTOMONEY_CODEX_MODEL", "existing-environment-model");
    const cli = executor();
    const result = await codexGenerateText("prompt", { exec: cli.exec, probe: probe() });
    expect(vi.mocked(cli.exec).mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["-m", "existing-environment-model"]));
    expect(result).toMatchObject({ ok: true, metadata: { model: "existing-environment-model" } });
  });

  it.each(["--ignore-user-config", "--ephemeral", "--disable"])("fails closed with an update instruction when %s is unsupported", async (flag) => {
    const cli = executor();
    const result = await codexGenerateText("secret-prompt", { exec: cli.exec, probe: probe(SUPPORTED_HELP.replace(flag, "--unrelated")) });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("업데이트") });
    expect(cli.exec).not.toHaveBeenCalled();
  });

  it("fails closed without exposing help command failures", async () => {
    const cli = executor();
    const failedProbe = vi.fn(() => { throw new Error("private-token-in-help-error"); }) as unknown as typeof spawnSync;
    const result = await codexGenerateText("prompt", { exec: cli.exec, probe: failedProbe });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("업데이트") });
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(cli.exec).not.toHaveBeenCalled();
  });

  it("rejects timeout output even when a partial final file exists, and redacts the command", async () => {
    const cli = executor({ error: Object.assign(new Error("Command failed: secret-prompt token-secret"), { killed: true }), output: '{"partial":true}' });
    const result = await codexGenerateText("secret-prompt", { exec: cli.exec, probe: probe(), timeoutMs: 27 });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("시간이 초과") });
    expect(JSON.stringify(result)).not.toMatch(/secret|partial/);
    expect(vi.mocked(cli.exec).mock.calls[0]?.[2]).toMatchObject({ timeout: 27 });
    expect(fs.existsSync(cli.directory!)).toBe(false);
  });

  it("rejects nonzero exit output even if the final file looks complete", async () => {
    const cli = executor({ error: Object.assign(new Error("secret-prompt key-secret"), { code: 1 }), output: "[]" });
    const result = await codexGenerateText("secret-prompt", { exec: cli.exec, probe: probe() });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each([null, "", " \n"])("rejects missing or empty final output instead of returning stdout (%s)", async (output) => {
    const cli = executor({ output });
    const result = await codexGenerateText("prompt", { exec: cli.exec, probe: probe() });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("stdout");
  });

  it.each(["thrown", "emitted", "stdinError"] as const)("redacts raw %s errors", async (kind) => {
    const cli = executor({ [kind]: new Error("secret-prompt secret-token") });
    const result = await codexGenerateText("secret-prompt", { exec: cli.exec, probe: probe() });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("reports output size overflow safely", async () => {
    const cli = executor({ error: Object.assign(new Error("private stderr"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }) });
    const result = await codexGenerateText("prompt", { exec: cli.exec, probe: probe() });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("허용 크기") });
  });

  it("does not leak login status details or start generation without authentication", async () => {
    codexMocks.status.mockReturnValue({ installed: true, loggedIn: false, detail: "private-user-or-token" });
    const cli = executor();
    const result = await codexGenerateText("prompt", { exec: cli.exec, probe: probe() });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("로그인") });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(cli.exec).not.toHaveBeenCalled();
  });
});
