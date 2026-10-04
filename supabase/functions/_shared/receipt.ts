// ============================================================
// supabase/functions/_shared/receipt.ts — the scan-receipt function's logic
//
// Photo(s) of a supermarket till receipt in → structured lines out, for
// Grocery spending (receipt-scanner findings §3). One request carries 1–3
// overlapping photos of ONE receipt, in order, top to bottom, and makes ONE
// Messages call.
//
// THE MODEL TRANSCRIBES, THE SERVER CALCULATES. The model returns every
// amount as the string printed ("12.30", "0.50-"); this file parses,
// redacts, validates and flags, deterministically, and that's what the
// tests (__tests__/receipt.test.ts) pin.
//
// Lives in _shared, not in scan-receipt/index.ts, so vitest can import it:
// it reads no Deno globals and imports nothing remote. Everything from the
// outside world — the caller's id, the service-role client, fetch, the
// secrets, the clock — comes in through `deps`, which index.ts fills.
//
// STATELESS: nothing about the receipt is stored or logged here. The only
// write is one ai_extractions row per request, for the shared hourly limit.
// Never console.* the tool input or the result.
// ============================================================

import { preflight, json, fail } from "./cors.ts";

// ─── Config ──────────────────────────────────────────────────────────────────

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Chosen by the bake-off (findings commit 0): Sonnet 5 on the high-res tier,
// exact on single photos. Overridable with the RECEIPT_MODEL secret — its
// own secret, never the shared MODEL the other three functions read.
//
// ⚠ Before changing RECEIPT_MODEL: this function FORCES tool_choice, which
// is a 400 on Claude Opus 5.5 and Claude Fable 5.1. And Sonnet 5 runs
// adaptive thinking when `thinking` is omitted, which counts toward
// max_tokens — so `thinking` is set explicitly below.
export const DEFAULT_RECEIPT_MODEL = "claude-sonnet-5";

// About 71 output tokens per line, MEASURED in the bake-off, so the 150-line
// cap is about 10.7k; 16,000 leaves margin (findings §3).
export const MAX_TOKENS = 16_000;

// The bake-off's longest receipt took 39 s; a 150-line one is about 75 s.
// Below Supabase's 150 s idle timeout, since nothing is sent until the model
// returns. Don't raise it: shorten the output or the line cap instead.
export const ANTHROPIC_TIMEOUT_MS = 120_000;

export const MAX_RECEIPT_PARTS = 3;
export const MAX_PART_BASE64_CHARS = 3_500_000;
export const MAX_TOTAL_BASE64_CHARS = 9_000_000;
export const MAX_LINES = 150;
const MAX_RAW_TEXT = 120;
const MAX_STORE = 60;

// Shared with scan-meal-photo and extract-nutrition-label: one hourly budget
// across every AI scan. A multi-part receipt is ONE scan (one row).
export const MAX_EXTRACTIONS_PER_HOUR = 20;

const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];

// ─── Prompt and tool — the output contract ───────────────────────────────────

export const SYSTEM_PROMPT = `You transcribe a supermarket till receipt from one or more photographs into structured fields. You are a careful transcriber, not an accountant.

Rules, in priority order:
1. TRANSCRIBE, DON'T COMPUTE OR CORRECT. If a figure is unreadable, return null. Never guess a digit and never make the lines add up to the total.
2. PARTS. The images are consecutive parts of ONE receipt, top to bottom, each overlapping the next by a line or two. List every physical item line exactly once. Before you list the first lines of part k+1, find in part k+1 the last line you listed from part k, and continue after it: the lines before it in part k+1 are the overlap and were already listed. A line cut by the edge of a photo is listed once, from the part where it is fully legible, with that part number. If the parts do not look like the same receipt, set same_receipt to false.
3. HEADER AND TOTAL. Store and date come from part 1 (the header), or from the foot if the date is only printed there. total_printed comes from the LAST part that shows one, and total_printed_part says which part.
4. ITEM AND DISCOUNT LINES ONLY. EXCLUDE: payment/tender lines (card type, masked or full card numbers, AID, auth codes, merchant or terminal IDs); change, cash, cashback; loyalty-card numbers, points balances, member names; VAT summary tables; store address, phone, VAT number, till/operator/transaction numbers, barcodes and QR text; total-savings summary lines. A price saving named after a loyalty scheme ("Nectar Price Saving", "Clubcard Price") is NOT a loyalty line: it is a discount (rule 5).
5. DISCOUNTS are their own lines with is_discount true, including multibuy savings printed at the end and loyalty price savings. A VOID is two lines: list the voided item as printed, and its cancel line ("ITEM CANCELLED" with the negative amount) as a separate line with is_discount true.
6. total_printed is the final amount due for goods after all savings, not SUBTOTAL and not the card or cash tendered.
7. Amounts are strings EXACTLY as printed, e.g. "12.30", "0.50-".
8. DATES are UK DD/MM unless the receipt clearly shows otherwise. Return YYYY-MM-DD, or null if the day and month are ambiguous.
9. store_name is the chain or brand only: no address, branch number or phone.
10. If a part is cut off, return what is visible.`;

