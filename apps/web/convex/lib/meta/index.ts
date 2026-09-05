import type { MetaAdapter } from "./adapter";
import { createGraphAdapter } from "./graph";
import { mockMetaAdapter } from "./mock";

/** META_MODE=graph 이고 META_APP_ID/SECRET 이 있으면 실 API, 아니면 Mock. */
export function metaMode(): "mock" | "graph" {
  const forced = (process.env.META_MODE ?? "").toLowerCase();
  if (forced === "mock") return "mock";
  return process.env.META_APP_ID && process.env.META_APP_SECRET ? "graph" : "mock";
}

export function getMetaAdapter(): MetaAdapter {
  return metaMode() === "graph" ? createGraphAdapter({ appId: process.env.META_APP_ID!, appSecret: process.env.META_APP_SECRET! }) : mockMetaAdapter;
}

export function metaTokenKey(): string | null {
  return process.env.META_TOKEN_ENC_KEY ?? process.env.KYC_ENC_KEY ?? null;
}

export * from "./adapter";
