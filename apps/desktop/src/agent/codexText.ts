import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexStatus, codexVersion, findCodexExecutable } from "./codex";

export type CodexRunMetadata = {
  model: string | null;
  cliVersion: string | null;
};

export type CodexTextResult =
  | { ok: true; text: string; metadata: CodexRunMetadata }
  | { ok: false; reason: string };

const isolatedExecSupport = new Map<string, boolean>();
const UPDATE_REQUIRED = "Codex CLI 업데이트가 필요합니다. 개인 설정과 분리된 콘텐츠 생성을 지원하는 최신 CLI를 설치한 뒤 다시 시도하세요.";

/** Check flags instead of guessing support from a potentially vendor-specific version. */
function supportsIsolatedExec(bin: string, version: string | null, probe: typeof spawnSync): boolean {
  const cacheKey = version ? `${bin}\n${version}` : null;
  const cached = probe === spawnSync && cacheKey ? isolatedExecSupport.get(cacheKey) : undefined;
  if (cached !== undefined) return cached;
  try {
    const result = probe(bin, ["exec", "--help"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: { ...process.env, OTEL_SDK_DISABLED: "true" },
    });
    if (result.error || result.status !== 0) return false;
    const help = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const supported = ["--ignore-user-config", "--ephemeral", "--disable"].every((flag) =>
      new RegExp(`(?:^|\\s)${flag}(?=[\\s,=]|$)`, "m").test(help),
    );
    if (probe === spawnSync && cacheKey) isolatedExecSupport.set(cacheKey, supported);
    return supported;
  } catch {
    return false;
  }
}

class SafeGenerationError extends Error {}

/** execFile error messages contain the command, prompt and stderr. Never report them. */
function safeFailureReason(error: unknown): string {
  if (error instanceof SafeGenerationError) return error.message;
  const details = error && typeof error === "object" ? error as { code?: unknown; killed?: unknown } : {};
  if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "Codex 응답이 허용 크기를 초과했습니다. 자료 분량을 줄여 다시 시도하세요.";
  if (details.killed === true || details.code === "ETIMEDOUT") return "Codex 콘텐츠 생성 시간이 초과되었습니다. 잠시 후 다시 시도하세요.";
  if (details.code === "ENOENT") return "Codex CLI 실행 파일을 찾을 수 없습니다. 설치 상태를 확인하세요.";
  if (details.code === "EACCES" || details.code === "EPERM") return "Codex CLI 실행 권한을 확인하세요. 시스템의 보안 정책을 유지한 상태에서 설치를 점검해 주세요.";
  return "Codex 콘텐츠 생성이 정상적으로 완료되지 않았습니다. CLI 실행·연결 상태를 확인하고 다시 시도하세요.";
}

/**
 * `codex exec` 로 텍스트(콘텐츠 초안)를 생성한다. 유저의 구독 OAuth 토큰은 ~/.codex 에만 있으며(ADR-0005)
 * 개인 config/MCP와 세션 저장은 분리하되 CODEX_HOME의 인증 및 보안 rules는 유지한다.
 * 읽기 전용 샌드박스·빈 작업 폴더에서 실행하고, 정상 종료한 마지막 메시지만 돌려준다.
 */
export async function codexGenerateText(prompt: string, opts: { model?: string; timeoutMs?: number; exec?: typeof execFile; probe?: typeof spawnSync } = {}): Promise<CodexTextResult> {
  const bin = findCodexExecutable();
  if (!bin) return { ok: false, reason: "codex CLI not installed" };
  const status = codexStatus();
  if (!status.loggedIn) return { ok: false, reason: "Codex CLI 로그인이 필요합니다. 데스크톱 앱에서 로그인 상태를 확인하세요." };
  const cliVersion = codexVersion();
  if (!supportsIsolatedExec(bin, cliVersion, opts.probe ?? spawnSync)) return { ok: false, reason: UPDATE_REQUIRED };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automoney-content-"));
  const outFile = path.join(dir, "last.txt");
  const args = ["exec", "--ignore-user-config", "--ephemeral", "--disable", "apps", "-c", 'shell_environment_policy.inherit="none"', "--skip-git-repo-check", "-s", "read-only", "-C", dir, "-o", outFile];
  const model = opts.model ?? process.env.AUTOMONEY_CODEX_MODEL;
  if (model) args.push("-m", model);
  const metadata: CodexRunMetadata = {
    model: model?.trim() || null,
    cliVersion,
  };
  // Keep source material out of OS command lines and execFile failure messages.
  args.push("-");
  const run = opts.exec ?? execFile;
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const child = run(bin, args, { timeout: opts.timeoutMs ?? 180_000, env: { ...process.env, OTEL_SDK_DISABLED: "true" }, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err) => {
        // A timeout/nonzero exit may still leave a partial output file behind.
        if (err) return reject(err);
        try {
          const output = fs.readFileSync(outFile, "utf8");
          if (!output.trim()) return reject(new SafeGenerationError("Codex가 빈 결과를 반환했습니다. 콘텐츠 생성을 다시 시도하세요."));
          resolve(output);
        } catch {
          reject(new SafeGenerationError("Codex의 최종 결과 파일을 확인하지 못했습니다. 콘텐츠 생성을 다시 시도하세요."));
        }
      });
      child.on("error", reject);
      child.stdin?.on("error", reject);
      if (!child.stdin) return reject(new SafeGenerationError("Codex 입력 연결을 열지 못했습니다. 데스크톱 앱을 다시 실행해 주세요."));
      // '-' makes stdin the prompt; end() also sends EOF so exec can start.
      child.stdin.end(prompt);
    });
    return { ok: true, text, metadata };
  } catch (e) {
    return { ok: false, reason: safeFailureReason(e) };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Cleanup cannot expose a command or replace the generation result. */ }
  }
}
