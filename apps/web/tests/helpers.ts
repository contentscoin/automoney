import { convexTest, type TestConvex } from "convex-test";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { modules } from "./setup";
import { provisionNewUser } from "../convex/lib/onboarding";

export type T = TestConvex<typeof schema>;

export function setupEnv() {
  process.env.SUPER_ADMIN_EMAILS = "owner@automoney.test";
  process.env.REDIRECT_SHARED_SECRET = "redirect-secret";
  process.env.SITE_URL = "https://app.automoney.test";
  process.env.CONVEX_SITE_URL = "https://convex.automoney.test";
  process.env.META_MODE = "mock";
  process.env.ATTRANGS_WEBHOOK_SECRET = "webhook-secret";
  // 32 bytes base64
  process.env.KYC_ENC_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
}

export function makeT(): T {
  setupEnv();
  return convexTest(schema, modules);
}

/** 가입 흐름을 흉내낸다: users insert → provisionNewUser (auth 콜백과 동일 경로). */
export async function signup(t: T, email: string, opts: { name?: string; inviteCode?: string } = {}) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { email, name: opts.name ?? email.split("@")[0], inviteCode: opts.inviteCode });
    await provisionNewUser(ctx, id);
    return id;
  });
  return { userId, as: t.withIdentity({ subject: `${userId}|session_${userId}` }) };
}

export async function setRole(t: T, userId: Id<"users">, role: "USER" | "ADMIN" | "SUPER_ADMIN") {
  await t.run(async (ctx) => {
    await ctx.db.patch(userId, { role });
  });
}

export async function seedProduct(t: T, attrangsProductId = 100001) {
  return await t.run(async (ctx) =>
    ctx.db.insert("products", {
      attrangsProductId,
      name: `테스트 상품 ${attrangsProductId}`,
      price: 39000,
      salePrice: 35000,
      category: "원피스",
      imageUrls: [],
      detailUrl: `https://attrangs.co.kr/shop/view.php?index_no=${attrangsProductId}`,
      status: "ACTIVE",
      syncedAt: Date.now(),
      source: "MOCK",
    }),
  );
}
