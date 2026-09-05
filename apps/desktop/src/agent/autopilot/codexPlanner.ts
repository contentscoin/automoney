import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCodexExecutable } from "../codex";
import { parseAction, type Action } from "./actions";
import { SYSTEM_RULES, type Planner, type PlannerInput } from "./planner";
import { renderSnapshot } from "./snapshot";

/**
 * Codex CLI(`codex exec`) 를 플래너로 사용. 유저 구독 로그인 토큰은 ~/.codex 에만 존재(ADR-0005).
 * 읽기 전용 샌드박스, 네트워크 없음, 마지막 메시지를 파일로 받아 JSON 액션으로 파싱한다.
 */
export function createCodexPlanner(opts: { model?: string; timeoutMs?: number } = {}): Planner {
  const bin = findCodexExecutable();
  return {
    name: "codex",
    async next(input: PlannerInput): Promise<Action> {
      if (!bin) return { type: "fail", reason: "codex CLI not installed" };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automoney-autopilot-"));
      const outFile = path.join(dir, "last.txt");
      const prompt = [
        SYSTEM_RULES,
        `GOAL: ${input.goal}`,
        `PLATFORM: ${input.platform}`,
        `POST TEXT: ${JSON.stringify(input.text)}`,
        `HAS MEDIA: ${input.hasMedia}`,
        `PUBLISH ALLOWED: ${input.publishAllowed}`,
        `HISTORY: ${JSON.stringify(input.history.slice(-8))}`,
        renderSnapshot(input.snapshot),
        "Respond with one JSON action.",
      ].join("\n\n");
      const args = ["exec", "--skip-git-repo-check", "-s", "read-only", "-C", dir, "-o", outFile];
      if (opts.model ?? process.env.AUTOMONEY_CODEX_MODEL) args.push("-m", (opts.model ?? process.env.AUTOMONEY_CODEX_MODEL)!);
      args.push(prompt);
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile(bin, args, { timeout: opts.timeoutMs ?? 90_000, env: { ...process.env, OTEL_SDK_DISABLED: "true" }, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
          if (err && !fs.existsSync(outFile)) return reject(err);
          try {
            resolve(fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : String(stdout));
          } catch (e) {
            reject(e);
          }
        });
        child.on("error", reject);
      }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
      return parseAction(output) ?? { type: "fail", reason: `unparseable planner output: ${output.slice(0, 120)}` };
    },
  };
}
