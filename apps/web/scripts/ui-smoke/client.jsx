import React from "react";
import { createRoot } from "react-dom/client";
import SupplyPage from "../../app/super/content/page";
import PublishPage from "../../app/dashboard/publish/page";
import SchedulesPage from "../../app/dashboard/schedules/page";
import LinksPage from "../../app/dashboard/links/page";
import { PieceCard } from "../../components/PieceCard";
import { api, useMutation, useQuery } from "./fixtures";

function MediaReviewPage() {
  const piece = useQuery(api.content.getPublishPiece, { pieceId: "piece-media" });
  const approve = useMutation(api.content.approve);
  const edit = useMutation(api.content.edit);
  return <div className="grid gap-4"><h1 className="text-xl font-bold">미디어 검수 테스트</h1><PieceCard p={piece} onApprove={(reviewChecklist) => approve({ pieceId: piece._id, reviewChecklist })} onEdit={(values) => edit({ pieceId: piece._id, ...values })} /></div>;
}

const pages = { "/super/content": SupplyPage, "/dashboard/publish": PublishPage, "/dashboard/schedules": SchedulesPage, "/dashboard/links": LinksPage, "/fixtures/media": MediaReviewPage };
const Page = pages[window.location.pathname] ?? SupplyPage;
createRoot(document.getElementById("root")).render(<><div style={{ padding: "12px 16px", background: "#1c1917", color: "white", fontSize: 12 }}><strong>MOCK UI 검증 · 실제 계정/게시/업로드 아님</strong><nav style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6 }}>{Object.entries(pages).map(([path], index) => <a key={path} href={path} style={{ textDecoration: "underline" }}>{["공급실", "게시", "예약", "링크", "미디어 검수"][index]}</a>)}</nav></div><main style={{ maxWidth: 1280, margin: "0 auto", padding: 16 }}><Page /></main></>);
