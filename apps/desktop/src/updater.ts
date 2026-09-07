import type { App } from "electron";

/**
 * 자동 업데이트 (blogautomcp auto-update.cjs 계승, electron-updater).
 * - 기본 피드는 GitHub Releases(`desktop-v*` 태그의 latest.yml). config.updateFeedUrl 이 있으면 generic 피드로 대체.
 *   https 만 허용(로컬 http 는 AUTOMONEY_UPDATE_ALLOW_HTTP=1), `off` 로 두면 비활성.
 * - 다운로드 후 "활성 잡 없음" 을 2회 연속 확인해야 설치(quitAndInstall).
 */
export type UpdaterState = "disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "waiting-idle" | "error";

export const GITHUB_RELEASES = { owner: "contentscoin", repo: "automoney" } as const;

export type FeedOptions = { provider: "github"; owner: string; repo: string } | { provider: "generic"; url: string };

/** 피드 설정 결정: 미설정 → GitHub Releases, URL → generic(https 만), "off"/잘못된 URL → null(비활성) */
export function resolveFeed(feedUrl: string | undefined, allowHttp = process.env.AUTOMONEY_UPDATE_ALLOW_HTTP === "1"): FeedOptions | null {
  const v = feedUrl?.trim();
  if (!v) return { provider: "github", ...GITHUB_RELEASES };
  if (v.toLowerCase() === "off") return null;
  try {
    const u = new URL(v);
    if (u.protocol === "https:" || (allowHttp && u.protocol === "http:")) return { provider: "generic", url: v };
    return null;
  } catch {
    return null;
  }
}

export interface UpdaterDeps {
  app: App;
  feedUrl?: string;
  getBusy: () => boolean;
  onState: (state: UpdaterState, detail?: string) => void;
  checkIntervalMs?: number;
  idleConfirmations?: number;
}

export function createUpdater(deps: UpdaterDeps) {
  let state: UpdaterState = "disabled";
  let timer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let updater: import("electron-updater").AppUpdater | null = null;
  const set = (s: UpdaterState, d?: string) => {
    state = s;
    deps.onState(s, d);
  };

  async function start() {
    if (!deps.app.isPackaged && process.env.AUTOMONEY_UPDATE_FORCE !== "1") return set("disabled", "not packaged");
    const feed = resolveFeed(deps.feedUrl);
    if (!feed) return set("disabled", deps.feedUrl?.trim().toLowerCase() === "off" ? "off" : "invalid feed url");
    const { autoUpdater } = await import("electron-updater");
    updater = autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.setFeedURL(feed);
    updater.on("checking-for-update", () => set("checking"));
    updater.on("update-available", (i) => set("available", i.version));
    updater.on("update-not-available", () => set("idle"));
    updater.on("download-progress", (p) => set("downloading", `${Math.round(p.percent)}%`));
    updater.on("error", (e) => set("error", e.message));
    updater.on("update-downloaded", (i) => {
      set("downloaded", i.version);
      installWhenIdle();
    });
    set("idle", feed.provider === "github" ? `github:${feed.owner}/${feed.repo}` : feed.url);
    const check = () => updater?.checkForUpdates().catch((e) => set("error", String(e)));
    setTimeout(check, 15_000);
    timer = setInterval(check, deps.checkIntervalMs ?? 2 * 60_000);
  }

  function installWhenIdle() {
    let idleCount = 0;
    const need = deps.idleConfirmations ?? 2;
    const tick = () => {
      if (deps.getBusy()) {
        idleCount = 0;
        set("waiting-idle", "job running");
        idleTimer = setTimeout(tick, 15_000);
        return;
      }
      idleCount++;
      if (idleCount >= need) {
        set("waiting-idle", "installing");
        updater?.quitAndInstall(true, true);
        return;
      }
      idleTimer = setTimeout(tick, 3_000);
    };
    tick();
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (idleTimer) clearTimeout(idleTimer);
  }

  return { start, stop, get state() { return state; } };
}
