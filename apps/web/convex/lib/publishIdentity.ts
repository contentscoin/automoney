import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sha256Hex } from "./crypto";

export function normalizedHandle(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/^@/, "").toLowerCase();
  return normalized || null;
}

/**
 * Stable identity for one external SNS account. Verified provider ids are
 * global. A browser-only handle is device-observed rather than provider-signed,
 * so it stays tenant-scoped to prevent another tenant spoofing a public handle
 * and denial-of-service locking the real owner.
 */
export async function publicationIdentity(ctx: MutationCtx | QueryCtx, space: Doc<"spaces">) {
  let account = space.snsAccountId ? await ctx.db.get(space.snsAccountId) : null;
  if (!account && (space.platform === "THREADS" || space.platform === "INSTAGRAM")) {
    const metaPlatform: "THREADS" | "INSTAGRAM" = space.platform;
    const accounts = await ctx.db
      .query("snsAccounts")
      .withIndex("by_user", (q) => q.eq("userId", space.userId).eq("platform", metaPlatform))
      .collect();
    account = accounts.find((candidate) => candidate.spaceId === space._id || candidate.fallbackSpaceId === space._id) ?? null;
  }
  if (account?.fallbackSpaceId === space._id) {
    const accountHandle = normalizedHandle(account.username);
    const observedHandle = normalizedHandle(space.handle);
    if (!accountHandle || !observedHandle || accountHandle !== observedHandle) return null;
  }
  const handle = normalizedHandle(account?.username ?? space.handle);
  let providerUserId = account?.providerUserId ?? null;
  // A standalone browser space may point at an account also connected through
  // Meta. Resolve that verified provider id so API and browser paths share one
  // mutex. Usernames are normalized on OAuth save.
  if (!providerUserId && handle && (space.platform === "THREADS" || space.platform === "INSTAGRAM")) {
    const metaPlatform: "THREADS" | "INSTAGRAM" = space.platform;
    const matched = (await ctx.db
      .query("snsAccounts")
      .withIndex("by_user", (q) => q.eq("userId", space.userId).eq("platform", metaPlatform))
      .collect()).find((candidate) => normalizedHandle(candidate.username) === handle);
    providerUserId = matched?.providerUserId ?? null;
  }
  const identity = providerUserId ? `provider:${providerUserId}` : handle ? `tenant:${space.userId}:handle:${handle}` : null;
  if (!identity) return null;
  return {
    publicationKey: `external-account:${await sha256Hex(`${space.platform}:${identity}`)}`,
    account,
    normalizedHandle: handle,
  };
}
