import fs from "node:fs";
import path from "node:path";
import { logsDir } from "./paths";

const SECRET_PATTERNS: RegExp[] = [/Bearer\s+[A-Za-z0-9_-]{20,}/g, /"deviceToken":"[^"]+"/g];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => m.slice(0, 12) + "…[redacted]");
  return out;
}

export function log(level: "info" | "warn" | "error", message: string, meta?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${meta !== undefined ? " " + safeJson(meta) : ""}`;
  const safe = redact(line);
  // stdout 은 CLI 의 기계 판독용(JSON) 출력에 남겨두고 로그는 stderr 로
  console.error(safe);
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.appendFileSync(path.join(logsDir(), "agent.log"), safe + "\n");
  } catch {
    /* ignore */
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
