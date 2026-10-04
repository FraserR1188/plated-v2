// ============================================================
// Receipt scanner: written red in commit 2 (findings, Commit 2 as revised
// 2026-09-27), green from commit 3 — supabase/functions/_shared/receipt.ts.
//
// The house rule: the model TRANSCRIBES, the server CALCULATES. The model
// returns every amount as the string printed; this module parses, redacts,
// validates and flags, deterministically, and the handler wraps it.
//
// The contract these tests pin (commit 3 implements it):
//   parsePence(s, isDiscount?)            printed string → integer pence | null
//   redactLine(text)                      masked text, or null = drop the line
//   cleanStoreName(s)                     chain/brand only, postcode gone, ≤ 60
//   validatePurchaseDate(s, today)        YYYY-MM-DD | null
//   partCountError(n)                     { error, status } | null
//   normaliseScan(tool, ctx)              { ok: true, scan } | { ok: false, error, status }
//   flagSeamDuplicates(lines)             lines + possibleSeamDuplicate
//   handleReceiptScan(req, deps)          the Edge Function, deps injected
//
// receipt.ts is Deno code, but unlike whoop.ts it reads no Deno globals at
// load (index.ts passes everything in through `deps`), so it imports
// statically here with no Deno stub.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import {
  parsePence,
  redactLine,
  cleanStoreName,
  validatePurchaseDate,
  partCountError,
  normaliseScan,
  flagSeamDuplicates,
  handleReceiptScan,
} from "../receipt.ts";

// ─── The contract ───────────────────────────────────────────────────────────

type ToolLine = {
  part: number | null;
  raw_text: string;
  qty: string | null;
  qty_unit: "each" | "kg" | null;
  unit_price: string | null;
  line_total: string | null;
  is_discount: boolean;
};
type ToolInput = {
  recognisable: boolean;
  same_receipt: boolean;
  store_name: string | null;
  purchase_date: string | null;
  currency: "GBP" | "EUR" | null;
  total_printed: string | null;
  total_printed_part: number | null;
  lines: ToolLine[];
};
type ScanLine = {
  part: number | null;
  rawText: string;
  qty: number | null;
  qtyUnit: "each" | "kg" | null;
  unitPricePence: number | null;
  lineTotalPence: number | null;
  isDiscount: boolean;
  possibleSeamDuplicate: boolean;
};
type Scan = {
  partCount: number;
  store: string | null;
  purchasedOn: string | null;
  currency: "GBP" | "EUR" | null;
  printedTotalPence: number | null;
  totalPrintedPart: number | null;
  lines: ScanLine[];
  notes: string[];
};
type Failure = { ok: false; error: string; status: number };
type SeamLine = { part: number | null; rawText: string; lineTotalPence: number | null };
type FakeAdmin = {
  inserts: { table: string; row: Record<string, unknown> }[];
  from: (table: string) => unknown;
};
type Deps = {
  getCallerId: (req: Request) => Promise<string | null>;
  admin: FakeAdmin;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  env: { apiKey: string | undefined; model?: string };
  now: () => Date;
};

const TODAY = new Date("2026-10-04T12:00:00Z");

function line(over: Partial<ToolLine> = {}): ToolLine {
  return {
    part: 1,
    raw_text: "JS CHICKPEAS",
    qty: null,
    qty_unit: null,
    unit_price: null,
    line_total: "0.41",
    is_discount: false,
    ...over,
  };
}
function tool(over: Partial<ToolInput> = {}): ToolInput {
  return {
    recognisable: true,
    same_receipt: true,
    store_name: "Sainsbury's",
    purchase_date: "2026-09-20",
    currency: "GBP",
    total_printed: "0.41",
    total_printed_part: 1,
    lines: [line()],
    ...over,
  };
}
const ctx = (partCount = 1, stopReason = "tool_use") => ({ partCount, stopReason, today: TODAY });

// ─── parsePence ─────────────────────────────────────────────────────────────