const NULLABLE_STRING = { type: ["string", "null"] };

export const RECEIPT_TOOL = {
  name: "record_receipt",
  description: "Record the transcribed contents of one till receipt (1-3 photographed parts).",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "recognisable",
      "same_receipt",
      "store_name",
      "purchase_date",
      "currency",
      "total_printed",
      "total_printed_part",
      "lines",
    ],
    properties: {
      recognisable: {
        type: "boolean",
        description: "false if the images are not a till receipt, or too degraded to read at all.",
      },
      same_receipt: {
        type: "boolean",
        description: "false if the parts look like they come from different receipts.",
      },
      store_name: NULLABLE_STRING,
      purchase_date: { ...NULLABLE_STRING, description: "YYYY-MM-DD, or null if ambiguous or unread." },
      currency: { type: ["string", "null"], enum: ["GBP", "EUR", null] },
      total_printed: { ...NULLABLE_STRING, description: "As printed, e.g. \"41.03\"." },
      total_printed_part: { type: ["integer", "null"] },
      lines: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["part", "raw_text", "qty", "qty_unit", "unit_price", "line_total", "is_discount"],
          properties: {
            part: { type: "integer", description: "1-based photo this line was read from." },
            raw_text: { type: "string", description: "One printed line, as printed." },
            qty: NULLABLE_STRING,
            qty_unit: { type: ["string", "null"], enum: ["each", "kg", null] },
            unit_price: NULLABLE_STRING,
            line_total: { ...NULLABLE_STRING, description: "As printed, including a trailing \"-\"." },
            is_discount: { type: "boolean" },
          },
        },
      },
    },
  },
};

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolLine = {
  part: number | null;
  raw_text: string;
  qty: string | null;
  qty_unit: string | null;
  unit_price: string | null;
  line_total: string | null;
  is_discount: boolean;
};

export type ToolInput = {
  recognisable: boolean;
  same_receipt: boolean;
  store_name: string | null;
  purchase_date: string | null;
  currency: string | null;
  total_printed: string | null;
  total_printed_part: number | null;
  lines: ToolLine[];
};

export type ScanLine = {
  part: number | null;
  rawText: string;
  qty: number | null;
  qtyUnit: "each" | "kg" | null;
  unitPricePence: number | null;
  lineTotalPence: number | null;
  isDiscount: boolean;
  possibleSeamDuplicate: boolean;
};

/** The success body, mirrored by hand in src/lib/receiptScan.ts. */
export type Scan = {
  partCount: number;
  store: string | null;
  purchasedOn: string | null;
  currency: "GBP" | "EUR" | null;
  printedTotalPence: number | null;
  totalPrintedPart: number | null;
  lines: ScanLine[];
  notes: string[];
};

export type ScanFailure = { ok: false; error: string; status: number; message: string };

// ─── parsePence ──────────────────────────────────────────────────────────────

// An optional leading OR trailing minus (never both), an optional £/€, 1–5
// digits, ".", exactly two digits. A receipt always prints two decimals, so
// "12.3" is a misread; "1,234.56" is refused (findings decision 6), and so is
// a VAT letter left on the end.
const PRINTED_PENCE = /^(-)?[£€]?(\d{1,5})\.(\d{2})(-)?$/;

