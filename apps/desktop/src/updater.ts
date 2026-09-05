import type { App } from "electron";

/**
 * 자동 업데이트 (blogautomcp auto-update.cjs 계승, electron-updater generic provider).
 * - config.updateFeedUrl 이 없으면 비활성. https 만 허용(로컬 http 는 AUTOMONEY_UPDATE_ALLOW_HTTP=1).
 * - 다운로드 후 "활성 잡 없음" 을 2회 연속 확인해야 설치(quitAndInstall).
 */
export type UpdaterState = "disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "waiting-idle" | "error";

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

  function feedOk(url: string | undefined): url is string {
    if (!url) return false;
    try {
      const u = new URL(url);
      return u.protocol === "https:" || (process.env.AUTOMONEY_UPDATE_ALLOW_HTTP === "1" && u.protocol === "http:");
    } catch {
      return false;
    }
  }

  async function start() {
    if (!deps.app.isPackaged && process.env.AUTOMONEY_UPDATE_FORCE !== "1") return set("disabled", "not packaged");
    if (!feedOk(deps.feedUrl)) return set("disabled", "no feed url");
    const { autoUpdater } = await import("electron-updater");
    updater = autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.setFeedURL({ provider: "generic", url: deps.feedUrl });
    updater.on("checking-for-update", () => set("checking"));
    updater.on("update-available", (i) => set("available", i.version));
    updater.on("update-not-available", () => set("idle"));
    updater.on("download-progress", (p) => set("downloading", `${Math.round(p.percent)}%`));
    updater.on("error", (e) => set("error", e.message));
    updater.on("update-downloaded", (i) => {
      set("downloaded", i.version);
      installWhenIdle();
    });
    set("idle");
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
