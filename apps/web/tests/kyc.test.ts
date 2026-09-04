import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { decryptField } from "../convex/lib/crypto";
import { makeT, signup } from "./helpers";

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

describe("kyc", () => {
  it("stores encrypted fields, exposes only masked values, and gates review to super admin", async () => {
    const t = makeT();
    const owner = await signup(t, "owner@automoney.test");
    const user = await signup(t, "k1@test.com");
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["fake-image"], { type: "image/png" })));

    await user.as.action(api.kyc.submit, { ...form, bankbookStorageId: storageId });

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
    await expect(user.as.action(api.kyc.submit, { ...form, bankbookStorageId: storageId })).rejects.toThrow(/승인된/);
  });

  it("validates inputs", async () => {
    const t = makeT();
    const user = await signup(t, "k2@test.com");
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"], { type: "image/png" })));
    await expect(user.as.action(api.kyc.submit, { ...form, residentNo: "12", bankbookStorageId: storageId })).rejects.toThrow(/주민등록번호/);
    await expect(user.as.action(api.kyc.submit, { ...form, phone: "02-123", bankbookStorageId: storageId })).rejects.toThrow(/휴대폰/);
  });
});
