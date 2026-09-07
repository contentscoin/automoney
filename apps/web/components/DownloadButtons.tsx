"use client";

import { useSyncExternalStore } from "react";

type Os = "win" | "mac" | "other";

function detectOs(): Os {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "win";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  return "other";
}

const subscribeNoop = () => () => {};

const LABEL: Record<Exclude<Os, "other">, string> = { win: "Windows 용 다운로드 (.exe)", mac: "macOS 용 다운로드 (.dmg)" };

/**
 * 데스크톱 앱 다운로드 버튼. 방문자 OS 를 감지해 해당 설치 파일을 1순위로 보여주고,
 * 클릭하면 /download/{win|mac} 이 최신 릴리스 파일로 302 → 브라우저가 바로 저장한다.
 */
export function DownloadButtons({ compact = false, primaryClass = "btn-primary", ghostClass = "btn-ghost" }: { compact?: boolean; primaryClass?: string; ghostClass?: string }) {
  // 서버 렌더는 "other"(양쪽 동일 노출), 클라이언트에서 UA 로 1순위 결정 — 효과 안 setState 없이 하이드레이션 안전
  const os = useSyncExternalStore(subscribeNoop, detectOs, () => "other" as Os);
  const order: Exclude<Os, "other">[] = os === "mac" ? ["mac", "win"] : ["win", "mac"];
  return (
    <div className={`flex flex-wrap items-center gap-2 ${compact ? "" : "gap-3"}`}>
      {order.map((p, i) => (
        <a key={p} href={`/download/${p}`} className={`${i === 0 ? primaryClass : ghostClass} ${compact ? "" : "!px-6 !py-3 !text-base"}`} rel="noreferrer">
          {i === 0 && os !== "other" ? `⬇ ${LABEL[p]}` : LABEL[p]}
        </a>
      ))}
      <a href="https://github.com/contentscoin/automoney/releases/latest" target="_blank" rel="noreferrer" className="text-xs text-stone-500 underline">
        모든 버전 보기
      </a>
    </div>
  );
}
