// ============================================================
// supabase/functions/scan-receipt/index.ts
//
// 1–3 photos of one supermarket till receipt in → store, date, printed
// total and lines out, for Grocery spending (receipt-scanner findings §3).
// A sibling of scan-meal-photo, not a mode of it: a receipt shares nothing
// with the meal contract.
//
// This file only wires the outside world. The logic — prompt, tool schema,
// parsing, redaction, the seam flag, the rate limit and the handler — is in
// ../_shared/receipt.ts, where vitest can reach it.
//
// Secrets: ANTHROPIC_API_KEY (shared), and optionally RECEIPT_MODEL. Never
// the shared MODEL secret the other scanners read: changing that must not
// change this function, and its forced tool_choice is a 400 on Claude
// Opus 5.5 and Claude Fable 5.1. See DEFAULT_RECEIPT_MODEL.
//
// Writes exactly one ai_extractions row per request, whatever the part
// count; nothing about the receipt itself is stored or logged.
// ============================================================

import { getCallerId, adminClient } from "../_shared/auth.ts";
import { handleReceiptScan } from "../_shared/receipt.ts";

Deno.serve((req: Request) =>
  handleReceiptScan(req, {
    getCallerId,
    admin: adminClient(),
    fetch: (url, init) => fetch(url, init),
    env: {
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
      model: Deno.env.get("RECEIPT_MODEL"),
    },
    now: () => new Date(),
  })
);
