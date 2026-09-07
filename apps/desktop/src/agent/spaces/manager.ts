import fs from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import type { AgentConfig } from "../config";
import { log } from "../logger";
import { spaceDir, spaceHistoryPath, spaceMetaPath, spaceProfileDir, spaceLockPath, spacesRoot } from "../paths";
import { acquireLock, type LockHandle } from "./lock";

export interface Fingerprint {
  userAgent?: string;
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  seed: string;
}

export interface SpaceMeta {
  spaceId: string;
  platform: string;
  name: string;
  handle?: string | null;
  pinned: boolean;
  fingerprint: Fingerprint;
  createdAt: number;
  lastLoginAt?: number;
}

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

function seededPick<T>(seed: string, arr: T[]): T {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return arr[h % arr.length]!;
}

/** 스페이스 생성 시 1회 결정되는 지문. 이후 불변(고정 원칙). */
export function makeFingerprint(spaceId: string): Fingerprint {
  return { locale: "ko-KR", timezoneId: "Asia/Seoul", viewport: seededPick(spaceId, VIEWPORTS), seed: spaceId };
}

export function readMeta(spaceId: string): SpaceMeta | null {
  try {
    return JSON.parse(fs.readFileSync(spaceMetaPath(spaceId), "utf8")) as SpaceMeta;
  } catch {
    return null;
  }
}

export function writeMeta(meta: SpaceMeta): void {
  fs.mkdirSync(spaceDir(meta.spaceId), { recursive: true });
  fs.writeFileSync(spaceMetaPath(meta.spaceId), JSON.stringify(meta, null, 2));
}

export function listLocalSpaces(): SpaceMeta[] {
  try {
    return fs
      .readdirSync(spacesRoot())
      .map((d) => readMeta(d))
      .filter((m): m is SpaceMeta => !!m);
  } catch {
    return [];
  }
}

/** 스페이스 작업 이력 (append-only JSONL) */
export function appendHistory(spaceId: string, entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(spaceDir(spaceId), { recursive: true });
    fs.appendFileSync(spaceHistoryPath(spaceId), JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  } catch {
    /* ignore */
  }
}

/** 스페이스 프로필 디렉터리 생성 (space.create 잡) */
export function createSpace(input: { spaceId: string; platform: string; name: string; handle?: string | null }): SpaceMeta {
  const existing = readMeta(input.spaceId);
  if (existing) return existing;
  fs.mkdirSync(spaceProfileDir(input.spaceId), { recursive: true });
  const meta: SpaceMeta = { ...input, pinned: false, fingerprint: makeFingerprint(input.spaceId), createdAt: Date.now() };
  writeMeta(meta);
  appendHistory(input.spaceId, { action: "space.create", platform: input.platform });
  return meta;
}

export interface OpenedSpace {
  context: BrowserContext;
  page: Page;
  meta: SpaceMeta;
  close(): Promise<void>;
}

/**
 * 스페이스 브라우저 열기: 락 → persistent context(프로필 격리) → 고정 지문.
 * visible=true 면 사용자 로그인용으로 창을 보이게, 아니면 오프스크린(blogautomcp background 모드).
 */
type LaunchOpts = { headless: boolean; args: string[]; viewport: { width: number; height: number }; locale: string; timezoneId: string; userAgent?: string; ignoreDefaultArgs: string[] };

/**
 * 브라우저 후보를 순서대로 시도한다. 설정(executablePath/browserChannel)이 있으면 그것만,
 * 없으면 Playwright 번들 Chromium → 시스템 Chrome → Edge. 패키징된 앱에는 번들 Chromium 이 없으므로
 * 일반 유저 PC 에서는 보통 시스템 Chrome 으로 열린다.
 */
export async function launchWithFallback(profileDir: string, cfg: AgentConfig, opts: LaunchOpts): Promise<BrowserContext> {
  const candidates: { executablePath?: string; channel?: string; label: string }[] = cfg.executablePath
    ? [{ executablePath: cfg.executablePath, label: `executable ${cfg.executablePath}` }]
    : cfg.browserChannel
      ? [{ channel: cfg.browserChannel, label: `channel ${cfg.browserChannel}` }]
      : [{ label: "bundled chromium" }, { channel: "chrome", label: "channel chrome" }, { channel: "msedge", label: "channel msedge" }];
  let lastErr: unknown;
  for (const c of candidates) {
    try {
      return await chromium.launchPersistentContext(profileDir, { ...opts, channel: c.channel, executablePath: c.executablePath });
    } catch (e) {
      lastErr = e;
      const msg = String((e as Error).message ?? e);
      if (!/Executable doesn't exist|Failed to launch|not found|ENOENT|Chromium distribution/i.test(msg)) throw e;
      log("warn", "browser launch failed, trying next candidate", { tried: c.label, error: msg.split("\n")[0] });
    }
  }
  throw new Error(`사용할 브라우저를 찾지 못했습니다. Chrome 또는 Edge 를 설치하거나 AUTOMONEY_BROWSER_CHANNEL / AUTOMONEY_BROWSER_EXECUTABLE 을 설정하세요. (${String((lastErr as Error)?.message ?? lastErr).split("\n")[0]})`);
}

export async function openSpace(cfg: AgentConfig, spaceId: string, opts: { visible?: boolean; purpose: string; waitLockMs?: number }): Promise<OpenedSpace> {
  const meta = readMeta(spaceId);
  if (!meta) {
    const err = new Error("SPACE_NOT_FOUND") as Error & { code: string };
    err.code = "SPACE_NOT_FOUND";
    throw err;
  }
  const lock: LockHandle = acquireLock(spaceLockPath(spaceId), opts.purpose, { waitMs: opts.waitLockMs ?? 0 });
  const fp = meta.fingerprint;
  const headless = cfg.headless && !opts.visible;
  const args = ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", `--window-size=${fp.viewport.width},${fp.viewport.height}`];
  if (!opts.visible && !headless) args.push("--window-position=-32000,-32000", "--start-minimized", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding");
  try {
    const launchOpts = { headless, args, viewport: fp.viewport, locale: fp.locale, timezoneId: fp.timezoneId, userAgent: fp.userAgent, ignoreDefaultArgs: ["--enable-automation"] };
    const context = await launchWithFallback(spaceProfileDir(spaceId), cfg, launchOpts);
    const page = context.pages()[0] ?? (await context.newPage());
    log("info", "space opened", { spaceId, purpose: opts.purpose, visible: !!opts.visible });
    return {
      context,
      page,
      meta,
      async close() {
        try {
          await context.close();
        } finally {
          lock.release();
        }
      },
    };
  } catch (e) {
    lock.release();
    throw e;
  }
}
