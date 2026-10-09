"use client";

import { useId, useState } from "react";
import type { FunctionArgs } from "convex/server";
import type { Doc } from "@/convex/_generated/dataModel";
import type { api } from "@/convex/_generated/api";

type ProductOption = Pick<Doc<"products">, "_id" | "name">;

export function MaterialEditor({ material, products, busy, onSave }: {
  material: Doc<"contentSourceMaterials">;
  products: ProductOption[];
  busy: boolean;
  onSave: (value: FunctionArgs<typeof api.adminContent.updateMaterial>) => Promise<boolean>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [baseVersion, setBaseVersion] = useState(material.updatedAt);
  const [form, setForm] = useState(() => ({ title: material.title, bodyText: material.bodyText ?? "", externalUrl: material.externalUrl ?? "", productId: material.productId ?? "", rightsStatus: material.rightsStatus, rightsNote: material.rightsNote }));
  if (!open) return <button className="btn-ghost" type="button" disabled={busy} onClick={() => {
    setForm({ title: material.title, bodyText: material.bodyText ?? "", externalUrl: material.externalUrl ?? "", productId: material.productId ?? "", rightsStatus: material.rightsStatus, rightsNote: material.rightsNote });
    setBaseVersion(material.updatedAt);
    setOpen(true);
  }}>자료 수정</button>;
  return <form className="mt-3 grid w-full gap-3 rounded-lg border border-orange-200 bg-white p-3" onSubmit={async (event) => {
    event.preventDefault();
    const saved = await onSave({ materialId: material._id, expectedUpdatedAt: baseVersion, ...form,
      productId: (form.productId || null) as Doc<"products">["_id"] | null,
      bodyText: material.kind === "TEXT" ? form.bodyText : undefined,
    });
    if (saved) setOpen(false);
  }}>
    {material.updatedAt !== baseVersion && <p className="text-sm text-amber-800" role="alert">다른 작업에서 자료가 변경되었습니다. 입력 내용을 복사해 보관한 뒤 취소하고 다시 열어 최신 내용과 비교하세요.</p>}
    <div><label className="label" htmlFor={`${id}-title`}>자료 제목 수정</label><input className="input" id={`${id}-title`} required maxLength={120} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></div>
    {material.kind === "TEXT" && <div><label className="label" htmlFor={`${id}-body`}>자료 내용 수정</label><textarea className="input" id={`${id}-body`} required rows={5} maxLength={20_000} value={form.bodyText} onChange={(event) => setForm({ ...form, bodyText: event.target.value })} /></div>}
    {material.kind === "FILE" && <p className="text-xs text-stone-600">업로드한 파일은 교체할 수 없습니다. 파일이 잘못되었다면 새 자료로 등록하세요.</p>}
    <div><label className="label" htmlFor={`${id}-url`}>원본·출처 URL</label><input className="input" id={`${id}-url`} type="url" required={material.kind === "LINK"} value={form.externalUrl} onChange={(event) => setForm({ ...form, externalUrl: event.target.value })} /></div>
    <div><label className="label" htmlFor={`${id}-product`}>관련 상품 수정</label><select className="input" id={`${id}-product`} value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })}><option value="">상품 연결 안 함</option>{material.productId && !products.some((item) => item._id === material.productId) && <option value={material.productId}>현재 연결 상품 유지</option>}{products.map((product) => <option key={product._id} value={product._id}>{product.name}</option>)}</select></div>
    <div><label className="label" htmlFor={`${id}-rights`}>사용 권한 수정</label><select className="input" id={`${id}-rights`} value={form.rightsStatus} onChange={(event) => setForm({ ...form, rightsStatus: event.target.value as typeof form.rightsStatus })}>{material.kind === "LINK" ? <option value="LINK_ONLY">링크만 인용</option> : <><option value="OWNED">자체 제작·소유</option><option value="LICENSED">사용 허가 확인</option></>}</select></div>
    <div><label className="label" htmlFor={`${id}-note`}>권리·출처 확인 메모 수정</label><input className="input" id={`${id}-note`} required maxLength={500} value={form.rightsNote} onChange={(event) => setForm({ ...form, rightsNote: event.target.value })} /></div>
    <div className="flex flex-wrap gap-2"><button className="btn-primary" disabled={busy}>수정 저장</button><button className="btn-ghost" type="button" disabled={busy} onClick={() => setOpen(false)}>취소</button></div>
  </form>;
}

