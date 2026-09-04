#!/usr/bin/env node
/**
 * Electron 없이 에이전트 실행 (서버·CI·E2E 용).
 *   node dist/cli.js pair <code>
 *   node dist/cli.js run [--once] [--max N]
 *   node dist/cli.js status
 */
import { AgentLoop } from "./agent/loop";
import { loadConfig, redactedConfig, saveConfig } from "./agent/config";
import { codexStatus } from "./agent/codex";
import { listLocalSpaces } from "./agent/spaces/manager";

async function main() {
  const [cmd = "run", ...rest] = process.argv.slice(2);
  const loop = new AgentLoop({ onUserAttention: (m) => console.log(`[attention] ${m}`) }, process.env.AUTOMONEY_APP_VERSION ?? "0.1.0");
  if (cmd === "pair") {
    const code = rest[0];
    if (!code) throw new Error("usage: pair <code>");
    await loop.pair(code);
    console.log(JSON.stringify(redactedConfig(loadConfig())));
    return;
  }
  if (cmd === "config") {
    const cfg = loadConfig();
    for (const kv of rest) {
      const [k, v] = kv.split("=");
      if (k && v !== undefined) (cfg as unknown as Record<string, unknown>)[k] = v === "true" ? true : v === "false" ? false : v;
    }
    saveConfig(cfg);
    console.log(JSON.stringify(redactedConfig(cfg)));
    return;
  }
  if (cmd === "status") {
    console.log(JSON.stringify({ config: redactedConfig(loadConfig()), codex: codexStatus(), spaces: listLocalSpaces().map((s) => ({ id: s.spaceId, platform: s.platform, name: s.name })) }, null, 2));
    return;
  }
  if (cmd === "run") {
    const once = rest.includes("--once");
    const maxIdx = rest.indexOf("--max");
    const max = maxIdx >= 0 ? Number(rest[maxIdx + 1]) : Infinity;
    if (once || Number.isFinite(max)) {
      let processed = 0;
      const deadline = Date.now() + Number(process.env.AUTOMONEY_ONCE_TIMEOUT_MS ?? 120_000);
      while (Date.now() < deadline) {
        const n = await loop.pollOnce();
        processed += n;
        if (once && n === 0 && processed > 0) break;
        if (processed >= max) break;
        if (n === 0) await new Promise((r) => setTimeout(r, 1500));
      }
      console.log(JSON.stringify({ processed, status: loop.status }));
      return;
    }
    loop.start();
    process.on("SIGINT", () => {
      loop.stop();
      process.exit(0);
    });
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
