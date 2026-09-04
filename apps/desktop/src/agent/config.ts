import fs from "node:fs";
import path from "node:path";
import { configPath } from "./paths";

export interface AgentConfig {
  /** Convex HTTP actions base (…convex.site) */
  convexSiteUrl: string;
  /** 웹 대시보드 */
  siteUrl: string;
  deviceId?: string;
  deviceToken?: string;
  deviceName: string;
  pollIntervalMs: number;
  browserChannel?: string;
  executablePath?: string;
  headless: boolean;
}

export const DEFAULT_CONFIG: AgentConfig = {
  convexSiteUrl: process.env.AUTOMONEY_CONVEX_SITE_URL ?? "http://127.0.0.1:3211",
  siteUrl: process.env.AUTOMONEY_SITE_URL ?? "http://localhost:3000",
  deviceName: process.env.AUTOMONEY_DEVICE_NAME ?? `${process.platform}-${require("node:os").hostname()}`,
  pollIntervalMs: 5000,
  browserChannel: process.env.AUTOMONEY_BROWSER_CHANNEL,
  executablePath: process.env.AUTOMONEY_BROWSER_EXECUTABLE,
  headless: process.env.AUTOMONEY_HEADLESS === "1",
};

export function loadConfig(): AgentConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: AgentConfig): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

export function isPaired(cfg: AgentConfig): boolean {
  return Boolean(cfg.deviceToken && cfg.deviceId);
}

/** 토큰·경로 마스킹한 상태 스냅샷 (클라우드 보고·패널 표시용) */
export function redactedConfig(cfg: AgentConfig) {
  return { convexSiteUrl: cfg.convexSiteUrl, siteUrl: cfg.siteUrl, deviceId: cfg.deviceId ?? null, deviceName: cfg.deviceName, paired: isPaired(cfg), headless: cfg.headless };
}
