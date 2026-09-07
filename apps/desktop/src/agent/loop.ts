import { HEARTBEAT_INTERVAL_MS, errorResult, type JobType } from "@automoney/shared";
import { AgentApi, ApiError, type ClaimedJob } from "./api";
import { codexStatus } from "./codex";
import { isPaired, loadConfig, saveConfig, type AgentConfig } from "./config";
import { log } from "./logger";
import { JobError, type JobContext, type JobOutcome } from "./jobs/context";
import { handleCloudOnly, handleCodexLogin, handleContentGenerate, handlePublish, handleReadback, handleSpaceCreate, handleSpaceLogin, handleSpaceVerify } from "./jobs/handlers";
import { listLocalSpaces } from "./spaces/manager";

export type Handler = (ctx: JobContext) => Promise<JobOutcome>;
export const HANDLERS: Record<JobType, Handler> = {
  "post.publish": handlePublish,
  "space.create": handleSpaceCreate,
  "space.login": handleSpaceLogin,
  "space.verify": handleSpaceVerify,
  "codex.login": handleCodexLogin,
  "content.generate": handleContentGenerate,
  "post.readback": handleReadback,
  "meta.token_refresh": handleCloudOnly,
};

export interface LoopEvents {
  onStatus?(status: AgentStatus): void;
  onUserAttention?(message: string): void;
}

export interface AgentStatus {
  paired: boolean;
  online: boolean;
  lastPollAt: number | null;
  lastError: string | null;
  activeJob: { id: string; jobType: string; stage: string } | null;
  processed: number;
  codex: ReturnType<typeof codexStatus> | null;
}

export class CancelledError extends Error {
  code = "JOB_CANCELLED";
}

/** 에이전트 루프: 폴링 → 클레임 → 실행(하트비트 병행) → 완료 보고. blogautomcp remote-agent/poll 계승. */
export class AgentLoop {
  status: AgentStatus = { paired: false, online: false, lastPollAt: null, lastError: null, activeJob: null, processed: 0, codex: null };
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  cfg: AgentConfig;
  api: AgentApi;

  constructor(private events: LoopEvents = {}, private appVersion = "0.1.1", private fetchImpl: typeof fetch = fetch, private handlers: Record<JobType, Handler> = HANDLERS) {
    this.cfg = loadConfig();
    this.api = new AgentApi(this.cfg, this.fetchImpl, this.appVersion);
    this.status.paired = isPaired(this.cfg);
  }

  reload(): void {
    this.cfg = loadConfig();
    this.api = new AgentApi(this.cfg, this.fetchImpl, this.appVersion);
    this.status.paired = isPaired(this.cfg);
    this.emit();
  }

  private emit() {
    this.events.onStatus?.({ ...this.status });
  }

  async pair(code: string): Promise<void> {
    const r = await this.api.pair(code, this.cfg.deviceName);
    saveConfig({ ...this.cfg, deviceId: r.deviceId, deviceToken: r.deviceToken });
    this.reload();
    log("info", "paired", { deviceId: r.deviceId });
  }

  snapshot() {
    return { appVersion: this.appVersion, platform: process.platform, spaces: listLocalSpaces().length, codexLoggedIn: this.status.codex?.loggedIn ?? null, headless: this.cfg.headless };
  }

  /** 1회 폴링. 잡이 있으면 끝까지 처리. 처리한 잡 수 반환 */
  async pollOnce(): Promise<number> {
    if (!isPaired(this.cfg)) {
      this.status.paired = false;
      this.emit();
      return 0;
    }
    this.status.lastPollAt = Date.now();
    let job: ClaimedJob | null;
    try {
      job = await this.api.claim(this.snapshot());
      this.status.online = true;
      this.status.lastError = null;
    } catch (e) {
      this.status.online = false;
      this.status.lastError = e instanceof Error ? e.message : String(e);
      if (e instanceof ApiError && e.status === 401) {
        log("warn", "device token rejected — unpairing");
        saveConfig({ ...this.cfg, deviceId: undefined, deviceToken: undefined });
        this.reload();
      }
      this.emit();
      return 0;
    }
    this.emit();
    if (!job) return 0;
    await this.runJob(job);
    return 1;
  }

  async runJob(job: ClaimedJob): Promise<void> {
    let cancelRequested = false;
    let active = true;
    let stage = "claimed";
    this.status.activeJob = { id: job.id, jobType: job.jobType, stage };
    this.emit();
    const hb = setInterval(async () => {
      try {
        const r = await this.api.heartbeat(job.id, stage);
        active = r.active;
        cancelRequested = cancelRequested || r.cancelRequested;
      } catch (e) {
        log("warn", "heartbeat failed", { error: String(e) });
      }
    }, Number(process.env.AUTOMONEY_HEARTBEAT_MS ?? HEARTBEAT_INTERVAL_MS));

    const ctx: JobContext = {
      cfg: this.cfg,
      api: this.api,
      job,
      checkpoint: async (s, progress) => {
        stage = s;
        this.status.activeJob = { id: job.id, jobType: job.jobType, stage: s };
        this.emit();
        if (!active) throw new JobError("AGENT_LOST", "lease lost");
        if (cancelRequested) throw new CancelledError("cancelled by user");
        try {
          const r = await this.api.heartbeat(job.id, s, progress);
          active = r.active;
          if (r.cancelRequested) throw new CancelledError("cancelled by user");
        } catch (e) {
          if (e instanceof CancelledError) throw e;
        }
      },
      onUserAttention: (m) => this.events.onUserAttention?.(m),
    };

    try {
      const handler = this.handlers[job.jobType];
      if (!handler) throw new JobError("INTERNAL", `unknown job type ${job.jobType}`);
      const outcome = await handler(ctx);
      await this.api.complete(job.id, { status: "SUCCEEDED", result: outcome.result, spaceUpdate: outcome.spaceUpdate });
      log("info", "job succeeded", { id: job.id, jobType: job.jobType });
    } catch (e) {
      const code = e instanceof CancelledError ? "JOB_CANCELLED" : e instanceof JobError ? e.code : (e as { code?: string })?.code === "SPACE_LOCKED" ? "SPACE_LOCKED" : (e as { code?: string })?.code === "SPACE_NOT_FOUND" ? "SPACE_NOT_FOUND" : "RECIPE_FAILED";
      const message = e instanceof Error ? e.message : String(e);
      log("error", "job failed", { id: job.id, jobType: job.jobType, code, message });
      try {
        await this.api.complete(job.id, {
          status: "FAILED",
          errorCode: code,
          errorMessage: message.slice(0, 900),
          result: errorResult(job.jobType, code as never, message.slice(0, 200)),
          spaceUpdate: e instanceof JobError ? e.spaceUpdate : undefined,
        });
      } catch (err) {
        log("error", "complete(FAILED) failed", { error: String(err) });
      }
    } finally {
      clearInterval(hb);
      this.status.activeJob = null;
      this.status.processed++;
      this.emit();
    }
  }

  start(): void {
    this.stopped = false;
    this.status.codex = safeCodexStatus();
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.pollOnce();
      } catch (e) {
        log("error", "poll error", { error: String(e) });
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.cfg.pollIntervalMs);
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

function safeCodexStatus() {
  try {
    return codexStatus();
  } catch {
    return null;
  }
}
