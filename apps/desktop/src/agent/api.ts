import type { JobResultEnvelope, JobType } from "@automoney/shared";
import type { AgentConfig } from "./config";

export interface ClaimedJob {
  id: string;
  jobType: JobType;
  payload: Record<string, unknown>;
  spaceId: string | null;
  space: { _id: string; platform: string; name: string; handle: string | null; pinned: boolean } | null;
  leaseMs: number;
}

export interface SpaceUpdate {
  sessionState?: "CREATED" | "LOGIN_REQUIRED" | "HEALTHY" | "EXPIRED" | "RESTRICTED";
  handle?: string;
  fingerprint?: unknown;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

type FetchLike = typeof fetch;

/** 클라우드 에이전트 API 클라이언트 (Convex HTTP actions). blogautomcp siteFetch 계승. */
export class AgentApi {
  constructor(private cfg: AgentConfig, private fetchImpl: FetchLike = fetch, private appVersion = "0.1.1") {}

  private async call<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    if (!this.cfg.deviceToken) throw new ApiError(401, "UNPAIRED", "device not paired");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
    try {
      const res = await this.fetchImpl(`${this.cfg.convexSiteUrl}${path}`, {
        method: init.method ?? "POST",
        headers: { authorization: `Bearer ${this.cfg.deviceToken}`, "content-type": "application/json" },
        body: init.method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: { success?: boolean; data?: T; error?: { code?: string; message?: string } } = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new ApiError(res.status, "BAD_RESPONSE", text.slice(0, 200));
      }
      if (!res.ok || json.success === false) throw new ApiError(res.status, json.error?.code ?? `HTTP_${res.status}`, json.error?.message ?? "request failed");
      return json.data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async pair(code: string, deviceName: string): Promise<{ deviceId: string; deviceToken: string; userId: string }> {
    // 페어링은 공개 뮤테이션 → Convex HTTP 클라이언트 API 사용 (deployment URL 필요). convexSiteUrl(.site) → .cloud 변환 규칙:
    const cloudUrl = this.cfg.convexSiteUrl.replace(/\.convex\.site$/, ".convex.cloud").replace(":3211", ":3210");
    const res = await this.fetchImpl(`${cloudUrl}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "devices:pair", args: { code, deviceName, platform: process.platform, appVersion: this.appVersion }, format: "json" }),
    });
    const json = (await res.json()) as { status: string; value?: { deviceId: string; deviceToken: string; userId: string }; errorMessage?: string; errorData?: { message?: string } };
    if (json.status !== "success" || !json.value) throw new ApiError(res.status, "PAIR_FAILED", json.errorData?.message ?? json.errorMessage ?? "pairing failed");
    return json.value;
  }

  claim(snapshot: unknown): Promise<ClaimedJob | null> {
    return this.call<ClaimedJob | null>("/agent/claim", { body: { appVersion: this.appVersion, status: snapshot } });
  }
  heartbeat(jobId: string, stage?: string, progress?: number): Promise<{ active: boolean; cancelRequested: boolean }> {
    return this.call(`/agent/jobs/${jobId}/heartbeat`, { body: { stage, progress }, timeoutMs: 15_000 });
  }
  complete(jobId: string, input: { status: "SUCCEEDED" | "FAILED"; result?: JobResultEnvelope; errorCode?: string; errorMessage?: string; spaceUpdate?: SpaceUpdate }): Promise<{ ok: boolean }> {
    return this.call(`/agent/jobs/${jobId}/complete`, { body: input });
  }
  syncSpaces(updates: { spaceId: string; sessionState?: string; handle?: string }[]): Promise<{ applied: number }> {
    return this.call("/agent/spaces/sync", { body: { spaces: updates } });
  }
  config(): Promise<{ deviceId: string; userEmail: string; minAppVersion: string; spaces: { _id: string; platform: string; name: string; handle: string | null; pinned: boolean; sessionState: string }[] }> {
    return this.call("/agent/config", { method: "GET" });
  }
}
