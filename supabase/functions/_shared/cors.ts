// ============================================================
// supabase/functions/_shared/cors.ts
//
// Every Edge Function this project will ever have needs these three
// things. The WHOOP token-exchange function will import this file
// unchanged.
// ============================================================

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * Browsers preflight any request carrying an Authorization header.
 * React Native doesn't, but `supabase functions serve` and the Supabase
 * dashboard's test panel do — so without this, local testing fails in a
 * way that looks like an auth bug and isn't.
 */
export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  return null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/**
 * Uniform failure envelope. `error` is a stable machine-readable code the
 * client switches on; `message` is safe to show a user.
 *
 * Never put the upstream error text in `message` — an Anthropic 401 would
 * leak the shape of your key setup to anyone who can call the function.
 */
export function fail(error: string, message: string, status = 400): Response {
  return json({ ok: false, error, message }, status);
}
