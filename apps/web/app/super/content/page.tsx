"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PieceCard } from "@/components/PieceCard";
import type { ReviewChecklist } from "@/components/content-review";
import { CHANNEL_LABEL, CHANNEL_ORDER } from "@/lib/content-format";
import { dateTime, errorMessage } from "@/lib/format";

type MaterialKind = "FILE" | "TEXT" | "LINK";
type RightsStatus = "OWNED" | "LICENSED" | "LINK_ONLY";
type MaterialStatus = "DRAFT" | "READY" | "ARCHIVED";
type CollectionStatus = "DRAFT" | "IN_REVIEW" | "PUBLISHED" | "WITHDRAWN";
type Channel = (typeof CHANNEL_ORDER)[number];
type Notice = { tone: "success" | "error"; text: string };

const MATERIAL_KIND_LABEL: Record<MaterialKind, string> = {
  FILE: "이미지·영상 파일",
  TEXT: "텍스트 자료",
  LINK: "외부 링크",
};

const RIGHTS_LABEL: Record<RightsStatus, string> = {
  OWNED: "자체 제작·소유",
  LICENSED: "사용 허가 확인",
  LINK_ONLY: "링크만 인용",
};

const MATERIAL_STATUS_LABEL: Record<MaterialStatus, string> = {
  DRAFT: "확인 필요",
  READY: "사용 준비 완료",
  ARCHIVED: "보관",
};

const COLLECTION_STATUS_LABEL: Record<CollectionStatus, string> = {
  DRAFT: "초안 제작",
  IN_REVIEW: "검토 중",
  PUBLISHED: "사용자 공개",
  WITHDRAWN: "공개 종료",
};

const FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;
const FILE_ACCEPT = FILE_TYPES.join(",");

const IMAGE_LIMIT = 10 * 1024 * 1024;
const VIDEO_LIMIT = 20 * 1024 * 1024;