describe("parsePence — strict, from the printed string", () => {
  // The same table as the client's parsePenceInput, except that a printed
  // receipt always has exactly two decimals, so "12.3" is a misread here.
  it.each([
    ["12.30", 1230],
    ["£12.30", 1230],
    ["€3.00", 300],
    ["0.50-", -50],
    ["-0.50", -50],
    ["0.29", 29], // no float arithmetic
    ["99999.99", 9999999], // five integer digits is the cap
  ])("%j → %d", async (s, pence) => {
    expect(parsePence(s)).toBe(pence);
  });

  // Decided cases (findings decision 6): "-0.50-" and "1,234.56" are null.
  it.each(["12.3", "12.305", "", "abc", "-0.50-", "1,234.56", "123456.00", "12.30 A"])(
    "%j → null",
    async (s) => {
      expect(parsePence(s)).toBeNull();
    },
  );

  it("null in, null out", async () => {
    expect(parsePence(null)).toBeNull();
  });

  it("is_discount forces the sign to ≤ 0, whichever way it was printed", async () => {
    expect(parsePence("0.75", true)).toBe(-75);
    expect(parsePence("0.75-", true)).toBe(-75);
    expect(parsePence("-0.75", true)).toBe(-75);
    expect(parsePence("0.00", true)).toBe(0);
  });
});

// ─── Redaction ──────────────────────────────────────────────────────────────

describe("redactLine — defence in depth behind the prompt (findings §3, §7)", () => {
  it.each([
    "VISA ************1234",
    "MASTERCARD CONTACTLESS",
    "CARD NO **** **** **** 4821",
    "AID A0000000031010",
    "AUTH CODE 123456",
    "CHANGE 0.00",
    "CASHBACK 20.00",
    // Loyalty keyword WITH an identifier → dropped.
    "CLUBCARD NO 634004123456789",
    "NECTAR CARD 98261234",
    "NECTAR POINTS BALANCE 1234",
  ])("drops %j", async (text) => {
    expect(redactLine(text)).toBeNull();
  });

  // Revised 2026-09-27: a price saving named after a loyalty scheme is a
  // real discount. Dropping it would break reconcile (MEASURED on real
  // Sainsbury's receipts in the bake-off).
  it.each(["Nectar Price Saving", "Nectar Price Saving -0.75", "Clubcard Price", "Clubcard Price -0.50"])(
    "keeps %j unchanged",
    async (text) => {
      expect(redactLine(text)).toBe(text);
    },
  );

  it.each(["JS CHICKPEAS", "BRAIDED LOAF", "EXCHANGE RATE CARD", "POINTED CABBAGE"])(
    "keeps %j: keywords match whole words only (AID ⊄ BRAIDED)",
    async (text) => {
      expect(redactLine(text)).toBe(text);
    },
  );

  it.each([
    ["REF *48213377", "48213377"], // 4+ digits after *
    ["XXXXXXXXXXXX4821", "4821"], // after X
    ["MEMBER #55512345", "55512345"], // after #
    ["1234 5678 9012 3456", "1234 5678 9012 3456"], // 12+ digits with spaces
    ["RETURNS TO SW1A 1AA", "SW1A 1AA"], // postcode
  ])("masks the digits in %j", async (text, secret) => {
    const out = redactLine(text);
    expect(out).not.toBeNull();
    expect(out).not.toContain(secret);
  });
});

describe("cleanStoreName", () => {
  it("strips a postcode", async () => {
    expect(cleanStoreName("Sainsbury's SW1A 1AA")).toBe("Sainsbury's");
  });

  it("is at most 60 characters", async () => {
    const out = cleanStoreName("A".repeat(80));
    expect(out === null || out.length <= 60).toBe(true);
  });

  it("null and blank are null", async () => {
    expect(cleanStoreName(null)).toBeNull();
    expect(cleanStoreName("   ")).toBeNull();
  });
});

// ─── Dates ──────────────────────────────────────────────────────────────────

