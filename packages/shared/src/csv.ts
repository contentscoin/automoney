/** RFC4180 호환 최소 CSV 파서 (따옴표·이스케이프·개행 지원). 상품 CSV 임포트용. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export interface ProductCsvRow {
  attrangsProductId: number;
  name: string;
  price: number;
  salePrice: number | null;
  category: string | null;
  imageUrls: string[];
  detailUrl: string;
  status: "ACTIVE" | "INACTIVE";
}

export const PRODUCT_CSV_HEADERS = [
  "product_id",
  "name",
  "price",
  "sale_price",
  "category",
  "image_urls",
  "detail_url",
  "status",
] as const;

export function parseProductCsv(text: string): { rows: ProductCsvRow[]; errors: string[] } {
  const table = parseCsv(text);
  const errors: string[] = [];
  const rows: ProductCsvRow[] = [];
  if (table.length === 0) return { rows, errors: ["empty csv"] };
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  for (const required of ["product_id", "name", "price", "detail_url"]) {
    if (idx(required) < 0) errors.push(`missing column: ${required}`);
  }
  if (errors.length > 0) return { rows, errors };
  for (let r = 1; r < table.length; r++) {
    const line = table[r]!;
    const get = (name: string) => {
      const i = idx(name);
      return i >= 0 ? (line[i] ?? "").trim() : "";
    };
    const id = Number(get("product_id"));
    const price = Number(get("price"));
    const saleRaw = get("sale_price");
    const salePrice = saleRaw === "" ? null : Number(saleRaw);
    const detailUrl = get("detail_url");
    if (!Number.isInteger(id) || id <= 0) {
      errors.push(`row ${r + 1}: product_id invalid`);
      continue;
    }
    if (!get("name")) {
      errors.push(`row ${r + 1}: name empty`);
      continue;
    }
    if (!Number.isFinite(price) || price < 0) {
      errors.push(`row ${r + 1}: price invalid`);
      continue;
    }
    if (salePrice !== null && (!Number.isFinite(salePrice) || salePrice < 0)) {
      errors.push(`row ${r + 1}: sale_price invalid`);
      continue;
    }
    if (!/^https?:\/\//.test(detailUrl)) {
      errors.push(`row ${r + 1}: detail_url invalid`);
      continue;
    }
    const statusRaw = get("status").toUpperCase();
    rows.push({
      attrangsProductId: id,
      name: get("name"),
      price,
      salePrice,
      category: get("category") || null,
      imageUrls: get("image_urls")
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean),
      detailUrl,
      status: statusRaw === "INACTIVE" ? "INACTIVE" : "ACTIVE",
    });
  }
  return { rows, errors };
}
