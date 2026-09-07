"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { errorMessage } from "@/lib/format";

export default function AuthForm({ flow }: { flow: "signIn" | "signUp" }) {
  const { signIn } = useAuthActions();
  const router = useRouter();
  const params = useSearchParams();
  const [inviteCode, setInviteCode] = useState(params.get("invite") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inviteCheck = useQuery(api.invites.validate, flow === "signUp" && inviteCode.trim().length >= 8 ? { code: inviteCode } : "skip");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <div className="card">
        <h1 className="text-xl font-bold">{flow === "signIn" ? "로그인" : "파트너 가입"}</h1>
        <form
          className="mt-5 flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setBusy(true);
            const fd = new FormData(e.currentTarget);
            fd.set("flow", flow);
            if (flow === "signUp" && !inviteCode.trim()) fd.delete("inviteCode");
            try {
              await signIn("password", fd);
              const next = params.get("next") ?? "";
              router.replace(next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {flow === "signUp" && (
            <div>
              <label className="label">이름</label>
              <input className="input" name="name" required minLength={2} maxLength={40} placeholder="활동명 또는 실명" />
            </div>
          )}
          <div>
            <label className="label">이메일</label>
            <input className="input" name="email" type="email" required autoComplete="email" />
          </div>
          <div>
            <label className="label">비밀번호</label>
            <input
              className="input"
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete={flow === "signIn" ? "current-password" : "new-password"}
            />
            {flow === "signUp" && <p className="mt-1 text-xs text-stone-500">8자 이상, 영문과 숫자 포함</p>}
          </div>
          {flow === "signUp" && (
            <div>
              <label className="label">초대 코드 (선택)</label>
              <input
                className="input uppercase"
                name="inviteCode"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="총판에게 받은 8자리 코드"
              />
              {inviteCheck && (
                <p className={`mt-1 text-xs ${inviteCheck.valid ? "text-emerald-700" : "text-rose-700"}`}>
                  {inviteCheck.valid ? "유효한 초대 코드입니다." : "유효하지 않은 초대 코드입니다."}
                </p>
              )}
            </div>
          )}
          {error && <p className="rounded-lg bg-rose-50 p-2 text-sm text-rose-700">{error}</p>}
          <button className="btn-primary mt-2" disabled={busy}>
            {busy ? "처리 중…" : flow === "signIn" ? "로그인" : "가입하기"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-stone-600">
          {flow === "signIn" ? (
            <>
              아직 계정이 없나요? <Link href="/signup" className="underline">파트너 가입</Link>
            </>
          ) : (
            <>
              이미 계정이 있나요? <Link href="/signin" className="underline">로그인</Link>
            </>
          )}
        </p>
      </div>
    </main>
  );
}
