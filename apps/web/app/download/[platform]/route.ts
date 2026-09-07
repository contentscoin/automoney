import { NextResponse, type NextRequest } from "next/server";
import { pickAsset } from "@/lib/download";

export const dynamic = "force-dynamic";

const REPO = "contentscoin/automoney";
const LATEST = `https://github.com/${REPO}/releases/latest`;
/** electron-builder 가 릴리스에 올리는 업데이트 메타. GitHub API 호출(레이트리밋) 없이 최신 파일명을 알 수 있다. */
const META: Record<string, { file: string; pick: RegExp }> = {
  win: { file: "latest.yml", pick: /\.exe$/ },
  mac: { file: "latest-mac.yml", pick: /\.dmg$/ },
};

/** /download/win|mac → 최신 릴리스의 설치 파일로 302 (브라우저가 바로 다운로드). 실패 시 릴리스 페이지로. */
export async function GET(_request: NextRequest, context: { params: Promise<{ platform: string }> }) {
  const { platform } = await context.params;
  const meta = META[platform];
  if (!meta) return NextResponse.redirect(LATEST, 302);
  try {
    const res = await fetch(`${LATEST}/download/${meta.file}`, { headers: { accept: "text/yaml,text/plain,*/*" } });
    if (!res.ok) throw new Error(`meta ${res.status}`);
    const asset = pickAsset(await res.text(), meta.pick);
    if (!asset) throw new Error("no asset");
    return NextResponse.redirect(`${LATEST}/download/${encodeURIComponent(asset)}`, 302);
  } catch {
    return NextResponse.redirect(LATEST, 302);
  }
}
