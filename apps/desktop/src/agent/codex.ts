import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Codex 연동 (blogautomcp codex-local.ts 계승).
 * 원칙: 유저 PC 에서 `codex login` 으로 로그인하고 토큰은 ~/.codex 에만 둔다(ADR-0005). 클라우드로는 상태만 보고.
 */
export function findCodexExecutable(): string | null {
  if (process.env.AUTOMONEY_CODEX_BIN && fs.existsSync(process.env.AUTOMONEY_CODEX_BIN)) return process.env.AUTOMONEY_CODEX_BIN;
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  const home = os.homedir();
  const directories = new Set((process.env.PATH ?? "").split(path.delimiter).filter(Boolean));
  directories.add(path.join(home, ".local", "bin"));
  directories.add(path.join(home, ".npm-global", "bin"));
  if (process.platform === "win32") {
    if (process.env.APPDATA) directories.add(path.join(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) directories.add(path.join(process.env.LOCALAPPDATA, "Programs", "codex"));
  } else {
    directories.add("/opt/homebrew/bin");
    directories.add("/usr/local/bin");
    directories.add("/usr/bin");
  }
  for (const dir of directories) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export type CodexStatus = { installed: boolean; loggedIn: boolean; detail: string };

/** Best-effort CLI version used for generation provenance. */
export function codexVersion(): string | null {
  const bin = findCodexExecutable();
  if (!bin) return null;
  const r = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, OTEL_SDK_DISABLED: "true" },
  });
  if (r.error || r.status !== 0) return null;
  const value = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return value ? value.slice(0, 120) : null;
}

export function codexStatus(): CodexStatus {
  const bin = findCodexExecutable();
  if (!bin) return { installed: false, loggedIn: false, detail: "codex CLI not found in known installation paths" };
  const r = spawnSync(bin, ["login", "status"], { encoding: "utf8", timeout: 12_000, env: { ...process.env, OTEL_SDK_DISABLED: "true" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { installed: true, loggedIn: /logged in|authenticated/i.test(out), detail: out.slice(0, 300) };
}

/** 로그인 시작(브라우저 열림). 완료는 codexStatus 로 폴링. */
export function startCodexLogin(deviceAuth = false): { started: boolean; detail: string } {
  const bin = findCodexExecutable();
  if (!bin) return { started: false, detail: "codex CLI not found" };
  const child = spawn(bin, deviceAuth ? ["login", "--device-auth"] : ["login"], { detached: true, stdio: "ignore", env: { ...process.env, OTEL_SDK_DISABLED: "true" } });
  child.unref();
  return { started: true, detail: deviceAuth ? "device auth started" : "browser login started" };
}