/** A printed amount → integer pence, or null. No float arithmetic. A
 *  discount is never positive, however it was printed. */
export function parsePence(s: string | null, isDiscount = false): number | null {
  if (s == null) return null;
  const m = PRINTED_PENCE.exec(s.trim());
  if (!m) return null;
  const [, leadingMinus, whole, decimals, trailingMinus] = m;
  if (leadingMinus && trailingMinus) return null;
  const pence = Number(whole) * 100 + Number(decimals);
  if (pence === 0) return 0; // never -0, however the sign was printed
  if (isDiscount) return -pence;
  return leadingMinus || trailingMinus ? -pence : pence;
}

// ─── Redaction (defence in depth behind prompt rule 4; findings §7) ─────────

// Whole words only: "AID" must not catch "BRAIDED", nor "CHANGE" "EXCHANGE".
const TENDER = /\b(VISA|MASTERCARD|AMEX|CONTACTLESS|CARD\s+NO|AID|AUTH|CHANGE|CASHBACK)\b/i;
const LOYALTY = /\b(CLUBCARD|NECTAR|POINTS)\b/i;
// A loyalty line is only dropped when it carries an identifier. "Nectar Price
// Saving -0.75" is a real discount; dropping it would break reconcile
// (MEASURED on real Sainsbury's receipts in the bake-off).
const LOYALTY_IDENTIFIER = /\d{4,}|\bCARD\s+NO\b|\bPOINTS\s+BALANCE\b/i;

const MASKED_DIGITS = /([*X#])\d{4,}/g;
const LONG_DIGITS = /\d(?:[ ]?\d){11,}/g;
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b/g;

/** A line's text with card-like digits and postcodes masked, or null when the
 *  line must be dropped (tender lines; loyalty lines with an identifier). */
export function redactLine(text: string): string | null {
  if (TENDER.test(text)) return null;
  if (LOYALTY.test(text) && LOYALTY_IDENTIFIER.test(text)) return null;
  return text
    .replace(MASKED_DIGITS, "$1****")
    .replace(LONG_DIGITS, "****")
    .replace(POSTCODE, "****");
}

/** Chain or brand only: postcode stripped, at most 60 characters. */
export function cleanStoreName(s: string | null): string | null {
  if (s == null) return null;
  const out = s.replace(POSTCODE, "").replace(/\s+/g, " ").trim().slice(0, MAX_STORE).trim();
  return out || null;
}

// ─── Dates ───────────────────────────────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** A real calendar date, at most a day after `today` (UTC) and not more than
 *  two years before it; else null. Round-trips through Date.UTC fields —
 *  never new Date("YYYY-MM-DD") — so 29 Feb on a non-leap year is refused. */
export function validatePurchaseDate(s: string | null, today: Date): string | null {
  if (!s) return null;
  const m = ISO_DATE.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const earliest = Date.UTC(today.getUTCFullYear() - 2, today.getUTCMonth(), today.getUTCDate());
  if (t > todayUtc + DAY_MS || t < earliest) return null;
  return s;
}

// ─── Parts ───────────────────────────────────────────────────────────────────

/** 0 parts is bad_request; more than 3 is too_long; 1–3 are fine. */
export function partCountError(n: number): { error: string; status: number } | null {
  if (n < 1) return { error: "bad_request", status: 400 };
  if (n > MAX_RECEIPT_PARTS) return { error: "too_long", status: 413 };
  return null;
}

// ─── Seam flag ───────────────────────────────────────────────────────────────

type SeamLine = { part: number | null; rawText: string; lineTotalPence: number | null };

/** Upper case, single spaces, a trailing VAT code letter dropped. */
function seamKey(l: SeamLine): string | null {
  if (l.lineTotalPence == null) return null;
  const text = l.rawText.toUpperCase().replace(/\s+/g, " ").trim().replace(/ [A-Z*]$/, "");
  return `${text}\u0000${l.lineTotalPence}`;
}

/**
 * FLAG, NEVER DELETE (findings §3). At each join between part p and p+1, if
 * the last 1–2 lines read from p equal the first 1–2 read from p+1 (same
 * normalised text AND the same non-null total), the p+1 copies are flagged.
 * Two identical lines are also a genuine repeat purchase, which only the
 * person holding the receipt can tell apart — so the line stays, flagged,
 * and the review screen offers one-tap Remove. Lines within one part are
 * never compared: the model can't read one printed line twice in one image.
 */
export function flagSeamDuplicates<T extends SeamLine>(
  lines: T[],
): (T & { possibleSeamDuplicate: boolean })[] {
  const flagged = new Set<number>();
  const parts = [...new Set(lines.map((l) => l.part).filter((p): p is number => p != null))].sort(
    (a, b) => a - b,
  );
  for (const p of parts) {
    const tail = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.part === p).slice(-2);
    const head = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.part === p + 1).slice(0, 2);
    for (let k = Math.min(2, tail.length, head.length); k >= 1; k--) {
      const suffix = tail.slice(-k);
      const prefix = head.slice(0, k);
      const match = suffix.every(({ l }, j) => {
        const a = seamKey(l);
        return a != null && a === seamKey(prefix[j].l);
      });
      if (match) {
        prefix.forEach(({ i }) => flagged.add(i));
        break;
      }
    }
  }
  return lines.map((l, i) => ({ ...l, possibleSeamDuplicate: flagged.has(i) }));
}