describe("validatePurchaseDate — today is 2026-10-04 (server UTC)", () => {
  it.each([
    ["2026-09-20", "2026-09-20"],
    ["2026-10-05", "2026-10-05"], // one day ahead is allowed (time zones)
    ["2024-10-04", "2024-10-04"], // exactly two years ago is allowed
    ["2026-02-28", "2026-02-28"],
  ])("%j → %j", async (s, out) => {
    expect(validatePurchaseDate(s, TODAY)).toBe(out);
  });

  it.each([
    "2026-02-29", // not a leap year: round-trips through Date.UTC fields, not new Date(s)
    "2026-13-01",
    "2026-04-31",
    "2026-10-06", // two days ahead
    "2024-10-03", // more than two years ago
    "25/09/26", // the model must return ISO; anything else is unread
    "",
  ])("%j → null", async (s) => {
    expect(validatePurchaseDate(s, TODAY)).toBeNull();
  });

  it("accepts a real leap day", async () => {
    expect(validatePurchaseDate("2024-02-29", new Date("2025-01-10T12:00:00Z"))).toBe(
      "2024-02-29",
    );
  });
});

// ─── Parts ──────────────────────────────────────────────────────────────────

describe("parts", () => {
  it("0 parts is bad_request (400); 4 is too_long (413); 1–3 are fine", async () => {
    expect(partCountError(0)).toEqual({ error: "bad_request", status: 400 });
    expect(partCountError(4)).toEqual({ error: "too_long", status: 413 });
    expect(partCountError(1)).toBeNull();
    expect(partCountError(3)).toBeNull();
  });

  it("a line's part outside 1..n becomes null", async () => {
    const r = normaliseScan(
      tool({ total_printed_part: 3, lines: [line({ part: 0 }), line({ part: 4 }), line({ part: 2 })] }),
      ctx(3),
    );
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
    expect(r.scan.lines.map((l) => l.part)).toEqual([null, null, 2]);
  });

  it("parts going backwards down the list add a note", async () => {
    const r = normaliseScan(
      tool({ total_printed_part: 2, lines: [line({ part: 2 }), line({ part: 1 })] }),
      ctx(2),
    );
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
    expect(r.scan.notes).toContain("Lines may be out of order at a join");
  });

  it("a total read from before the last part adds a note", async () => {
    const r = normaliseScan(
      tool({ total_printed_part: 1, lines: [line({ part: 1 }), line({ part: 3 })] }),
      ctx(3),
    );
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
    expect(r.scan.notes).toContain("Total read from part 1 of 3 — check it's the final total");
  });

  it("same_receipt: false is no_receipt (422)", async () => {
    expect(normaliseScan(tool({ same_receipt: false }), ctx(2))).toMatchObject({
      ok: false,
      error: "no_receipt",
      status: 422,
    });
  });

  it("recognisable: false is no_receipt (422)", async () => {
    expect(normaliseScan(tool({ recognisable: false }), ctx(1))).toMatchObject({
      ok: false,
      error: "no_receipt",
      status: 422,
    });
  });

  it("more than 150 lines is too_long", async () => {
    const lines = Array.from({ length: 151 }, (_, i) => line({ raw_text: `ITEM ${i}` }));
    expect(normaliseScan(tool({ lines }), ctx(1))).toMatchObject({ ok: false, error: "too_long" });
  });
});

// ─── stop_reason ────────────────────────────────────────────────────────────

describe("stop_reason: max_tokens (candidate D)", () => {
  it("is a failure, never a truncated line list", async () => {
    const r = normaliseScan(tool(), ctx(1, "max_tokens"));
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: "too_long" });
    expect("scan" in r).toBe(false);
  });
});

// ─── Lines: amounts, voids, redaction in place ──────────────────────────────

