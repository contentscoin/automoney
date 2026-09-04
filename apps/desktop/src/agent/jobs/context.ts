import type { AgentApi, ClaimedJob, SpaceUpdate } from "../api";
import type { AgentConfig } from "../config";
import type { JobResultEnvelope } from "@automoney/shared";

export interface JobContext {
  cfg: AgentConfig;
  api: AgentApi;
  job: ClaimedJob;
  /** 진행 보고 + 취소 확인. 취소 요청이면 JOB_CANCELLED throw */
  checkpoint(stage: string, progress?: number): Promise<void>;
  /** 로그인 창을 사용자에게 보여야 하는 잡에서 사용 (Electron 은 창 포커스, CLI 는 no-op) */
  onUserAttention?(message: string): void;
}

export interface JobOutcome {
  result: JobResultEnvelope;
  spaceUpdate?: SpaceUpdate;
}

export class JobError extends Error {
  constructor(public code: string, message: string, public spaceUpdate?: SpaceUpdate) {
    super(message);
  }
}
