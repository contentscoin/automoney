import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { decryptField, encryptField } from "../convex/lib/crypto";
import { makeT, signup } from "./helpers";
import type { T } from "./helpers";

const form = {
  legalName: "홍길동",
  phone: "010-1234-5678",
  address: "서울특별시 강남구 테헤란로 1",
  birthDate: "1995-05-05",
  residentNo: "950505-2123456",
  bankCode: "004",
  bankName: "국민은행",
  accountNo: "123456-78-901234",
  accountHolder: "홍길동",
};

async function uploadIntent(t: T, user: Awaited<ReturnType<typeof signup>>) {
  const { intentId } = await user.as.mutation(api.kyc.generateUploadUrl, {});
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["fake-image"], { type: "image/png" })));
  await user.as.mutation(api.kyc.bindUpload, { intentId, storageId });
  return intentId;
}

describe("kyc", () => {
  it("stores encrypted fields, exposes only masked values, and gates review to super admin", async () => {
    const t = makeT();
    const owner = await signup(t, "owner@automoney.test");
    const user = await signup(t, "k1@test.com");
    const uploadIntentId = await uploadIntent(t, user);

    await user.as.action(api.kyc.submit, { ...form, uploadIntentId });

    const row = await t.run(async (ctx) => (await ctx.db.query("kycProfiles").collect())[0]!);
    expect(row.residentNoEnc).not.toContain("950505");
    expect(await decryptField(process.env.KYC_ENC_KEY!, row.residentNoEnc)).toBe("9505052123456");
    expect(await decryptField(process.env.KYC_ENC_KEY!, row.accountNoEnc)).toBe("12345678901234");

    const mine = await user.as.query(api.kyc.getMine, {});
    expect(mine?.status).toBe("SUBMITTED");
    expect(mine?.residentNoMasked).toBe("******-***3456");
    expect(mine?.accountNoMasked).toBe("****1234");
    expect(JSON.stringify(mine)).not.toContain("9505052123456");

    await expect(user.as.query(api.kyc.listQueue, {})).rejects.toThrow(/권한/);
    const queue = await owner.as.query(api.kyc.listQueue, {});
    expect(queue).toHaveLength(1);
    expect(JSON.stringify(queue)).not.toContain("Enc");

    await expect(owner.as.mutation(api.kyc.review, { kycId: queue[0]!._id, decision: "REJECTED" })).rejects.toThrow(/사유/);
    await owner.as.mutation(api.kyc.review, { kycId: queue[0]!._id, decision: "APPROVED" });
    const summary = await user.as.query(api.dashboard.userSummary, {});
    expect(summary.kycStatus).toBe("APPROVED");
    expect(summary.nextSettlement.payable).toBe(true);

    // 승인 후 재제출 불가
    await expect(user.as.action(api.kyc.submit, { ...form, uploadIntentId: await uploadIntent(t, user) })).rejects.toThrow(/승인된/);
  });

  it("validates inputs", async () => {
    const t = makeT();
    const user = await signup(t, "k2@test.com");
    const uploadIntentId = await uploadIntent(t, user);
    await expect(user.as.action(api.kyc.submit, { ...form, residentNo: "12", uploadIntentId })).rejects.toThrow(/주민등록번호/);
    await expect(user.as.action(api.kyc.submit, { ...form, phone: "02-123", uploadIntentId })).rejects.toThrow(/휴대폰/);
  });

  it("rejects another user's or expired upload intent and reads legacy ciphertext", async () => {
    const t = makeT();
    const user = await signup(t, "intent-owner@test.com");
    const other = await signup(t, "intent-other@test.com");
    const { intentId } = await user.as.mutation(api.kyc.generateUploadUrl, {});
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"], { type: "image/png" })));
    await expect(other.as.mutation(api.kyc.bindUpload, { intentId, storageId })).rejects.toThrow(/찾을 수 없습니다/);
    await t.run((ctx) => ctx.db.patch(intentId, { expiresAt: Date.now() - 1 }));
    await expect(user.as.mutation(api.kyc.bindUpload, { intentId, storageId })).rejects.toThrow(/만료/);
    const current = await encryptField(process.env.KYC_ENC_KEY!, "legacy-value");
    const legacy = current.split(":").slice(2).join(":");
    expect(await decryptField(process.env.KYC_ENC_KEY!, legacy)).toBe("legacy-value");
  });
});