describe("normaliseScan — lines", () => {
  it("parses amounts, and a discount is never positive", async () => {
    const r = normaliseScan(
      tool({
        total_printed: "1.00",
        lines: [
          line({ raw_text: "MILK", line_total: "1.50" }),
          line({ raw_text: "Nectar Price Saving", line_total: "0.50", is_discount: true }),
        ],
      }),
      ctx(1),
    );
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
    expect(r.scan.printedTotalPence).toBe(100);
    expect(r.scan.lines.map((l) => [l.rawText, l.lineTotalPence, l.isDiscount])).toEqual([
      ["MILK", 150, false],
      ["Nectar Price Saving", -50, true],
    ]);
  });

  it("a void stays as two lines — the item and its negative cancel line — and still reconciles", async () => {
    const r = normaliseScan(
      tool({
        total_printed: "0.41",
        lines: [
          line({ raw_text: "JS CHICKPEAS", line_total: "0.41" }),
          line({ raw_text: "*MOMENT HANDWASH DUO", line_total: "8.50" }),
          line({ raw_text: "ITEM CANCELLED *MOMENT HANDWASH DUO", line_total: "-8.50", is_discount: true }),
        ],
      }),
      ctx(1),
    );
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
    expect(r.scan.lines).toHaveLength(3);
    expect(r.scan.lines[2]).toMatchObject({ lineTotalPence: -850, isDiscount: true });
    const sum = r.scan.lines.reduce((s, l) => s + (l.lineTotalPence ?? 0), 0);
    expect(sum).toBe(r.scan.printedTotalPence);
  });

  it("drops tender lines and blank lines, keeps loyalty price savings", async () => {
    const r = normaliseScan(
      tool({
        lines: [
          line({ raw_text: "MILK", line_total: "1.50" }),
          line({ raw_text: "Nectar Price Saving", line_total: "0.50-", is_discount: true }),
          line({ raw_text: "VISA ************1234", line_total: "1.00" }),
          line({ raw_text: "   ", line_total: "0.10" }),
        ],
      }),
      ctx(1),
    );
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
    expect(r.scan.lines.map((l) => l.rawText)).toEqual(["MILK", "Nectar Price Saving"]);
  });

  it("an unreadable total or line total stays null, never 0", async () => {
    const r = normaliseScan(
      tool({ total_printed: null, lines: [line({ line_total: null }), line({ line_total: "1,234.56" })] }),
      ctx(1),
    );
    if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
    expect(r.scan.printedTotalPence).toBeNull();
    expect(r.scan.lines.map((l) => l.lineTotalPence)).toEqual([null, null]);
  });
});

// ─── Seam flag ──────────────────────────────────────────────────────────────

describe("flagSeamDuplicates — flag, never delete", () => {
  const s = (part: number | null, rawText: string, lineTotalPence: number | null): SeamLine => ({
    part,
    rawText,
    lineTotalPence,
  });
  const flags = (out: { possibleSeamDuplicate: boolean }[]) => out.map((l) => l.possibleSeamDuplicate);

  it("a one-line echo across a join flags the part k+1 copy only", async () => {
    const out = flagSeamDuplicates([
      s(1, "MILK", 150),
      s(1, "GREEN LENTILS", 50),
      s(2, "GREEN LENTILS", 50),
      s(2, "BREAD", 95),
    ]);
    expect(out).toHaveLength(4); // nothing deleted
    expect(flags(out)).toEqual([false, false, true, false]);
  });

  it("a two-line echo flags both part k+1 copies", async () => {
    const out = flagSeamDuplicates([
      s(1, "MILK", 150),
      s(1, "EGGS", 200),
      s(1, "BREAD", 95),
      s(2, "EGGS", 200),
      s(2, "BREAD", 95),
      s(2, "BUTTER", 210),
    ]);
    expect(flags(out)).toEqual([false, false, false, true, true, false]);
  });

  it("identical adjacent lines within one part are a real repeat, never flagged", async () => {
    const out = flagSeamDuplicates([s(1, "BANANAS", 85), s(1, "BANANAS", 85), s(1, "MILK", 150)]);
    expect(flags(out)).toEqual([false, false, false]);
  });

  it("same text with a different total is not flagged", async () => {
    const out = flagSeamDuplicates([s(1, "CANINI BEANS", 50), s(2, "CANINI BEANS", 45)]);
    expect(flags(out)).toEqual([false, false]);
  });

  it("a null total is not flagged", async () => {
    const out = flagSeamDuplicates([s(1, "CHICKPEAS", null), s(2, "CHICKPEAS", null)]);
    expect(flags(out)).toEqual([false, false]);
  });

  it("matching ignores case, spacing and trailing VAT letters", async () => {
    const out = flagSeamDuplicates([s(1, "Green  Lentils A", 50), s(2, "GREEN LENTILS", 50)]);
    expect(flags(out)).toEqual([false, true]);
  });
});

