import { HEARTBEAT_INTERVAL_MS, errorResult, type JobType } from "@automoney/shared";
import { randomUUID } from "node:crypto";
import { AgentApi, ApiError, type ClaimedJob } from "./api";
import { codexStatus } from "./codex";
import { isPaired, loadConfig, saveConfig, type AgentConfig } from "./config";
import { log } from "./logger";
import { JobError, type JobContext, type JobOutcome } from "./jobs/context";
import { handleCloudOnly, handleCodexLogin, handleContentGenerate, handlePublish, handleReadback, handleSpaceCreate, handleSpaceLogin, handleSpaceVerify } from "./jobs/handlers";
import { listLocalSpaces } from "./spaces/manager";
import { completionJournal, type CompletionEntry } from "./completion-journal";

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

  constructor(private events: LoopEvents = {}, private appVersion = "0.1.15", private fetchImpl: typeof fetch = fetch, private handlers: Record<JobType, Handler> = HANDLERS) {
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
    return {
      appVersion: this.appVersion,
      platform: process.platform,
      spaces: listLocalSpaces().length,
      codexInstalled: this.status.codex?.installed ?? null,
      codexLoggedIn: this.status.codex?.loggedIn ?? null,
      codexDetail: this.status.codex?.detail?.slice(0, 160) ?? null,
      headless: this.cfg.headless,
    };
  }

  /** 1회 폴링. 잡이 있으면 끝까지 처리. 처리한 잡 수 반환 */
  async pollOnce(): Promise<number> {
    if (!isPaired(this.cfg)) {
      this.status.paired = false;
      this.emit();
      return 0;
    }
    this.status.lastPollAt = Date.now();
    this.status.codex = safeCodexStatus();
    await this.flushCompletions();
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
        const r = await this.api.heartbeat(job, stage);
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
          const r = await this.api.heartbeat(job, s, progress);
          active = r.active;
          if (r.cancelRequested) throw new CancelledError("cancelled by user");
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          active = false;
          throw new JobError("LEASE_UNVERIFIED", `heartbeat failed before ${s}: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      onUserAttention: (m) => this.events.onUserAttention?.(m),
    };

    let completion: CompletionEntry;
    try {
      const handler = this.handlers[job.jobType];
      if (!handler) throw new JobError("INTERNAL", `unknown job type ${job.jobType}`);
      // Dry-run preflight records the non-publishing protocol marker required
      // by completion. Live jobs reserve an external intent only at the
      // handler's final, submit-adjacent gate.
      if (job.jobType === "post.publish" && (job.payload as { dryRun?: boolean }).dryRun === true) {
        await this.api.preflight(job);
      }
      const outcome = await handler(ctx);
      completion = { jobId: job.id, attemptNo: job.attemptNo, leaseToken: job.leaseToken, completionId: randomUUID(), status: "SUCCEEDED", result: outcome.result, spaceUpdate: outcome.spaceUpdate };
    } catch (e) {
      const code = e instanceof CancelledError ? "JOB_CANCELLED" : e instanceof JobError || e instanceof ApiError ? e.code : (e as { code?: string })?.code === "SPACE_LOCKED" ? "SPACE_LOCKED" : (e as { code?: string })?.code === "SPACE_NOT_FOUND" ? "SPACE_NOT_FOUND" : (e as { code?: string })?.code === "BROWSER_NOT_FOUND" ? "BROWSER_NOT_FOUND" : "RECIPE_FAILED";
      const message = e instanceof Error ? e.message : String(e);
      log("error", "job failed", { id: job.id, jobType: job.jobType, code, message });
      completion = { jobId: job.id, attemptNo: job.attemptNo, leaseToken: job.leaseToken, completionId: randomUUID(), status: "FAILED", errorCode: code, errorMessage: message.slice(0, 900), result: errorResult(job.jobType, code as never, message.slice(0, 200)), spaceUpdate: e instanceof JobError ? e.spaceUpdate : undefined };
    }
    completionJournal.put(completion);
    try {
      await this.api.complete(job, completion);
      completionJournal.remove(completion.completionId);
      log("info", `job ${completion.status === "SUCCEEDED" ? "succeeded" : "failed"}`, { id: job.id, jobType: job.jobType });
    } catch (err) {
      // 실행 결과는 바꾸지 않는다. 다음 poll/start에서 같은 completionId와 fencing token으로 재전송한다.
      const quarantineReason = permanentCompletionFailure(err);
      if (quarantineReason) {
        completionJournal.quarantine(completion.completionId, quarantineReason);
        log("error", "completion rejected permanently; quarantined", { id: job.id, reason: quarantineReason });
      } else {
        log("error", "completion delivery failed; journaled for retry", { id: job.id, error: String(err) });
      }
    } finally {
      clearInterval(hb);
      this.status.activeJob = null;
      this.status.processed++;
      this.emit();
    }
  }

  private async flushCompletions(): Promise<void> {
    for (const entry of completionJournal.list()) {
      if (entry.attemptNo !== undefined && !entry.leaseToken) {
        completionJournal.quarantine(entry.completionId, "MISSING_FENCING_TOKEN");
        log("warn", "legacy completion missing fencing token; quarantined", { id: entry.jobId });
        continue;
      }
      try {
        await this.api.complete({ id: entry.jobId, attemptNo: entry.attemptNo, leaseToken: entry.leaseToken }, entry);
        completionJournal.remove(entry.completionId);
      } catch (e) {
        const quarantineReason = permanentCompletionFailure(e);
        if (quarantineReason) {
          completionJournal.quarantine(entry.completionId, quarantineReason);
          log("warn", "stale completion quarantined", { id: entry.jobId, reason: quarantineReason });
          continue;
        }
        log("warn", "completion journal flush paused after transient failure", { id: entry.jobId, error: String(e) });
        break;
      }
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

function permanentCompletionFailure(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const reason = `${error.code} ${error.message}`.toUpperCase();
  if (error.status === 400) return `HTTP_400:${reason}`;
  if (error.status === 409 && /(STALE_ATTEMPT|JOB_NOT_ACTIVE|COMPLETION_CONFLICT|LEASE_EXPIRED|LEASE_PROOF_REQUIRED|PREFLIGHT_REQUIRED|PUBLISH_INTENT_REQUIRED|PUBLISH_INTENT_INVALID)/.test(reason)) return reason;
  return null;
}

function safeCodexStatus() {
  try {
    return codexStatus();
  } catch {
    return null;
  }
}
