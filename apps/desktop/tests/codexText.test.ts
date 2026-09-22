import { EventEmitter } from "node:events";
import type { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent/codex", () => ({
  findCodexExecutable: () => "codex",
  codexStatus: () => ({ installed: true, loggedIn: true, detail: "Logged in" }),
}));

import { codexGenerateText } from "../src/agent/codexText";

describe("codexGenerateText", () => {
  it("closes the execFile stdin pipe so codex does not wait for additional input", async () => {
    const end = vi.fn();
    const child = Object.assign(new EventEmitter(), { stdin: { end } });
    const exec = vi.fn((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, '[{"channel":"THREADS"}]', ""));
      return child;
    }) as unknown as typeof execFile;

    const result = await codexGenerateText("채널별 콘텐츠를 생성해 주세요", { exec });

    expect(end).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, text: '[{"channel":"THREADS"}]' });
  });
});