// ─── The handler, through injected deps ─────────────────────────────────────

function fakeAdmin(): FakeAdmin {
  const inserts: FakeAdmin["inserts"] = [];
  return {
    inserts,
    from(table: string) {
      // The rate-limit count: select(...).eq().neq().gte() → { count, error }
      const countChain = {
        eq: () => countChain,
        neq: () => countChain,
        gte: () => countChain,
        then: (resolve: (v: { count: number; error: null }) => unknown) =>
          resolve({ count: 0, error: null }),
      };
      return {
        select: () => countChain,
        insert: async (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return { error: null };
        },
      };
    },
  };
}

function modelResponse(input: ToolInput, stopReason = "tool_use"): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "tool_use", id: "toolu_1", name: "record_receipt", input }],
      stop_reason: stopReason,
      usage: { input_tokens: 15918, output_tokens: 5693 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function scanRequest(parts: number): Request {
  return new Request("http://localhost/functions/v1/scan-receipt", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: JSON.stringify({
      parts: Array.from({ length: parts }, () => ({ imageBase64: "AAAA", mediaType: "image/jpeg" })),
    }),
  });
}

function deps(admin: FakeAdmin, fetchImpl: Deps["fetch"]): Deps {
  return {
    getCallerId: async () => "a8435663-72e9-4d33-9c3f-803c4cbda393",
    admin,
    fetch: fetchImpl,
    env: { apiKey: "test-key", model: "claude-sonnet-5" },
    now: () => TODAY,
  };
}

describe("handleReceiptScan — one ai_extractions row per request", () => {
  it("a 3-part scan makes one model call and inserts exactly one row", async () => {
    const admin = fakeAdmin();
    const fetchMock = vi.fn(async () =>
      modelResponse(
        tool({
          total_printed: "1.00",
          total_printed_part: 3,
          lines: [
            line({ part: 1, raw_text: "MILK", line_total: "1.50" }),
            line({ part: 3, raw_text: "Nectar Price Saving", line_total: "0.50-", is_discount: true }),
          ],
        }),
      ),
    );
    const res = await handleReceiptScan(scanRequest(3), deps(admin, fetchMock));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, partCount: 3, printedTotalPence: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // All three parts went in the one call, in order.
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const images = sent.messages[0].content.filter((b: { type: string }) => b.type === "image");
    expect(images).toHaveLength(3);

    const rows = admin.inserts.filter((i) => i.table === "ai_extractions");
    expect(rows).toHaveLength(1);
    expect(rows[0].row).toMatchObject({ outcome: "success" });
  });

  it("a 4-part request is too_long (413): no model call, no row", async () => {
    const admin = fakeAdmin();
    const fetchMock = vi.fn(async () => modelResponse(tool()));
    const res = await handleReceiptScan(scanRequest(4), deps(admin, fetchMock));

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false, error: "too_long" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(admin.inserts.filter((i) => i.table === "ai_extractions")).toHaveLength(0);
  });

  it("a max_tokens stop is a failure with no lines, logged once as model_error", async () => {
    const admin = fakeAdmin();
    const fetchMock = vi.fn(async () => modelResponse(tool(), "max_tokens"));
    const res = await handleReceiptScan(scanRequest(2), deps(admin, fetchMock));

    expect(res.ok).toBe(false);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "too_long" });
    expect(body.lines).toBeUndefined();
    const rows = admin.inserts.filter((i) => i.table === "ai_extractions");
    expect(rows).toHaveLength(1);
    expect(rows[0].row).toMatchObject({ outcome: "model_error" });
  });
});
