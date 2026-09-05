import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexStatus, findCodexExecutable } from "./codex";

export type CodexTextResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * `codex exec` 로 텍스트(콘텐츠 초안)를 생성한다. 유저의 구독 OAuth 토큰은 ~/.codex 에만 있으며(ADR-0005)
 * 읽기 전용 샌드박스·빈 작업 폴더에서 실행하고, 마지막 메시지를 파일로 받아 돌려준다.
 */
export async function codexGenerateText(prompt: string, opts: { model?: string; timeoutMs?: number; exec?: typeof execFile } = {}): Promise<CodexTextResult> {
  const bin = findCodexExecutable();
  if (!bin) return { ok: false, reason: "codex CLI not installed" };
  const status = codexStatus();
  if (!status.loggedIn) return { ok: false, reason: `codex not logged in: ${status.detail}` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automoney-content-"));
  const outFile = path.join(dir, "last.txt");
  const args = ["exec", "--skip-git-repo-check", "-s", "read-only", "-C", dir, "-o", outFile];
  const model = opts.model ?? process.env.AUTOMONEY_CODEX_MODEL;
  if (model) args.push("-m", model);
  args.push(prompt);
  const run = opts.exec ?? execFile;
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const child = run(bin, args, { timeout: opts.timeoutMs ?? 180_000, env: { ...process.env, OTEL_SDK_DISABLED: "true" }, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err && !fs.existsSync(outFile)) return reject(err);
        try {
          resolve(fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : String(stdout));
        } catch (e) {
          reject(e);
        }
      });
      child.on("error", reject);
    });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
