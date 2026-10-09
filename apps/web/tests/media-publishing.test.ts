import { describe, expect, it } from "vitest";
import type { PublishPayload } from "@automoney/shared";
import { api, internal } from "../convex/_generated/api";
import { enqueueJob, hashJobPayload } from "../convex/jobs";
import { consumePiece } from "../convex/lib/pieces";
import { makeT, setRole, signup } from "./helpers";
import { createReviewedMediaPiece, MEDIA_CAPTION, MEDIA_REVIEW_CHECKLIST, seedReadyMedia } from "./media-fixtures";

async function setup(version = "0.1.18") {
  const t = makeT();
  const user = await signup(t, "media-publish@test.com");
  const { code } = await user.as.mutation(api.devices.createPairCode, {});
  const paired = await t.mutation(api.devices.pair, { code, deviceName: "미디어 PC", platform: "win32", appVersion: version });
  const { spaceId, jobId } = await user.as.mutation(api.spaces.create, { platform: "THREADS", name: "미디어 계정", handle: "media_publish" });
  await t.run(async (ctx) => {
    await ctx.db.patch(spaceId, { sessionState: "HEALTHY", handle: "media_publish", lockJobId: undefined });
    await ctx.db.patch(jobId, { status: "SUCCEEDED" });
  });
  return { t, user, spaceId, paired };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const scheduleInput = { kind: "DAILY" as const, timeOfDay: "10:00", daysOfWeek: [], jitterMinutes: 0, text: "", mediaUrls: [], autoApprove: false };

async function claimReviewed(s: Setup) {
  const reviewed = await createReviewedMediaPiece(s.t, s.user);
  const jobId = await s.user.as.mutation(api.jobs.enqueuePublish, { spaceId: s.spaceId, pieceId: reviewed.pieceId, text: "", mediaUrls: [] });
  await s.user.as.mutation(api.jobs.approve, { jobId });
  const response = await s.t.fetch("/agent/claim", { method: "POST", headers: { authorization: `Bearer ${s.paired.deviceToken}`, "content-type": "application/json" }, body: "{}" });
  expect((await response.json()).data.id).toBe(jobId);
  const job = (await s.t.run((ctx) => ctx.db.get(jobId)))!;
  const proof = { jobId, deviceId: s.paired.deviceId, attemptNo: job.attemptNo!, leaseTokenHash: job.leaseTokenHash! };
  return { reviewed, jobId, job, proof };
}

describe("immutable media publishing boundaries", () => {
  it("never auto-approves remote or stored media, and binds structured rights review to immutable bytes", async () => {
    const s = await setup();
    const remote = await s.user.as.mutation(api.content.createManual, { channel: "THREADS", caption: MEDIA_CAPTION, hashtags: ["광고", "가을코디"], mediaUrls: ["https://cdn.example.com/changeable.png"] });
    expect(remote.status).toBe("DRAFT");
    expect(await s.user.as.query(api.content.getPiece, { pieceId: remote.pieceId })).toMatchObject({ requiresStructuredReview: true, mediaIntegrity: { ready: false } });
    await expect(s.user.as.mutation(api.content.approve, { pieceId: remote.pieceId })).rejects.toThrow(/미디어 고정/);
    const media = await seedReadyMedia(s.t, s.user);
    const edited = await s.user.as.mutation(api.content.edit, { pieceId: remote.pieceId, caption: MEDIA_CAPTION, hashtags: ["광고", "가을코디"], mediaUrls: [media.url] });
    expect(edited.status).toBe("DRAFT");
    const piece = await s.user.as.query(api.content.getPiece, { pieceId: remote.pieceId });
    expect(piece.mediaIntegrity).toMatchObject({ ready: true, manifest: media.manifest });
    await expect(s.user.as.mutation(api.content.approve, { pieceId: remote.pieceId })).rejects.toThrow(/최신 내용/);
    await expect(s.user.as.mutation(api.content.approve, { pieceId: remote.pieceId, expectedOutputHash: piece.productionMeta.outputHash })).rejects.toThrow(/모두 확인/);
    await s.user.as.mutation(api.content.approve, { pieceId: remote.pieceId, expectedOutputHash: piece.productionMeta.outputHash, reviewChecklist: MEDIA_REVIEW_CHECKLIST });
    const event = await s.t.run((ctx) => ctx.db.query("contentReviewEvents").withIndex("by_piece", (q) => q.eq("pieceId", remote.pieceId)).first());
    expect(event?.snapshot).toMatchObject({ mediaIntegrity: media.manifest });
    expect(await s.t.run((ctx) => consumePiece(ctx, s.user.userId, remote.pieceId))).toMatchObject({ mediaUrls: [media.url] });
    await s.user.as.mutation(api.content.edit, { pieceId: remote.pieceId, caption: `${MEDIA_CAPTION} 코디를 저장해 보세요.`, hashtags: ["광고", "가을코디"] });
    expect(await s.user.as.query(api.content.getPiece, { pieceId: remote.pieceId })).toMatchObject({ status: "DRAFT", productionMeta: { humanApprovedAt: null, mediaIntegrity: null } });
  });

  it("keeps direct and legacy remote media available only for dry runs, including internal enqueue bypass attempts", async () => {
    const s = await setup();
    const input = { spaceId: s.spaceId, text: MEDIA_CAPTION, mediaUrls: ["https://cdn.example.com/changeable.png"] };
    await expect(s.user.as.mutation(api.jobs.enqueuePublish, input)).rejects.toThrow(/원본 고정/);
    expect(await s.user.as.mutation(api.jobs.enqueuePublish, { ...input, dryRun: true })).toBeTruthy();
    await expect(s.user.as.mutation(api.schedules.upsert, { ...scheduleInput, ...input })).rejects.toThrow(/원본 고정/);
    await expect(s.t.run((ctx) => enqueueJob(ctx, { userId: s.user.userId, jobType: "post.publish", spaceId: s.spaceId, source: "SYSTEM", payload: { ...input, platform: "THREADS" } }))).rejects.toThrow(/원본 고정/);
    const legacy = await s.user.as.mutation(api.content.createManual, { channel: "THREADS", caption: MEDIA_CAPTION, hashtags: ["광고"], mediaUrls: input.mediaUrls });
    await s.t.run((ctx) => ctx.db.patch(legacy.pieceId, { status: "APPROVED" }));
    expect(await s.user.as.query(api.content.getPublishPiece, { pieceId: legacy.pieceId })).toMatchObject({ _id: legacy.pieceId, mediaIntegrity: { ready: false } });
    expect(await s.user.as.mutation(api.jobs.enqueuePublish, { spaceId: s.spaceId, text: "", mediaUrls: [], pieceId: legacy.pieceId, dryRun: true })).toBeTruthy();
    await expect(s.user.as.mutation(api.jobs.enqueuePublish, { spaceId: s.spaceId, text: "", mediaUrls: [], pieceId: legacy.pieceId })).rejects.toThrow(/검수|승인/);
  });

  it("binds server-resolved manifests into job and schedule hashes, and rejects altered manifests before approval", async () => {
    const s = await setup();
    const reviewed = await createReviewedMediaPiece(s.t, s.user);
    const input = { spaceId: s.spaceId, pieceId: reviewed.pieceId, text: "", mediaUrls: [] };
    const schedule = await s.user.as.mutation(api.schedules.upsert, { ...scheduleInput, ...input });
    expect(await s.t.run((ctx) => ctx.db.get(schedule.scheduleId))).toMatchObject({ mediaIntegrity: reviewed.manifest });
    const jobId = await s.user.as.mutation(api.jobs.enqueuePublish, input);
    const job = (await s.t.run((ctx) => ctx.db.get(jobId)))!;
    expect(job.payload).toMatchObject({ mediaIntegrity: reviewed.manifest });
    const modified = { ...(job.payload as PublishPayload), mediaIntegrity: [{ ...reviewed.manifest[0]!, sha256: "0".repeat(64) }] };
    expect(await hashJobPayload("post.publish", modified as unknown as Record<string, unknown>)).not.toBe(job.payloadHash);
    await s.t.run((ctx) => ctx.db.patch(jobId, { payload: modified }));
    await expect(s.user.as.mutation(api.jobs.approve, { jobId })).rejects.toThrow(/명세/);
    await expect(s.t.run((ctx) => enqueueJob(ctx, { userId: s.user.userId, jobType: "post.publish", spaceId: s.spaceId, source: "SYSTEM", payload: modified as unknown as Record<string, unknown> }))).rejects.toThrow(/명세/);
  });

  it("requires a current review manifest even when older approved media already uses stable storage", async () => {
    const s = await setup();
    const reviewed = await createReviewedMediaPiece(s.t, s.user);
    await s.t.run(async (ctx) => {
      const event = (await ctx.db.query("contentReviewEvents").withIndex("by_piece", (q) => q.eq("pieceId", reviewed.pieceId)).first())!;
      const { mediaIntegrity: _legacyMissing, ...snapshot } = event.snapshot as Record<string, unknown>;
      void _legacyMissing;
      await ctx.db.patch(event._id, { snapshot });
    });
    await expect(s.t.run((ctx) => consumePiece(ctx, s.user.userId, reviewed.pieceId))).rejects.toThrow(/승인 기록/);
    expect(await s.user.as.query(api.content.getPiece, { pieceId: reviewed.pieceId })).toMatchObject({ mediaIntegrity: { ready: true }, mediaApprovalReady: false });
    await s.user.as.mutation(api.content.edit, { pieceId: reviewed.pieceId, caption: reviewed.piece.caption, hashtags: reviewed.piece.hashtags });
    const refreshed = await s.user.as.query(api.content.getPiece, { pieceId: reviewed.pieceId });
    await s.user.as.mutation(api.content.approve, { pieceId: reviewed.pieceId, expectedOutputHash: refreshed.productionMeta.outputHash, reviewChecklist: MEDIA_REVIEW_CHECKLIST });
    expect(await s.t.run((ctx) => consumePiece(ctx, s.user.userId, reviewed.pieceId))).toMatchObject({ mediaUrls: [reviewed.url] });
    expect(await s.user.as.query(api.content.getPiece, { pieceId: reviewed.pieceId })).toMatchObject({ mediaApprovalReady: true });
  });

  it("rejects manifest tampering at preflight and verifies storage again at the irreversible commit boundary", async () => {
    const s = await setup();
    const claimed = await claimReviewed(s);
    const changedPayload = { ...(claimed.job.payload as PublishPayload), mediaIntegrity: [{ ...claimed.reviewed.manifest[0]!, sizeBytes: 1 }] };
    await s.t.run((ctx) => ctx.db.patch(claimed.jobId, { payload: changedPayload }));
    expect(await s.t.mutation(internal.agent.preflightJob, claimed.proof)).toMatchObject({ ok: false, reason: "MEDIA_INTEGRITY_CHANGED" });
    await s.t.run((ctx) => ctx.db.patch(claimed.jobId, { payload: claimed.job.payload }));
    expect(await s.t.mutation(internal.agent.preflightJob, claimed.proof)).toMatchObject({ ok: true });
    await s.t.run((ctx) => ctx.storage.delete(claimed.reviewed.storageId));
    expect(await s.t.mutation(internal.agent.markDesktopPublishAttempted, claimed.proof)).toMatchObject({ ok: false, reason: "CONTENT_REVIEW_REQUIRED" });
    expect(await s.t.run((ctx) => ctx.db.get(claimed.jobId))).not.toHaveProperty("publishAttemptedAt");
  });

  it("gates media execution on the hash-verifying PC version without blocking text-only readiness", async () => {
    const s = await setup("0.1.17");
    const ready = await s.user.as.query(api.readiness.getMine, {});
    expect(ready.spaces[0]).toMatchObject({ readyForLive: true, readyForMediaLive: false, mediaVersionCompatible: false });
    const reviewed = await createReviewedMediaPiece(s.t, s.user);
    const waitingJobId = await s.user.as.mutation(api.jobs.enqueuePublish, { spaceId: s.spaceId, pieceId: reviewed.pieceId, text: "", mediaUrls: [] });
    await s.user.as.mutation(api.jobs.approve, { jobId: waitingJobId });
    expect(await s.t.mutation(internal.agent.claimJob, { deviceId: s.paired.deviceId, userId: s.user.userId })).toBeNull();
    expect(await s.t.run((ctx) => ctx.db.get(waitingJobId))).toMatchObject({ status: "QUEUED" });
    await s.user.as.mutation(api.jobs.cancel, { jobId: waitingJobId });
    await s.t.run((ctx) => ctx.db.patch(s.paired.deviceId, { appVersion: "0.1.18" }));
    const claimed = await claimReviewed(s);
    await s.t.run((ctx) => ctx.db.patch(s.paired.deviceId, { appVersion: "0.1.17" }));
    expect(await s.t.mutation(internal.agent.preflightJob, claimed.proof)).toMatchObject({ ok: false, reason: "DESKTOP_UPDATE_REQUIRED" });
    await s.t.run((ctx) => ctx.db.patch(s.paired.deviceId, { appVersion: "0.1.18" }));
    expect(await s.t.mutation(internal.agent.preflightJob, claimed.proof)).toMatchObject({ ok: true });
    await s.t.run((ctx) => ctx.db.patch(s.paired.deviceId, { appVersion: "0.1.17" }));
    expect(await s.t.mutation(internal.agent.markDesktopPublishAttempted, claimed.proof)).toMatchObject({ ok: false, reason: "DESKTOP_UPDATE_REQUIRED" });
  });

  it("disables legacy media schedules with missing byte snapshots before enqueue", async () => {
    const s = await setup();
    const reviewed = await createReviewedMediaPiece(s.t, s.user);
    const schedule = await s.user.as.mutation(api.schedules.upsert, { ...scheduleInput, spaceId: s.spaceId, pieceId: reviewed.pieceId });
    await s.t.run((ctx) => ctx.db.patch(schedule.scheduleId, { nextRunAt: Date.now() - 1, mediaIntegrity: undefined }));
    expect(await s.t.mutation(internal.schedules.tick, {})).toMatchObject({ created: 0, skipped: 1 });
    expect(await s.t.run((ctx) => ctx.db.get(schedule.scheduleId))).toMatchObject({ enabled: false, lastSkipReason: "MEDIA_INTEGRITY_CHANGED" });
  });

  it("copies approved operator bytes without copying the operator's human approval", async () => {
    const s = await setup();
    await setRole(s.t, s.user.userId, "SUPER_ADMIN");
    const reviewed = await createReviewedMediaPiece(s.t, s.user);
    await s.t.run((ctx) => ctx.db.patch(reviewed.pieceId, { visibility: "SHARED" }));
    const reader = await signup(s.t, "media-reader@test.com");
    const copied = await reader.as.mutation(api.content.copyToMine, { pieceId: reviewed.pieceId });
    expect(await reader.as.query(api.content.getPiece, { pieceId: copied.pieceId })).toMatchObject({ status: "DRAFT", mediaUrls: [reviewed.url], productionMeta: { humanApprovedAt: null }, mediaIntegrity: { ready: true } });
    await expect(s.t.run((ctx) => consumePiece(ctx, reader.userId, copied.pieceId))).rejects.toThrow();
  });
});