function fileSize(value?: number | null): string {
  if (!value) return "";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.ceil(value / 1024)} KB`;
}

function validateFile(file: File): string | null {
  if (!(FILE_TYPES as readonly string[]).includes(file.type)) return "JPG, PNG, WebP, GIF 이미지 또는 MP4, MOV, WebM 영상만 올릴 수 있습니다.";
  const image = file.type.startsWith("image/");
  const limit = image ? IMAGE_LIMIT : VIDEO_LIMIT;
  if (file.size > limit) return `${image ? "이미지는 10 MB" : "영상은 20 MB"} 이하로 올려주세요.`;
  return null;
}

function splitTags(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean))];
}

function splitHashtags(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean))];
}

export default function SuperContentPage() {
  const supplySummary = useQuery(api.adminContent.summary, {});
  const materials = useQuery(api.adminContent.listMaterials, {});
  const collections = useQuery(api.adminContent.listCollections, { limit: 50 });
  const products = useQuery(api.products.search, { limit: 100 });
  const devices = useQuery(api.devices.listMine);
  const requestGenerate = useMutation(api.adminContent.requestGenerate);
  const activeDevice = devices?.find((device) => device.status === "ACTIVE");
  const deviceOnline = !!activeDevice?.online;
  const codexReady = !!(activeDevice?.snapshot as { codexLoggedIn?: boolean } | null)?.codexLoggedIn;
  const appVersionReady = !!activeDevice && (() => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(activeDevice.appVersion.trim());
    if (!match) return false;
    const parts = match.slice(1).map(Number);
    return parts[0]! > 0 || parts[1]! > 1 || (parts[1] === 1 && parts[2]! >= 16);
  })();

  const generateUploadUrl = useMutation(api.adminContent.generateUploadUrl);
  const bindUpload = useMutation(api.adminContent.bindUpload);
  const createMaterial = useMutation(api.adminContent.createMaterial);
  const markMaterialReady = useMutation(api.adminContent.markMaterialReady);
  const archiveMaterial = useMutation(api.adminContent.archiveMaterial);
  const createCollection = useMutation(api.adminContent.createCollection);
  const addManualPiece = useMutation(api.adminContent.addManualPiece);
  const removePiece = useMutation(api.adminContent.removePiece);
  const submitCollection = useMutation(api.adminContent.submitCollection);
  const reopenCollection = useMutation(api.adminContent.reopenCollection);
  const publishCollection = useMutation(api.adminContent.publishCollection);
  const withdrawCollection = useMutation(api.adminContent.withdrawCollection);
  const approvePiece = useMutation(api.content.approve);
  const editPiece = useMutation(api.content.edit);
  const rejectPiece = useMutation(api.content.reject);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>("");
  const collection = useQuery(
    api.adminContent.getCollection,
    selectedCollectionId ? { collectionId: selectedCollectionId as Id<"contentCollections"> } : "skip",
  );

  const [materialForm, setMaterialForm] = useState({
    kind: "FILE" as MaterialKind,
    title: "",
    bodyText: "",
    externalUrl: "",
    productId: "",
    rightsStatus: "OWNED" as RightsStatus,
    rightsNote: "",
  });
  const [materialFile, setMaterialFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [collectionForm, setCollectionForm] = useState({ title: "", summary: "", tags: "" });
  const [pieceForm, setPieceForm] = useState({
    channel: "THREADS" as Channel,
    caption: "",
    hashtags: "광고",
    script: "",
    productId: "",
  });
  const [pieceMaterialSelection, setPieceMaterialSelection] = useState<{ collectionId: string; ids: string[] } | null>(null);
  const [aiChannels, setAiChannels] = useState<Channel[]>(["THREADS"]);
  const [aiAudience, setAiAudience] = useState("데일리룩을 찾는 20~30대 여성");
  const [aiMessage, setAiMessage] = useState("");
  const aiRequest = useRef<{ fingerprint: string; id: string } | null>(null);

  const productById = useMemo(
    () => new Map((products ?? []).map((product) => [product._id, product])),
    [products],
  );
  const readyMaterials = (materials ?? []).filter((material) => material.status === "READY");
  const pieceMaterialIds = collection
    ? pieceMaterialSelection?.collectionId === collection._id
      ? pieceMaterialSelection.ids
      : collection.materials.map((material) => material._id)
    : [];
  const selectedPieceMaterials = collection?.materials.filter((material) => pieceMaterialIds.includes(material._id)) ?? [];
  const aiHasFactEvidence = !!pieceForm.productId || selectedPieceMaterials.some((material) =>
    !!material.productId || (material.kind === "TEXT" && !!material.bodyText?.trim()),
  );

  const perform = async <T,>(key: string, action: () => Promise<T>, success?: string): Promise<T | null> => {
    setBusyAction(key);
    setNotice(null);
    try {
      const result = await action();
      if (success) setNotice({ tone: "success", text: success });
      return result;
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
      return null;
    } finally {
      setBusyAction(null);
    }
  };

  const toggleMaterial = (materialId: string) => {
    setSelectedMaterialIds((current) => current.includes(materialId)
      ? current.filter((id) => id !== materialId)
      : [...current, materialId]);
  };

  const togglePieceMaterial = (materialId: string) => {
    if (!collection) return;
    setPieceMaterialSelection((selection) => {
      const current = selection?.collectionId === collection._id
        ? selection.ids
        : collection.materials.map((material) => material._id);
      return {
        collectionId: collection._id,
        ids: current.includes(materialId) ? current.filter((id) => id !== materialId) : [...current, materialId],
      };
    });
  };

  const submitMaterial = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (materialForm.kind === "FILE" && !materialFile) {
      setNotice({ tone: "error", text: "올릴 이미지 또는 영상 파일을 선택하세요." });
      document.getElementById("supply-material-file")?.focus();
      return;
    }
    if (materialFile) {
      const validationError = validateFile(materialFile);
      if (validationError) {
        setNotice({ tone: "error", text: validationError });
        document.getElementById("supply-material-file")?.focus();
        return;
      }
    }
    const result = await perform("create-material", async () => {
      let uploadIntentId: Id<"uploadIntents"> | undefined;
      if (materialForm.kind === "FILE" && materialFile) {
        const upload = await generateUploadUrl({});
        const response = await fetch(upload.uploadUrl, {
          method: "POST",
          headers: { "Content-Type": materialFile.type },
          body: materialFile,
        });
        if (!response.ok) throw new Error("파일을 올리지 못했습니다. 연결을 확인하고 다시 시도하세요.");
        const storageId = ((await response.json()) as { storageId: Id<"_storage"> }).storageId;
        await bindUpload({ intentId: upload.intentId, storageId });
        uploadIntentId = upload.intentId;
      }
      return await createMaterial({
        kind: materialForm.kind,
        title: materialForm.title.trim(),
        bodyText: materialForm.kind === "TEXT" ? materialForm.bodyText.trim() || undefined : undefined,
        externalUrl: materialForm.externalUrl.trim() || undefined,
        uploadIntentId,
        fileName: materialForm.kind === "FILE" ? materialFile?.name : undefined,
        mimeType: materialForm.kind === "FILE" ? materialFile?.type : undefined,
        productId: (materialForm.productId || undefined) as Id<"products"> | undefined,
        rightsStatus: materialForm.rightsStatus,
        rightsNote: materialForm.rightsNote.trim(),
      });
    }, "자료를 등록했습니다. 내용을 확인한 뒤 ‘사용 준비 완료’로 바꾸세요.");
    if (!result) return;
    setMaterialForm({ kind: "FILE", title: "", bodyText: "", externalUrl: "", productId: "", rightsStatus: "OWNED", rightsNote: "" });
    setMaterialFile(null);
    setFileInputKey((value) => value + 1);
  };

  const submitNewCollection = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedMaterialIds.length === 0) {
      setNotice({ tone: "error", text: "사용 준비가 끝난 자료를 하나 이상 선택하세요." });
      document.getElementById("supply-material-list")?.focus();
      return;
    }
    const result = await perform("create-collection", () => createCollection({
      title: collectionForm.title.trim(),
      summary: collectionForm.summary.trim() || undefined,
      tags: splitTags(collectionForm.tags),
      sourceMaterialIds: selectedMaterialIds as Id<"contentSourceMaterials">[],
    }), "콘텐츠 묶음 초안을 만들었습니다. 채널별 게시 초안을 추가하세요.");
    if (!result) return;
    setSelectedCollectionId(result.collectionId);
    setSelectedMaterialIds([]);
    setCollectionForm({ title: "", summary: "", tags: "" });
    window.setTimeout(() => document.getElementById("supply-collection-detail")?.focus(), 0);
  };

  const submitPiece = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!collection) return;
    if (pieceMaterialIds.length === 0) {
      setNotice({ tone: "error", text: "게시 초안의 근거가 되는 자료를 하나 이상 선택하세요." });
      return;
    }
    const result = await perform("add-piece", () => addManualPiece({
      collectionId: collection._id,
      sourceMaterialIds: pieceMaterialIds as Id<"contentSourceMaterials">[],
      channel: pieceForm.channel,
      caption: pieceForm.caption.trim(),
      hashtags: splitHashtags(pieceForm.hashtags),
      script: pieceForm.script.trim() || undefined,
      productId: (pieceForm.productId || undefined) as Id<"products"> | undefined,
    }), "채널별 콘텐츠 초안을 추가했습니다. 품질 결과를 확인하고 직접 검토하세요.");
    if (!result) return;
    setPieceForm({ channel: "THREADS", caption: "", hashtags: "광고", script: "", productId: "" });
  };

  const confirmCollectionAction = async (
    action: "submit" | "reopen" | "publish" | "withdraw",
  ) => {
    if (!collection) return;
    const pieceCount = collection.pieces.length;
    const prompts = {
      submit: `‘${collection.title}’의 콘텐츠 ${pieceCount}개를 검토 단계로 보낼까요? 제출 후에는 초안을 추가하거나 수정하려면 다시 열어야 합니다.`,
      reopen: `‘${collection.title}’의 콘텐츠 ${pieceCount}개를 초안으로 다시 열까요? 사용자 공개 중인 묶음은 먼저 공개를 종료해야 합니다.`,
      publish: `‘${collection.title}’의 승인 콘텐츠 ${pieceCount}개를 모든 사용자에게 공개할까요? 공개 즉시 콘텐츠 찾기에서 사용할 수 있습니다.`,
      withdraw: `‘${collection.title}’의 콘텐츠 ${pieceCount}개 공개를 종료할까요? 기존 개인 사본은 삭제되지 않지만 새 사용자는 가져갈 수 없습니다.`,
    } as const;
    if (!window.confirm(prompts[action])) return;
    const actions = {
      submit: () => submitCollection({ collectionId: collection._id }),
      reopen: () => reopenCollection({ collectionId: collection._id }),
      publish: () => publishCollection({ collectionId: collection._id }),
      withdraw: () => withdrawCollection({ collectionId: collection._id }),
    };
    const success = {
      submit: "검토 단계로 보냈습니다. 모든 콘텐츠를 확인하고 승인하세요.",
      reopen: "묶음을 초안으로 다시 열었습니다.",
      publish: "사용자 콘텐츠 라이브러리에 공개했습니다.",
      withdraw: "사용자 공개를 종료했습니다.",
    } as const;
    await perform(`collection-${action}`, actions[action], success[action]);
  };

  const runPieceAction = async (action: () => Promise<unknown>, success: string) => {
    const result = await perform("piece-action", action, success);
    return result !== null;
  };

  const loading = supplySummary === undefined || materials === undefined || collections === undefined;
  const selectedReadyCount = selectedMaterialIds.filter((id) => readyMaterials.some((material) => material._id === id)).length;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">콘텐츠 공급실</h1>
          <p className="max-w-3xl text-sm text-stone-600">운영 자료를 등록하고 채널별 콘텐츠를 검토한 뒤 사용자 라이브러리에 공개합니다. 공개 전까지 모든 자료와 콘텐츠는 운영 화면에만 보입니다.</p>
        </div>
        <Link className="btn-ghost" href="/super/magazines">매거진·큐레이션 관리</Link>
      </header>

      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-label="콘텐츠 공급 단계">
        {[
          ["#supply-materials", "1", "자료 등록", "파일·텍스트·링크와 사용권 확인"],
          ["#supply-collections", "2", "묶음·초안 제작", "자료를 묶고 채널별 문구 작성"],
          ["#supply-review", "3", "검토", "품질·상품 사실·광고·권리 확인"],
          ["#supply-release", "4", "사용자 공개", "사용자 화면에 공급하거나 공개 종료"],
        ].map(([href, number, title, description]) => (
          <li key={number} className="rounded-xl border border-stone-200 bg-white p-3">
            <a className="block rounded-lg" href={href}>
              <span className="flex items-center gap-2"><span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-orange-700 text-xs font-semibold text-white">{number}</span><strong className="text-sm">{title}</strong></span>
              <span className="mt-1 block text-xs text-stone-600">{description}</span>
            </a>
          </li>
        ))}
      </ol>

      {loading ? (
        <p className="rounded-lg bg-stone-100 p-3 text-sm text-stone-600" role="status">공급 현황을 불러오는 중…</p>
      ) : (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="콘텐츠 공급 현황">
          <div className="stat"><span className="k">사용 가능한 자료</span><span className="v">{supplySummary.materials.ready}</span></div>
          <div className="stat"><span className="k">확인 필요한 자료</span><span className="v">{supplySummary.materials.draft}</span></div>
          <div className="stat"><span className="k">검토 중인 묶음</span><span className="v">{supplySummary.collections.inReview}</span></div>
          <div className="stat"><span className="k">사용자 공개 묶음</span><span className="v">{supplySummary.collections.published}</span></div>
        </section>
      )}

      {notice && (
        <div className={`rounded-lg border p-3 text-sm ${notice.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`} role={notice.tone === "error" ? "alert" : "status"} aria-live={notice.tone === "error" ? "assertive" : "polite"}>
          {notice.text}
        </div>
      )}

      <section id="supply-materials" className="scroll-mt-4 card" aria-labelledby="supply-materials-title">
        <div>
          <h2 id="supply-materials-title" className="font-semibold">1. 자료 등록</h2>
          <p className="text-sm text-stone-500">사용 권한과 상품 연결을 확인한 자료만 콘텐츠 묶음에 사용할 수 있습니다.</p>
        </div>
        <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={submitMaterial}>
          <div>
            <label className="label" htmlFor="supply-material-kind">자료 종류</label>
            <select id="supply-material-kind" className="input" value={materialForm.kind} onChange={(event) => {
              const kind = event.target.value as MaterialKind;
              setMaterialForm({ ...materialForm, kind, rightsStatus: kind === "LINK" ? "LINK_ONLY" : materialForm.rightsStatus === "LINK_ONLY" ? "OWNED" : materialForm.rightsStatus });
              setMaterialFile(null);
              setFileInputKey((value) => value + 1);
            }}>
              {(Object.keys(MATERIAL_KIND_LABEL) as MaterialKind[]).map((kind) => <option key={kind} value={kind}>{MATERIAL_KIND_LABEL[kind]}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="supply-material-title">자료 제목</label>
            <input id="supply-material-title" className="input" required maxLength={120} value={materialForm.title} onChange={(event) => setMaterialForm({ ...materialForm, title: event.target.value })} />
          </div>

          {materialForm.kind === "FILE" && (
            <div className="sm:col-span-2">
              <label className="label" htmlFor="supply-material-file">이미지 또는 영상 파일</label>
              <input key={fileInputKey} id="supply-material-file" className="input p-2" type="file" required accept={FILE_ACCEPT} aria-describedby="supply-material-file-help" onChange={(event) => setMaterialFile(event.target.files?.[0] ?? null)} />
              <p id="supply-material-file-help" className="mt-1 text-xs text-stone-500">JPG·PNG·WebP·GIF 이미지는 10 MB 이하, MP4·MOV·WebM 영상은 20 MB 이하로 올려주세요.</p>
              <p className="mt-1 text-xs text-stone-500">파일은 게시 미디어로 연결되며 AI가 화면 속 상품 사실을 추론하지 않습니다. 관련 상품을 연결하거나 텍스트 자료를 함께 등록하세요.</p>
            </div>
          )}
          {materialForm.kind === "TEXT" && (
            <div className="sm:col-span-2">
              <label className="label" htmlFor="supply-material-text">자료 내용</label>
              <textarea id="supply-material-text" className="input" required rows={6} maxLength={20_000} value={materialForm.bodyText} onChange={(event) => setMaterialForm({ ...materialForm, bodyText: event.target.value })} />
            </div>
          )}
          <div className={materialForm.kind === "LINK" ? "sm:col-span-2" : ""}>
            <label className="label" htmlFor="supply-material-url">{materialForm.kind === "LINK" ? "자료 링크" : "원본·출처 URL (선택)"}</label>
            <input id="supply-material-url" className="input" type="url" inputMode="url" required={materialForm.kind === "LINK"} placeholder="https://…" value={materialForm.externalUrl} onChange={(event) => setMaterialForm({ ...materialForm, externalUrl: event.target.value })} />
            {materialForm.kind === "LINK" && <p className="mt-1 text-xs text-stone-500">링크는 출처 확인용으로 저장하며 페이지 본문을 자동 수집하지 않습니다. AI가 활용할 사실은 텍스트 자료로 함께 등록하세요.</p>}
          </div>
          <div>
            <label className="label" htmlFor="supply-material-product">관련 상품 (선택)</label>
            <select id="supply-material-product" className="input" value={materialForm.productId} onChange={(event) => setMaterialForm({ ...materialForm, productId: event.target.value })}>
              <option value="">상품 연결 안 함</option>
              {products?.map((product) => <option key={product._id} value={product._id}>{product.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="supply-material-rights">사용 권한</label>
            <select id="supply-material-rights" className="input" value={materialForm.rightsStatus} onChange={(event) => setMaterialForm({ ...materialForm, rightsStatus: event.target.value as RightsStatus })}>
              {((materialForm.kind === "LINK" ? ["LINK_ONLY"] : ["OWNED", "LICENSED"]) as RightsStatus[]).map((status) => <option key={status} value={status}>{RIGHTS_LABEL[status]}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="supply-material-rights-note">권리·출처 확인 메모</label>
            <input id="supply-material-rights-note" className="input" required maxLength={500} placeholder="예: 자사 촬영 원본, 2026-09-20 사용 허가 확인" value={materialForm.rightsNote} onChange={(event) => setMaterialForm({ ...materialForm, rightsNote: event.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <button className="btn-primary w-full sm:w-auto" disabled={busyAction !== null}>{busyAction === "create-material" ? "자료 등록 중…" : "자료 등록"}</button>
          </div>
        </form>

        <div className="mt-6 border-t border-stone-200 pt-5">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div><h3 className="font-semibold">등록 자료</h3><p className="text-sm text-stone-500">사용 준비가 끝난 자료를 선택하면 다음 단계에서 하나의 콘텐츠 묶음으로 만들 수 있습니다.</p></div>
            <span className="text-sm font-medium">{selectedReadyCount}개 선택</span>
          </div>
          {materials === undefined && <p className="mt-3 text-sm text-stone-500" role="status">자료를 불러오는 중…</p>}
          {materials?.length === 0 && <div className="mt-3 rounded-lg bg-stone-50 p-4 text-sm text-stone-600"><strong className="block text-stone-800">아직 등록한 자료가 없습니다</strong><p className="mt-1">위 양식에서 첫 이미지, 영상, 문구 또는 링크를 등록하세요.</p></div>}
          <ul id="supply-material-list" tabIndex={-1} className="mt-3 grid gap-3 lg:grid-cols-2">
            {materials?.map((material) => {
              const product = material.productId ? productById.get(material.productId) : null;
              const selectable = material.status === "READY";
              const selected = selectedMaterialIds.includes(material._id);
              return (
                <li key={material._id} className={`rounded-xl border p-4 ${selected ? "border-orange-300 bg-orange-50" : "border-stone-200 bg-white"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs"><span className="rounded bg-stone-100 px-2 py-0.5 font-medium">{MATERIAL_KIND_LABEL[material.kind as MaterialKind]}</span><span>{MATERIAL_STATUS_LABEL[material.status as MaterialStatus]}</span></div>
                      <h4 className="mt-2 break-words font-semibold">{material.title}</h4>
                    </div>
                    {selectable && <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 text-sm"><input type="checkbox" checked={selected} onChange={() => toggleMaterial(material._id)} />묶음에 선택</label>}
                  </div>
                  <dl className="mt-3 grid gap-1 text-xs text-stone-600">
                    {material.fileName && <div><dt className="inline font-medium text-stone-800">파일 </dt><dd className="inline break-all">{material.fileName}{material.sizeBytes ? ` · ${fileSize(material.sizeBytes)}` : ""}</dd></div>}
                    {product && <div><dt className="inline font-medium text-stone-800">상품 </dt><dd className="inline">{product.name}</dd></div>}
                    <div><dt className="inline font-medium text-stone-800">권한 </dt><dd className="inline">{RIGHTS_LABEL[material.rightsStatus as RightsStatus]} · {material.rightsNote}</dd></div>
                    <div><dt className="inline font-medium text-stone-800">등록 </dt><dd className="inline">{dateTime(material.createdAt)}</dd></div>
                  </dl>
                  {material.bodyText && <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium text-stone-700">텍스트 원문 보기</summary><p className="mt-2 whitespace-pre-wrap rounded-lg bg-stone-50 p-3">{material.bodyText}</p></details>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(material.previewUrl || material.deliveryUrl) && <a className="btn-ghost" href={material.previewUrl ?? material.deliveryUrl!} target="_blank" rel="noreferrer">업로드 파일 보기<span className="sr-only">: {material.title} (새 창)</span></a>}
                    {material.externalUrl && <a className="btn-ghost" href={material.externalUrl} target="_blank" rel="noreferrer">출처 링크 보기<span className="sr-only">: {material.title} (새 창)</span></a>}
                    {material.status === "DRAFT" && <button className="btn-primary" type="button" disabled={busyAction !== null} onClick={() => perform(`ready-${material._id}`, () => markMaterialReady({ materialId: material._id }), `‘${material.title}’ 자료를 콘텐츠 제작에 사용할 수 있습니다.`)}>사용 준비 완료</button>}
                    {material.status !== "ARCHIVED" && <button className="btn-ghost" type="button" disabled={busyAction !== null} onClick={async () => {
                      if (!window.confirm(`‘${material.title}’ 자료를 보관할까요? 새 콘텐츠 묶음에서는 선택할 수 없게 됩니다.`)) return;
                      const result = await perform(`archive-${material._id}`, () => archiveMaterial({ materialId: material._id }), `‘${material.title}’ 자료를 보관했습니다.`);
                      if (result !== null) setSelectedMaterialIds((current) => current.filter((id) => id !== material._id));
                    }}>자료 보관</button>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section id="supply-collections" className="scroll-mt-4 card" aria-labelledby="supply-collections-title">
        <h2 id="supply-collections-title" className="font-semibold">2. 묶음·채널별 초안 제작</h2>
        <p className="text-sm text-stone-500">함께 제공할 자료를 하나의 묶음으로 만들고, 사용자가 가져갈 채널별 문구를 추가합니다.</p>
        <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={submitNewCollection}>
          <div>
            <label className="label" htmlFor="supply-collection-title">묶음 제목</label>
            <input id="supply-collection-title" className="input" required maxLength={120} value={collectionForm.title} onChange={(event) => setCollectionForm({ ...collectionForm, title: event.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="supply-collection-tags">검색 태그</label>
            <input id="supply-collection-tags" className="input" placeholder="가을 코디, 출근룩, 니트" value={collectionForm.tags} onChange={(event) => setCollectionForm({ ...collectionForm, tags: event.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="supply-collection-summary">사용자에게 보일 설명 (선택)</label>
            <textarea id="supply-collection-summary" className="input" rows={3} maxLength={500} value={collectionForm.summary} onChange={(event) => setCollectionForm({ ...collectionForm, summary: event.target.value })} />
          </div>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
            <button className="btn-primary" disabled={busyAction !== null || selectedReadyCount === 0}>{busyAction === "create-collection" ? "묶음 만드는 중…" : `선택 자료 ${selectedReadyCount}개로 묶음 만들기`}</button>
            {selectedReadyCount === 0 && <span className="text-xs text-amber-800">1단계에서 사용 준비가 끝난 자료를 선택하세요.</span>}
          </div>
        </form>

        <div className="mt-6 border-t border-stone-200 pt-5">
          <h3 className="font-semibold">콘텐츠 묶음</h3>
          {collections === undefined && <p className="mt-3 text-sm text-stone-500" role="status">묶음을 불러오는 중…</p>}
          {collections?.length === 0 && <div className="mt-3 rounded-lg bg-stone-50 p-4 text-sm text-stone-600"><strong className="block text-stone-800">아직 콘텐츠 묶음이 없습니다</strong><p className="mt-1">자료를 선택하고 첫 묶음을 만들어 채널별 게시 초안을 준비하세요.</p></div>}
          <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {collections?.map((item) => {
              const active = selectedCollectionId === item._id;
              return (
                <li key={item._id} className={`rounded-xl border p-4 ${active ? "border-orange-300 bg-orange-50" : "border-stone-200 bg-white"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2"><h4 className="break-words font-semibold">{item.title}</h4><span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium">{COLLECTION_STATUS_LABEL[item.status as CollectionStatus]}</span></div>
                  {item.summary && <p className="mt-2 text-sm text-stone-600">{item.summary}</p>}
                  <p className="mt-3 text-xs text-stone-600">자료 {item.materialCount}개 · 콘텐츠 {item.pieceCount}개 · 승인 {item.approvedPieceCount}개</p>
                  {item.tags.length > 0 && <p className="mt-1 break-words text-xs text-sky-700">{item.tags.map((tag) => `#${tag}`).join(" ")}</p>}
                  <button className={active ? "btn-primary mt-3 w-full" : "btn-ghost mt-3 w-full"} type="button" aria-pressed={active} onClick={() => setSelectedCollectionId(item._id)}>{active ? "선택한 묶음" : "초안·검토 열기"}</button>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section id="supply-review" className="scroll-mt-4 flex flex-col gap-4" aria-labelledby="supply-review-title">
        <div>
          <h2 id="supply-review-title" className="font-semibold">3. 콘텐츠 검토</h2>
          <p className="text-sm text-stone-500">묶음을 열어 채널별 초안을 작성하고 네 가지 사람 검토 항목을 모두 확인하세요.</p>
        </div>
        {!selectedCollectionId && <div className="card text-sm text-stone-600"><strong className="block text-stone-800">검토할 묶음을 선택하세요</strong><p className="mt-1">2단계의 콘텐츠 묶음에서 ‘초안·검토 열기’를 선택하세요.</p></div>}
        {selectedCollectionId && collection === undefined && <div className="card text-sm text-stone-500" role="status">선택한 묶음을 불러오는 중…</div>}
        {collection && (
          <div id="supply-collection-detail" tabIndex={-1} className="flex flex-col gap-4">
            <div className="card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-semibold">{collection.title}</h3><span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium">{COLLECTION_STATUS_LABEL[collection.status as CollectionStatus]}</span></div>{collection.summary && <p className="mt-1 text-sm text-stone-600">{collection.summary}</p>}</div>
                <span className="text-xs text-stone-500">개정 {collection.revision} · {dateTime(collection.updatedAt)}</span>
              </div>
              <dl className="mt-4 grid grid-cols-3 gap-2 text-center text-sm">
                <div className="rounded-lg bg-stone-50 p-2"><dt className="text-xs text-stone-500">자료</dt><dd className="font-semibold tabular-nums">{collection.materials.length}</dd></div>
                <div className="rounded-lg bg-stone-50 p-2"><dt className="text-xs text-stone-500">콘텐츠</dt><dd className="font-semibold tabular-nums">{collection.pieces.length}</dd></div>
                <div className="rounded-lg bg-emerald-50 p-2"><dt className="text-xs text-emerald-700">승인</dt><dd className="font-semibold tabular-nums text-emerald-800">{collection.pieces.filter((piece) => piece.status === "APPROVED").length}</dd></div>
              </dl>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {collection.status === "DRAFT" && <button className="btn-primary" type="button" disabled={busyAction !== null || collection.pieces.length === 0 || collection.runs.some((run) => run.status === "PENDING")} onClick={() => confirmCollectionAction("submit")}>검토 단계로 제출</button>}
                {collection.status === "IN_REVIEW" && <button className="btn-ghost" type="button" disabled={busyAction !== null} onClick={() => confirmCollectionAction("reopen")}>초안으로 다시 열기</button>}
                {collection.status === "DRAFT" && collection.pieces.length === 0 && <span className="text-xs text-amber-800">채널별 콘텐츠를 하나 이상 추가한 뒤 검토를 시작하세요.</span>}
                {collection.status === "IN_REVIEW" && <span className="text-xs text-stone-600">수정이 필요하면 먼저 초안으로 다시 여세요.</span>}
              </div>
            </div>

            <section className="card" aria-labelledby="supply-review-evidence-title">
              <h3 id="supply-review-evidence-title" className="font-semibold">검토 근거 자료</h3>
              <p className="text-sm text-stone-500">콘텐츠에 사용한 원문과 권리 근거를 함께 확인하세요.</p>
              <ul className="mt-3 grid gap-2 md:grid-cols-2">
                {collection.materials.map((material) => (
                  <li key={material._id} className="rounded-lg border border-stone-200 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2"><strong className="break-words">{material.title}</strong><span className="rounded bg-stone-100 px-2 py-0.5 text-xs">{RIGHTS_LABEL[material.rightsStatus as RightsStatus]}</span></div>
                    <p className="mt-1 text-xs text-stone-600">{material.rightsNote}</p>
                    <div className="mt-2 flex flex-wrap gap-3 text-xs">
                      {(material.previewUrl || material.deliveryUrl) && <a className="font-medium underline" href={material.previewUrl ?? material.deliveryUrl!} target="_blank" rel="noreferrer">업로드 파일 확인<span className="sr-only">: {material.title} (새 창)</span></a>}
                      {material.externalUrl && <a className="font-medium underline" href={material.externalUrl} target="_blank" rel="noreferrer">원문 링크 확인<span className="sr-only">: {material.title} (새 창)</span></a>}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {collection.status === "DRAFT" && (
              <section className="card" aria-labelledby="supply-production-input-title">
                <h3 id="supply-production-input-title" className="font-semibold">제작에 사용할 근거 선택</h3>
                <p className="text-sm text-stone-500">아래 AI 생성과 수동 초안이 같은 상품·근거 자료를 사용합니다.</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="supply-piece-product">관련 상품 (선택)</label>
                    <select id="supply-piece-product" className="input" value={pieceForm.productId} onChange={(event) => setPieceForm({ ...pieceForm, productId: event.target.value })}><option value="">자료의 연결 상품 자동 적용</option>{products?.map((product) => <option key={product._id} value={product._id}>{product.name}</option>)}</select>
                  </div>
                  <fieldset className="sm:col-span-2">
                    <legend className="label">근거 자료</legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {collection.materials.map((material) => <label key={material._id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-stone-200 px-3 text-sm"><input type="checkbox" checked={pieceMaterialIds.includes(material._id)} onChange={() => togglePieceMaterial(material._id)} /><span className="min-w-0 break-words">{material.title}</span></label>)}
                    </div>
                  </fieldset>
                </div>
              </section>
            )}

            {collection.status === "DRAFT" && <form className="card space-y-4" onSubmit={async (event) => {
              event.preventDefault();
              const args = { collectionId: collection._id, sourceMaterialIds: pieceMaterialIds as Id<"contentSourceMaterials">[],
                productId: pieceForm.productId ? pieceForm.productId as Id<"products"> : undefined, channels: aiChannels,
                brief: { goal: "ENGAGEMENT", tone: "CHANNEL_NATIVE", cta: "SAVE", audience: aiAudience, keyMessage: aiMessage } };
              const fingerprint = JSON.stringify(args);
              if (aiRequest.current?.fingerprint !== fingerprint) aiRequest.current = { fingerprint, id: crypto.randomUUID() };
              const result = await perform("generate-ai", () => requestGenerate({ ...args, clientRequestId: aiRequest.current!.id }), "AI 생성 요청을 보냈습니다. 결과가 도착하면 아래에서 검토하세요.");
              if (result) aiRequest.current = null;
            }}>
              <div><h3 className="font-semibold">운영 자료로 AI 콘텐츠 생성</h3><p className="text-sm text-stone-600">위에서 선택한 근거 자료·상품을 사용합니다. PC 앱의 Codex가 채널별 문구를 만들고 검토 대기 초안으로 저장합니다.</p></div>
              <p className="text-sm" role="status">PC {deviceOnline ? "온라인" : "연결 필요"} · Codex {codexReady ? "로그인 확인" : "로그인 필요"} · 앱 {activeDevice?.appVersion ?? "미연결"}{!appVersionReady && " (0.1.16 이상 필요)"} <Link className="underline" href="/dashboard/connections#ai">연결 관리</Link></p>
              <fieldset><legend className="label">AI 생성 채널</legend><div className="flex flex-wrap gap-3">{CHANNEL_ORDER.map((channel) => <label className="flex min-h-11 items-center gap-2 text-sm" key={channel}><input type="checkbox" checked={aiChannels.includes(channel)} onChange={() => setAiChannels((current) => current.includes(channel) ? current.filter((item) => item !== channel) : [...current, channel])} />{CHANNEL_LABEL[channel]}</label>)}</div></fieldset>
              <div><label className="label" htmlFor="supply-ai-audience">대상 독자</label><input className="input" id="supply-ai-audience" required maxLength={200} value={aiAudience} onChange={(event) => setAiAudience(event.target.value)} /></div>
              <div><label className="label" htmlFor="supply-ai-message">전달할 핵심 메시지</label><textarea className="input" id="supply-ai-message" rows={3} maxLength={300} value={aiMessage} onChange={(event) => setAiMessage(event.target.value)} /></div>
              <p className="text-xs text-stone-600">선택 자료 {pieceMaterialIds.length}개 · 관련 상품 {pieceForm.productId ? productById.get(pieceForm.productId as Id<"products">)?.name : "자료의 연결 상품 자동 적용"}. 자료 원문과 사용권 근거는 요청 시점에 저장됩니다.</p>
              {!aiHasFactEvidence && <p className="text-xs font-medium text-amber-800">판매 상품을 연결하거나 내용이 입력된 텍스트 자료를 선택해야 합니다. 링크·이미지만으로 상품 사실을 만들지 않습니다.</p>}
              <button className="btn-primary" disabled={busyAction !== null || !deviceOnline || !codexReady || !appVersionReady || !pieceMaterialIds.length || !aiChannels.length || !aiAudience.trim() || !aiHasFactEvidence}>{busyAction === "generate-ai" ? "생성 요청 중…" : "선택 자료로 AI 초안 생성"}</button>
            </form>}
            {collection.runs.length > 0 && <section className="card" aria-labelledby="supply-ai-runs"><h3 id="supply-ai-runs" className="font-semibold">AI 생성 진행</h3><ul className="mt-3 space-y-2">{collection.runs.map((run) => <li key={run._id} className="rounded-lg bg-stone-50 p-3 text-sm"><p>{run.channels.map((channel) => CHANNEL_LABEL[channel as Channel]).join(" · ")} · {run.status === "PENDING" ? "PC 생성 대기·진행 중" : run.status === "QUARANTINED" ? "컬렉션 변경으로 결과 연결 제외" : run.status === "FAILED" ? "생성 실패" : "결과 검토 가능"}</p><p className="mt-1 text-xs text-stone-600">{dateTime(run.createdAt)}{run.quarantineReason && ` · ${run.quarantineReason}`}</p></li>)}</ul></section>}
            {collection.status === "DRAFT" && (
              <form className="card grid gap-3 sm:grid-cols-2" onSubmit={submitPiece}>
                <div className="sm:col-span-2"><h3 className="font-semibold">채널별 콘텐츠 초안 추가</h3><p className="text-sm text-stone-500">선택 자료의 이미지·영상은 초안에 자동으로 연결됩니다.</p></div>
                <div>
                  <label className="label" htmlFor="supply-piece-channel">채널</label>
                  <select id="supply-piece-channel" className="input" value={pieceForm.channel} onChange={(event) => setPieceForm({ ...pieceForm, channel: event.target.value as Channel })}>{CHANNEL_ORDER.map((channel) => <option key={channel} value={channel}>{CHANNEL_LABEL[channel]}</option>)}</select>
                </div>
                <div className="sm:col-span-2">
                  <label className="label" htmlFor="supply-piece-caption">본문</label>
                  <textarea id="supply-piece-caption" className="input" required rows={6} maxLength={5_000} value={pieceForm.caption} onChange={(event) => setPieceForm({ ...pieceForm, caption: event.target.value })} />
                </div>
                <div>
                  <label className="label" htmlFor="supply-piece-hashtags">해시태그</label>
                  <input id="supply-piece-hashtags" className="input" value={pieceForm.hashtags} onChange={(event) => setPieceForm({ ...pieceForm, hashtags: event.target.value })} placeholder="광고 데일리룩 코디" />
                </div>
                <div>
                  <label className="label" htmlFor="supply-piece-script">숏폼 대본 (선택)</label>
                  <textarea id="supply-piece-script" className="input" rows={3} value={pieceForm.script} onChange={(event) => setPieceForm({ ...pieceForm, script: event.target.value })} />
                </div>
                <div className="sm:col-span-2"><button className="btn-primary" disabled={busyAction !== null || pieceMaterialIds.length === 0}>{busyAction === "add-piece" ? "초안 추가 중…" : "채널별 초안 추가"}</button></div>
              </form>
            )}

            <div className="grid gap-3 lg:grid-cols-2">
              {collection.pieces.length === 0 && <div className="card text-sm text-stone-600 lg:col-span-2"><strong className="block text-stone-800">채널별 콘텐츠가 없습니다</strong><p className="mt-1">묶음이 초안 상태일 때 위 양식에서 첫 콘텐츠를 추가하세요.</p></div>}
              {collection.pieces.map((piece) => (
                <PieceCard
                  key={piece._id}
                  p={{ ...piece, mine: true }}
                  publishingDisabledReason="운영 공급 콘텐츠는 4단계에서 묶음 단위로 사용자에게 공개됩니다"
                  onApprove={collection.status === "IN_REVIEW" ? (reviewChecklist: ReviewChecklist) => runPieceAction(() => approvePiece({
                    pieceId: piece._id,
                    ...(piece.productionMeta?.outputHash ? { expectedOutputHash: piece.productionMeta.outputHash } : {}),
                    reviewChecklist,
                  }), "콘텐츠를 승인했습니다.") : undefined}
                  onEdit={collection.status === "DRAFT" ? (value) => runPieceAction(() => editPiece({ pieceId: piece._id, ...value }), "콘텐츠를 수정했습니다. 변경된 내용을 다시 검토하세요.") : undefined}
                  onReject={collection.status === "DRAFT" ? (reason) => runPieceAction(() => rejectPiece({ pieceId: piece._id, reason }), "콘텐츠를 폐기했습니다.") : undefined}
                  onRemove={collection.status === "DRAFT" ? async () => {
                    if (!window.confirm("이 콘텐츠를 묶음에서 제거할까요? 감사 기록은 유지되며 사용자에게 공개되지 않습니다.")) return;
                    await runPieceAction(() => removePiece({ collectionId: collection._id, pieceId: piece._id }), "콘텐츠를 묶음에서 제거했습니다.");
                  } : undefined}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      <section id="supply-release" className="scroll-mt-4 card" aria-labelledby="supply-release-title">
        <h2 id="supply-release-title" className="font-semibold">4. 사용자 공개</h2>
        <p className="text-sm text-stone-500">묶음의 모든 콘텐츠를 검토·승인한 뒤 사용자 콘텐츠 라이브러리에 공개합니다.</p>
        {!collection && <p className="mt-4 rounded-lg bg-stone-50 p-3 text-sm text-stone-600">공개 상태를 관리할 콘텐츠 묶음을 먼저 선택하세요.</p>}
        {collection && (() => {
          const pieceCount = collection.pieces.length;
          const approvedCount = collection.pieces.filter((piece) => piece.status === "APPROVED").length;
          const readyToPublish = pieceCount > 0 && approvedCount === pieceCount;
          return (
            <div className="mt-4">
              <div className={`rounded-lg border p-4 text-sm ${readyToPublish ? "border-emerald-200 bg-emerald-50 text-emerald-950" : "border-amber-200 bg-amber-50 text-amber-950"}`} role="status">
                <strong>{collection.title}</strong>
                <p className="mt-1">콘텐츠 {pieceCount}개 중 {approvedCount}개 승인 · 현재 {COLLECTION_STATUS_LABEL[collection.status as CollectionStatus]}</p>
                {!readyToPublish && <p className="mt-1">모든 콘텐츠의 품질 문제를 해결하고 네 가지 사람 검토 항목을 확인해야 공개할 수 있습니다.</p>}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {collection.status === "DRAFT" && <span className="rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-600">3단계에서 검토를 시작하세요.</span>}
                {collection.status === "IN_REVIEW" && <button className="btn-primary" type="button" disabled={busyAction !== null || !readyToPublish} onClick={() => confirmCollectionAction("publish")}>사용자에게 공개</button>}
                {collection.status === "PUBLISHED" && <button className="btn-ghost" type="button" disabled={busyAction !== null} onClick={() => confirmCollectionAction("withdraw")}>사용자 공개 종료</button>}
                {collection.status === "WITHDRAWN" && <button className="btn-primary" type="button" disabled={busyAction !== null} onClick={() => confirmCollectionAction("reopen")}>초안으로 다시 열기</button>}
                <Link className="btn-ghost" href="/dashboard/content">사용자 라이브러리 화면 보기</Link>
              </div>
            </div>
          );
        })()}
      </section>
    </div>
  );
}
