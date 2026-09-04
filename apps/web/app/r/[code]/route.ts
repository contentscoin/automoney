import { ConvexHttpClient } from "convex/browser";
import { NextResponse, type NextRequest } from "next/server";
import { api } from "@/convex/_generated/api";

export const dynamic = "force-dynamic";

const CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{7}$/;

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function guessChannel(referrer: string | null, ua: string | null): string | undefined {
  const r = (referrer ?? "").toLowerCase();
  const u = (ua ?? "").toLowerCase();
  if (r.includes("instagram") || u.includes("instagram")) return "instagram";
  if (r.includes("threads") || u.includes("barcelona")) return "threads";
  if (r.includes("t.co") || r.includes("twitter") || r.includes("x.com")) return "x";
  if (r.includes("tiktok") || u.includes("tiktok")) return "tiktok";
  if (r.includes("blog.naver") || r.includes("tistory")) return "blog";
  if (r.includes("kakao")) return "kakao";
  return undefined;
}

/** 단축 링크 → 클릭 기록 → 아뜨랑스 상품 페이지로 302. */
export async function GET(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  const shortCode = code.toUpperCase();
  if (!CODE.test(shortCode)) return new NextResponse("Not found", { status: 404 });

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const secret = process.env.REDIRECT_SHARED_SECRET;
  if (!convexUrl || !secret) return new NextResponse("Redirector not configured", { status: 500 });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ua = request.headers.get("user-agent");
  const referrer = request.headers.get("referer");
  let referrerDomain: string | undefined;
  try {
    referrerDomain = referrer ? new URL(referrer).hostname : undefined;
  } catch {
    referrerDomain = undefined;
  }
  const day = new Date().toISOString().slice(0, 10);

  const client = new ConvexHttpClient(convexUrl);
  const result = await client.mutation(api.clicks.record, {
    shortCode,
    secret,
    ipHash: ip ? (await sha256(`${ip}:${day}`)).slice(0, 32) : undefined,
    uaHash: ua ? (await sha256(ua)).slice(0, 32) : undefined,
    referrerDomain,
    channel: guessChannel(referrer, ua),
  });
  if (!result.found) return new NextResponse("Link not found", { status: 404 });
  return NextResponse.redirect(result.redirectUrl, { status: 302, headers: { "cache-control": "no-store" } });
}