// ─── Normalise the tool output ───────────────────────────────────────────────

const POSITIVE_QTY = /^\d{1,6}(\.\d{1,3})?$/;

function parseQty(s: string | null): number | null {
  if (s == null || !POSITIVE_QTY.test(s.trim())) return null;
  const n = Number(s.trim());
  return n > 0 ? n : null;
}

const inParts = (v: unknown, n: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= n ? v : null;

export function normaliseScan(
  tool: ToolInput,
  ctx: { partCount: number; stopReason: string; today: Date },
): { ok: true; scan: Scan } | ScanFailure {
  // Never return a truncated line list (candidate D): a receipt cut off by
  // max_tokens would look complete and quietly under-count.
  if (ctx.stopReason === "max_tokens") {
    return {
      ok: false,
      error: "too_long",
      status: 422,
      message: "That receipt is too long to read in one go. Try it in up to 3 parts.",
    };
  }
  if (!tool.recognisable) {
    return {
      ok: false,
      error: "no_receipt",
      status: 422,
      message: "That doesn't look like a till receipt. Try again with the receipt filling the frame.",
    };
  }
  if (!tool.same_receipt) {
    return {
      ok: false,
      error: "no_receipt",
      status: 422,
      message: "These photos look like they're from different receipts.",
    };
  }
  const rawLines = Array.isArray(tool.lines) ? tool.lines : [];
  if (rawLines.length > MAX_LINES) {
    return {
      ok: false,
      error: "too_long",
      status: 422,
      message: "That receipt has more lines than can be read at once.",
    };
  }

  const n = ctx.partCount;
  const notes: string[] = [];

  const lines = rawLines.flatMap((l): Omit<ScanLine, "possibleSeamDuplicate">[] => {
    const redacted = redactLine(String(l.raw_text ?? ""));
    if (redacted == null) return [];
    const rawText = redacted.trim().slice(0, MAX_RAW_TEXT).trim();
    if (!rawText) return [];
    const isDiscount = l.is_discount === true;
    return [
      {
        part: inParts(l.part, n),
        rawText,
        qty: parseQty(l.qty),
        qtyUnit: l.qty_unit === "each" || l.qty_unit === "kg" ? l.qty_unit : null,
        unitPricePence: (() => {
          const p = parsePence(l.unit_price);
          return p != null && p >= 0 ? p : null;
        })(),
        lineTotalPence: parsePence(l.line_total, isDiscount),
        isDiscount,
      },
    ];
  });

  const known = lines.map((l) => l.part).filter((p): p is number => p != null);
  if (known.some((p, i) => i > 0 && p < known[i - 1])) {
    notes.push("Lines may be out of order at a join");
  }

  const totalPart = inParts(tool.total_printed_part, n);
  if (n > 1 && totalPart != null && totalPart < n) {
    notes.push(`Total read from part ${totalPart} of ${n} — check it's the final total`);
  }

  const total = parsePence(tool.total_printed);
  const redactedStore = tool.store_name == null ? null : redactLine(tool.store_name);

  return {
    ok: true,
    scan: {
      partCount: n,
      store: cleanStoreName(redactedStore),
      purchasedOn: validatePurchaseDate(tool.purchase_date, ctx.today),
      currency: tool.currency === "GBP" || tool.currency === "EUR" ? tool.currency : null,
      printedTotalPence: total != null && total >= 0 ? total : null,
      totalPrintedPart: totalPart,
      lines: flagSeamDuplicates(lines),
      notes,
    },
  };
}

// ─── The handler ─────────────────────────────────────────────────────────────

/** The bits of supabase-js the handler uses: a rate-limit count and an insert
 *  into ai_extractions. Typed loosely so a test fake and the real client fit. */
export type AdminLike = {
  // deno-lint-ignore no-explicit-any
  from: (table: string) => any;
};

export type ReceiptScanDeps = {
  getCallerId: (req: Request) => Promise<string | null>;
  admin: AdminLike;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: { apiKey: string | undefined; model?: string };
  now: () => Date;
};

// ai_extractions.outcome stays within the existing set, because the table's
// constraints can't be read from the repo (candidate F): no_receipt logs as
// no_label, a too_long from the model as model_error.
type Outcome = "success" | "no_label" | "model_error" | "rate_limited";

async function logExtraction(
  admin: AdminLike,
  row: {
    userId: string;
    outcome: Outcome;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
  },
) {
  // Explicit snake_case mapping — never spread a camelCase object into a
  // Supabase insert.
  const { error } = await admin.from("ai_extractions").insert({
    user_id: row.userId,
    outcome: row.outcome,
    model: row.model,
    input_tokens: row.inputTokens ?? null,
    output_tokens: row.outputTokens ?? null,
    duration_ms: row.durationMs ?? null,
  });
  if (error) console.error("logExtraction:", error.message);
}

type Part = { imageBase64: string; mediaType: string };

function readParts(body: unknown): Part[] | null {
  const parts = (body as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(parts)) return null;
  const out: Part[] = [];
  for (const p of parts) {
    const imageBase64 = (p as { imageBase64?: unknown })?.imageBase64;
    const mediaType = (p as { mediaType?: unknown })?.mediaType ?? "image/jpeg";
    if (typeof imageBase64 !== "string" || !imageBase64 || typeof mediaType !== "string") return null;
    out.push({ imageBase64, mediaType });
  }
  return out;
}

export async function handleReceiptScan(req: Request, deps: ReceiptScanDeps): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") return fail("bad_request", "Method not allowed.", 405);

  const userId = await deps.getCallerId(req);
  if (!userId) return fail("unauthorized", "Please sign in and try again.", 401);

  const apiKey = deps.env.apiKey;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    return fail("server_error", "Receipt scanning is unavailable.", 500);
  }
  const model = deps.env.model || DEFAULT_RECEIPT_MODEL;

  let parts: Part[] | null;
  try {
    parts = readParts(await req.json());
  } catch {
    return fail("bad_request", "Couldn't read that request.", 400);
  }
  if (!parts) return fail("bad_request", "Couldn't read that request.", 400);

  // Part count and size are refused BEFORE the rate-limit check, so a
  // malformed request never costs a scan.
  const countError = partCountError(parts.length);
  if (countError) {
    return fail(
      countError.error,
      countError.error === "too_long"
        ? "Photograph long receipts in up to 3 overlapping parts."
        : "No photo was sent.",
      countError.status,
    );
  }
  if (parts.some((p) => !MEDIA_TYPES.includes(p.mediaType))) {
    return fail("bad_request", "That image format isn't supported.", 400);
  }
  if (
    parts.some((p) => p.imageBase64.length > MAX_PART_BASE64_CHARS) ||
    parts.reduce((n, p) => n + p.imageBase64.length, 0) > MAX_TOTAL_BASE64_CHARS
  ) {
    return fail("too_long", "Those photos are too large. Try taking them again.", 413);
  }

  const admin = deps.admin;

  // The shared hourly budget. Fails OPEN on a count error, like the other
  // scanners: a telemetry hiccup shouldn't block a scan.
  const hourAgo = new Date(deps.now().getTime() - 60 * 60 * 1000).toISOString();
  const { count, error: countErr } = await admin
    .from("ai_extractions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .neq("outcome", "rate_limited")
    .gte("created_at", hourAgo);
  if (countErr) {
    console.error("rate limit check failed:", countErr.message);
  } else if ((count ?? 0) >= MAX_EXTRACTIONS_PER_HOUR) {
    await logExtraction(admin, { userId, outcome: "rate_limited", model });
    return fail(
      "rate_limited",
      "You've used a lot of AI scans in the last hour. Try again shortly.",
      429,
    );
  }

  // One image block per part, each labelled, then the instruction.
  const content: unknown[] = [];
  parts.forEach((p, i) => {
    if (parts!.length > 1) content.push({ type: "text", text: `Part ${i + 1} of ${parts!.length}:` });
    content.push({ type: "image", source: { type: "base64", media_type: p.mediaType, data: p.imageBase64 } });
  });
  content.push({ type: "text", text: "Transcribe this receipt." });

  const started = deps.now().getTime();
  let anthropicJson: {
    content?: Array<{ type: string; name?: string; input?: unknown }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);
    let res: Response;
    try {
      res = await deps.fetch(ANTHROPIC_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          // Explicit: on Sonnet 5, omitting `thinking` runs adaptive thinking,
          // which bought nothing measurable in the bake-off and would spend
          // the max_tokens budget. No `temperature`: forced tool use gives all
          // the determinism this needs.
          thinking: { type: "disabled" },
          system: SYSTEM_PROMPT,
          tools: [RECEIPT_TOOL],
          tool_choice: { type: "tool", name: RECEIPT_TOOL.name },
          messages: [{ role: "user", content }],
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // The error body describes the request fault, not its content.
      const detail = await res.text();
      console.error(`anthropic ${res.status}:`, detail.slice(0, 500));
      await logExtraction(admin, {
        userId,
        outcome: "model_error",
        model,
        durationMs: deps.now().getTime() - started,
      });
      return fail(
        "model_error",
        res.status === 429
          ? "The receipt scanner is busy. Try again in a moment."
          : "Couldn't read that receipt. Try again.",
        502,
      );
    }
    anthropicJson = await res.json();
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    console.error("anthropic call failed:", aborted ? "timeout" : "network");
    await logExtraction(admin, {
      userId,
      outcome: "model_error",
      model,
      durationMs: deps.now().getTime() - started,
    });
    return fail(
      "model_error",
      aborted ? "That took too long. Try again." : "Couldn't read that receipt. Try again.",
      502,
    );
  }

  const durationMs = deps.now().getTime() - started;
  const inputTokens = anthropicJson.usage?.input_tokens;
  const outputTokens = anthropicJson.usage?.output_tokens;
  const stopReason = anthropicJson.stop_reason ?? "";

  const toolUse = anthropicJson.content?.find(
    (b) => b.type === "tool_use" && b.name === RECEIPT_TOOL.name,
  );
  if (!toolUse?.input) {
    console.error("no tool_use block in response");
    await logExtraction(admin, { userId, outcome: "model_error", model, inputTokens, outputTokens, durationMs });
    return fail("model_error", "Couldn't read that receipt. Try again.", 502);
  }

  const result = normaliseScan(toolUse.input as ToolInput, {
    partCount: parts.length,
    stopReason,
    today: deps.now(),
  });

  if (!result.ok) {
    await logExtraction(admin, {
      userId,
      outcome: result.error === "no_receipt" ? "no_label" : "model_error",
      model,
      inputTokens,
      outputTokens,
      durationMs,
    });
    return fail(result.error, result.message, result.status);
  }

  await logExtraction(admin, { userId, outcome: "success", model, inputTokens, outputTokens, durationMs });
  return json({ ok: true, ...result.scan }, 200);
}
