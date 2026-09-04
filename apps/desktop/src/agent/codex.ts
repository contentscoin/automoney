import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Codex 연동 (blogautomcp codex-local.ts 계승).
 * 원칙: 유저 PC 에서 `codex login` 으로 로그인하고 토큰은 ~/.codex 에만 둔다(ADR-0005). 클라우드로는 상태만 보고.
 */
export function findCodexExecutable(): string | null {
  if (process.env.AUTOMONEY_CODEX_BIN && fs.existsSync(process.env.AUTOMONEY_CODEX_BIN)) return process.env.AUTOMONEY_CODEX_BIN;
  const candidates = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const c of candidates) {
      const p = path.join(dir, c);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export type CodexStatus = { installed: boolean; loggedIn: boolean; detail: string };

export function codexStatus(): CodexStatus {
  const bin = findCodexExecutable();
  if (!bin) return { installed: false, loggedIn: false, detail: "codex CLI not found in PATH" };
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
