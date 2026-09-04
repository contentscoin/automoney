import { ATTRIBUTIONS, INDIRECT_WINDOW_MS, ORDER_STATUSES } from "./constants";
import type { Attribution, OrderStatus } from "./constants";

/** docs/04-integrations.md §1.3 주문 웹훅 페이로드 */
export type AttrangsOrderEventType =
  | "order.created"
  | "order.cancelled"
  | "order.refunded"
  | "order.confirmed";

export interface AttrangsOrderItem {
  product_id: number;
  qty: number;
  amount: number;
  commissionable_amount: number;
}

export interface AttrangsOrderWebhook {
  event_id: string;
  event_type: AttrangsOrderEventType;
  occurred_at: string;
  order: {
    order_id: string;
    ordered_at: string;
    tracking_code: string | null;
    attribution: "direct" | "indirect" | null;
    clicked_at: string | null;
    landing_product_id: number | null;
    items: AttrangsOrderItem[];
    order_amount: number;
    commissionable_amount: number;
    status: "paid" | "cancelled" | "refunded" | "confirmed";
  };
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const EVENT_TYPES: AttrangsOrderEventType[] = [
  "order.created",
  "order.cancelled",
  "order.refunded",
  "order.confirmed",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}
function isoDate(v: unknown): v is string {
  return str(v) && !Number.isNaN(Date.parse(v));
}

/** 외부 입력을 신뢰하지 않고 필드별로 검증한다. 라이브러리 없이 동작(Convex 런타임 호환). */
export function parseAttrangsOrderWebhook(raw: unknown): ParseResult<AttrangsOrderWebhook> {
  if (!isRecord(raw)) return { ok: false, error: "body must be an object" };
  if (!str(raw.event_id) || raw.event_id.length > 128) return { ok: false, error: "event_id invalid" };
  if (!EVENT_TYPES.includes(raw.event_type as AttrangsOrderEventType)) {
    return { ok: false, error: "event_type invalid" };
  }
  if (!isoDate(raw.occurred_at)) return { ok: false, error: "occurred_at invalid" };
  const o = raw.order;
  if (!isRecord(o)) return { ok: false, error: "order missing" };
  if (!str(o.order_id) || o.order_id.length > 128) return { ok: false, error: "order.order_id invalid" };
  if (!isoDate(o.ordered_at)) return { ok: false, error: "order.ordered_at invalid" };
  const tracking = o.tracking_code == null ? null : o.tracking_code;
  if (tracking !== null && !str(tracking)) return { ok: false, error: "order.tracking_code invalid" };
  const attribution = o.attribution == null ? null : o.attribution;
  if (attribution !== null && attribution !== "direct" && attribution !== "indirect") {
    return { ok: false, error: "order.attribution invalid" };
  }
  const clickedAt = o.clicked_at == null ? null : o.clicked_at;
  if (clickedAt !== null && !isoDate(clickedAt)) return { ok: false, error: "order.clicked_at invalid" };
  const landing = o.landing_product_id == null ? null : o.landing_product_id;
  if (landing !== null && !num(landing)) return { ok: false, error: "order.landing_product_id invalid" };
  if (!Array.isArray(o.items) || o.items.length === 0 || o.items.length > 200) {
    return { ok: false, error: "order.items invalid" };
  }
  const items: AttrangsOrderItem[] = [];
  for (const it of o.items) {
    if (!isRecord(it) || !num(it.product_id) || !num(it.qty) || !num(it.amount) || !num(it.commissionable_amount)) {
      return { ok: false, error: "order.items[] invalid" };
    }
    items.push({
      product_id: it.product_id,
      qty: it.qty,
      amount: it.amount,
      commissionable_amount: it.commissionable_amount,
    });
  }
  if (!num(o.order_amount) || !num(o.commissionable_amount)) {
    return { ok: false, error: "order amounts invalid" };
  }
  if (!["paid", "cancelled", "refunded", "confirmed"].includes(String(o.status))) {
    return { ok: false, error: "order.status invalid" };
  }
  return {
    ok: true,
    value: {
      event_id: raw.event_id,
      event_type: raw.event_type as AttrangsOrderEventType,
      occurred_at: raw.occurred_at,
      order: {
        order_id: o.order_id,
        ordered_at: o.ordered_at,
        tracking_code: tracking,
        attribution,
        clicked_at: clickedAt,
        landing_product_id: landing,
        items,
        order_amount: o.order_amount,
        commissionable_amount: o.commissionable_amount,
        status: o.status as AttrangsOrderWebhook["order"]["status"],
      },
    },
  };
}

export function toOrderStatus(s: AttrangsOrderWebhook["order"]["status"]): OrderStatus {
  const upper = s.toUpperCase() as OrderStatus;
  if (!ORDER_STATUSES.includes(upper)) throw new Error(`unknown status ${s}`);
  return upper;
}

/**
 * 아뜨랑스가 보낸 어트리뷰션을 24h 창으로 재검증한다.
 * clicked_at 이 없거나 24h 를 초과하면 어트리뷰션을 인정하지 않는다(null).
 */
export function resolveAttribution(input: {
  attribution: "direct" | "indirect" | null;
  clickedAt: string | null;
  orderedAt: string;
}): Attribution | null {
  if (!input.attribution || !input.clickedAt) return null;
  const clicked = Date.parse(input.clickedAt);
  const ordered = Date.parse(input.orderedAt);
  if (Number.isNaN(clicked) || Number.isNaN(ordered)) return null;
  const delta = ordered - clicked;
  if (delta < 0 || delta > INDIRECT_WINDOW_MS) return null;
  const upper = input.attribution.toUpperCase() as Attribution;
  return ATTRIBUTIONS.includes(upper) ? upper : null;
}
