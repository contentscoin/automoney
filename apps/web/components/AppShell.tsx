"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ROLE_LABEL } from "@/lib/format";

const NAV = {
  USER: [
    { href: "/dashboard", label: "대시보드" },
    { href: "/dashboard/links", label: "내 링크" },
    { href: "/dashboard/orders", label: "주문 실적" },
    { href: "/dashboard/settlements", label: "정산 히스토리" },
    { href: "/dashboard/kyc", label: "정산 정보(KYC)" },
    { href: "/dashboard/spaces", label: "스페이스" },
    { href: "/dashboard/jobs", label: "작업" },
    { href: "/dashboard/schedules", label: "예약 발행" },
    { href: "/dashboard/content", label: "콘텐츠" },
    { href: "/dashboard/analytics", label: "성과 분석" },
    { href: "/dashboard/mcp", label: "MCP 연동" },
    { href: "/dashboard/devices", label: "데스크톱 에이전트" },
    { href: "/dashboard/telegram", label: "텔레그램" },
  ],
  ADMIN: [
    { href: "/admin", label: "총판 관리" },
    { href: "/admin/settlements", label: "총판 정산" },
  ],
  SUPER_ADMIN: [
    { href: "/super", label: "운영 대시보드" },
    { href: "/super/users", label: "유저·권한" },
    { href: "/super/kyc", label: "KYC 검수" },
    { href: "/super/products", label: "상품" },
    { href: "/super/magazines", label: "매거진·콘텐츠" },
    { href: "/super/analytics", label: "실험·플레이북" },
    { href: "/super/orders", label: "주문 원장" },
    { href: "/super/settlements", label: "정산 관리" },
    { href: "/super/rules", label: "요율·그레이드" },
    { href: "/super/settings", label: "기본 설정" },
  ],
};

export default function AppShell({ children }: { children: React.ReactNode }) {
  const me = useQuery(api.users.me);
  const { signOut } = useAuthActions();
  const router = useRouter();
  const pathname = usePathname();

  if (me === undefined) return <div className="p-10 text-sm text-stone-500">불러오는 중…</div>;
  if (me === null) {
    router.replace("/signin");
    return null;
  }
  const role = me.role;
  const items = [
    ...NAV.USER,
    ...(role === "ADMIN" || role === "SUPER_ADMIN" ? NAV.ADMIN : []),
    ...(role === "SUPER_ADMIN" ? NAV.SUPER_ADMIN : []),
  ];

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl">
      <aside className="hidden w-56 shrink-0 border-r border-stone-200 p-5 md:block">
        <Link href="/dashboard" className="text-lg font-bold" style={{ color: "var(--accent)" }}>
          automoney
        </Link>
        <p className="mt-1 text-xs text-stone-500">아뜨랑스 파트너</p>
        <nav className="mt-6 flex flex-col gap-1">
          {items.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              className={`rounded-lg px-3 py-2 text-sm ${pathname === it.href ? "bg-orange-50 font-medium text-orange-800" : "text-stone-700 hover:bg-stone-100"}`}
            >
              {it.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex-1">
        <header className="flex items-center justify-between border-b border-stone-200 px-6 py-3">
          <div className="text-sm">
            <span className="font-medium">{me.name || me.email}</span>
            <span className="ml-2 text-xs text-stone-500">{ROLE_LABEL[role]}</span>
          </div>
          <button
            className="btn-ghost"
            onClick={async () => {
              await signOut();
              router.replace("/signin");
            }}
          >
            로그아웃
          </button>
        </header>
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}
