import { app, BrowserWindow, ipcMain, Menu, Notification, shell, Tray, nativeImage } from "electron";
import path from "node:path";
import { AgentLoop, type AgentStatus } from "./agent/loop";
import { loadConfig, saveConfig, redactedConfig } from "./agent/config";
import { log } from "./agent/logger";
import { detectBrowsers } from "./agent/spaces/manager";
import { createUpdater, type UpdaterState } from "./updater";

/**
 * automoney 데스크톱 에이전트 (Electron main). blogautomcp main.cjs 의 트레이·단일 인스턴스·딥링크·워치독 패턴 계승.
 * 관리 화면은 웹 대시보드가 담당하고, 이 앱은 페어링·상태·스페이스 로그인 창만 제공한다.
 */
process.env.AUTOMONEY_USER_DATA = process.env.AUTOMONEY_USER_DATA ?? path.join(app.getPath("userData"), "agent");

let tray: Tray | null = null;
let panel: BrowserWindow | null = null;
let isQuitting = false;
let pendingPairCode: string | null = null;
const appVersion = app.getVersion();
let updaterState: { state: UpdaterState; detail?: string } = { state: "disabled" };

const loop = new AgentLoop(
  {
    onStatus: (s) => panel?.webContents.send("agent:status", s),
    onUserAttention: (message) => {
      new Notification({ title: "automoney", body: message }).show();
      showPanel();
    },
  },
  appVersion,
);

function parsePairDeepLink(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "automoney:") return null;
    const action = u.hostname || u.pathname.replace(/^\/+/, "");
    if (action !== "pair") return null;
    const code = (u.searchParams.get("code") ?? "").toUpperCase().replace(/[^A-Z2-9]/g, "");
    return code.length === 8 ? code : null;
  } catch {
    return null;
  }
}

async function handlePair(code: string) {
  try {
    await loop.pair(code);
    new Notification({ title: "automoney", body: "데스크톱 에이전트가 연결되었습니다." }).show();
  } catch (e) {
    new Notification({ title: "automoney", body: `페어링 실패: ${(e as Error).message}` }).show();
    log("error", "pair failed", { error: String(e) });
  }
}

function showPanel() {
  if (!panel) {
    panel = new BrowserWindow({ width: 380, height: 420, resizable: false, show: false, title: "automoney", webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true } });
    void panel.loadFile(path.join(__dirname, "panel.html"));
    panel.on("close", (e) => {
      if (!isQuitting) {
        e.preventDefault();
        panel?.hide();
      }
    });
    panel.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  }
  panel.show();
  panel.focus();
}

function ensureTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("automoney 에이전트");
  const menu = Menu.buildFromTemplate([
    { label: "상태 패널", click: showPanel },
    { label: "웹 대시보드 열기", click: () => void shell.openExternal(loadConfig().siteUrl) },
    { type: "separator" },
    { label: "종료", click: () => { isQuitting = true; loop.stop(); app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", showPanel);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith("automoney://"));
    const code = link ? parsePairDeepLink(link) : null;
    if (code) void handlePair(code);
    showPanel();
  });
  app.on("open-url", (e, url) => {
    e.preventDefault();
    const code = parsePairDeepLink(url);
    if (!code) return;
    if (app.isReady()) void handlePair(code);
    else pendingPairCode = code;
  });

  app.whenReady().then(() => {
    if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient("automoney", process.execPath, [path.resolve(process.argv[1])]);
    else app.setAsDefaultProtocolClient("automoney");
    if (app.isPackaged && process.platform === "win32") app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ["--hidden"] });

    ipcMain.handle("agent:status", (): AgentStatus & { updater: typeof updaterState; version: string; browsers: string[] } => ({ ...loop.status, updater: updaterState, version: appVersion, browsers: detectBrowsers().map((b) => b.label) }));
    ipcMain.handle("agent:pair", async (_e, code: string) => {
      await loop.pair(String(code).toUpperCase().replace(/[^A-Z2-9]/g, ""));
      return redactedConfig(loadConfig());
    });
    ipcMain.handle("agent:setConfig", (_e, patch: Record<string, unknown>) => {
      const cfg = { ...loadConfig(), ...patch };
      saveConfig(cfg);
      loop.reload();
      return redactedConfig(cfg);
    });
    ipcMain.handle("app:openDashboard", () => shell.openExternal(loadConfig().siteUrl));

    ensureTray();
    if (!process.argv.includes("--hidden")) showPanel();
    loop.start();
    const updater = createUpdater({
      app,
      feedUrl: loadConfig().updateFeedUrl,
      getBusy: () => loop.status.activeJob !== null,
      onState: (state, detail) => {
        updaterState = { state, detail };
        panel?.webContents.send("agent:status", { ...loop.status, updater: updaterState, version: appVersion });
        log("info", "updater", { state, detail });
      },
    });
    void updater.start();
    app.on("before-quit", () => updater.stop());
    const initial = process.argv.find((a) => a.startsWith("automoney://"));
    const code = pendingPairCode ?? (initial ? parsePairDeepLink(initial) : null);
    if (code) void handlePair(code);
    log("info", "agent started", { version: appVersion });
  });

  app.on("window-all-closed", () => {
    /* 트레이 상주 */
  });
  app.on("before-quit", () => {
    isQuitting = true;
    loop.stop();
  });
}
