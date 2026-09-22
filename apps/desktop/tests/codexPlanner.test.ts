import type { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent/codex", () => ({
  findCodexExecutable: () => "codex",
}));

import { createCodexPlanner } from "../src/agent/autopilot/codexPlanner";

describe("createCodexPlanner", () => {
  it("closes the execFile stdin pipe before waiting for a Codex action", async () => {
    const end = vi.fn();
    const child = Object.assign(new EventEmitter(), { stdin: { end } });
    const exec = vi.fn((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, '{"type":"wait","ms":250}', ""));
      return child;
    }) as unknown as typeof execFile;
    const planner = createCodexPlanner({ exec });

    const action = await planner.next({
      goal: "게시물 작성",
      platform: "THREADS",
      text: "테스트 본문",
      hasMedia: false,
      publishAllowed: false,
      history: [],
      snapshot: { url: "https://www.threads.net/", title: "Threads", elements: [], text: "" },
    });

    expect(end).toHaveBeenCalledOnce();
    expect(action).toEqual({ type: "wait", ms: 250 });
  });
});