export function CollectionEditor({ collection, materials, busy, onSave, onDiscard }: {
  collection: Doc<"contentCollections">;
  materials: Doc<"contentSourceMaterials">[];
  busy: boolean;
  onSave: (value: FunctionArgs<typeof api.adminContent.updateCollection>) => Promise<boolean>;
  onDiscard: () => Promise<unknown>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [baseRevision, setBaseRevision] = useState(collection.revision);
  const [form, setForm] = useState(() => ({ title: collection.title, summary: collection.summary ?? "", tags: collection.tags.join(", "), sourceMaterialIds: collection.sourceMaterialIds }));
  return <div className="mt-4 border-t border-stone-200 pt-3">
    <div className="flex flex-wrap gap-2"><button className="btn-ghost" type="button" disabled={busy} aria-expanded={open} onClick={() => {
      if (!open) { setForm({ title: collection.title, summary: collection.summary ?? "", tags: collection.tags.join(", "), sourceMaterialIds: collection.sourceMaterialIds }); setBaseRevision(collection.revision); }
      setOpen(!open);
    }}>{open ? "묶음 수정 닫기" : "묶음 정보·자료 수정"}</button><button className="btn-ghost text-rose-700" type="button" disabled={busy} onClick={onDiscard}>초안 묶음 폐기</button></div>
    {open && <form className="mt-3 grid gap-3" onSubmit={async (event) => {
      event.preventDefault();
      const saved = await onSave({ collectionId: collection._id, expectedRevision: baseRevision,
        title: form.title, summary: form.summary, tags: [...new Set(form.tags.split(/[,\n]/).map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean))], sourceMaterialIds: form.sourceMaterialIds });
      if (saved) setOpen(false);
    }}>
      {collection.revision !== baseRevision && <p className="text-sm text-amber-800" role="alert">묶음이 다른 작업에서 변경되었습니다. 입력 내용을 복사해 보관한 뒤 수정을 닫고 다시 열어 최신 내용과 비교하세요.</p>}
      <div><label className="label" htmlFor={`${id}-title`}>묶음 제목 수정</label><input className="input" id={`${id}-title`} required maxLength={120} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></div>
      <div><label className="label" htmlFor={`${id}-summary`}>묶음 설명 수정</label><textarea className="input" id={`${id}-summary`} rows={2} maxLength={500} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></div>
      <div><label className="label" htmlFor={`${id}-tags`}>검색 태그 수정 (쉼표로 구분)</label><input className="input" id={`${id}-tags`} value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} /></div>
      <fieldset><legend className="label">묶음 자료 수정 · {form.sourceMaterialIds.length}/30개</legend><p className="mb-2 text-xs text-stone-600">이미 콘텐츠의 근거로 사용한 자료는 해당 콘텐츠를 제거한 뒤 뺄 수 있습니다. 새 자료가 없다면 1단계에서 사용 준비를 완료하고 목록을 더 불러오세요.</p><div className="grid gap-2 sm:grid-cols-2">{materials.map((material) => <label key={material._id} className="flex min-h-11 items-center gap-2 rounded border border-stone-200 p-2 text-sm"><input type="checkbox" checked={form.sourceMaterialIds.includes(material._id)} onChange={() => setForm({ ...form, sourceMaterialIds: form.sourceMaterialIds.includes(material._id) ? form.sourceMaterialIds.filter((item) => item !== material._id) : [...form.sourceMaterialIds, material._id] })} /><span className="break-words">{material.title}</span></label>)}</div></fieldset>
      <div><button className="btn-primary" disabled={busy || form.sourceMaterialIds.length === 0 || form.sourceMaterialIds.length > 30}>묶음 수정 저장</button></div>
    </form>}
  </div>;
}
