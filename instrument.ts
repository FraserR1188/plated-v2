import "react-native-url-polyfill/auto";
import * as Sentry from "@sentry/react-native";

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function scrubUrl(url?: string): string | undefined {
  if (!url) return url;
  const [base] = url.split("?"); // drop query string: kills ?user_id=eq.<uuid> and date filters
  return base.replace(UUID_RE, "<redacted>"); // belt-and-braces: redact any UUID left in the path
}

Sentry.init({
  dsn: "https://441e0d1e915c9771b761bc121565ab7f@o4511887474294784.ingest.de.sentry.io/4511887483404368",
  environment: process.env.EXPO_PUBLIC_SENTRY_ENV ?? "development",
  enabled: !__DEV__, // no dev noise on the free quota; preview/prod builds are !__DEV__
  sendDefaultPii: false, // explicit — Sentry's template defaults this to true
  tracesSampleRate: 0, // error-only for now; also removes transaction/route PII surface
  // no session replay integration — never on a health app

  beforeBreadcrumb(breadcrumb) {
    // Drop console breadcrumbs wholesale: the "unexpected payload" sites can serialise
    // nutrition/WHOOP data into the console message. Phase 3 fixes those at source.
    if (breadcrumb.category === "console") return null;

    // Strip query strings (and stray UUIDs) from HTTP breadcrumb URLs.
    if (
      breadcrumb.category === "xhr" ||
      breadcrumb.category === "fetch" ||
      breadcrumb.category === "http"
    ) {
      const data = breadcrumb.data;
      if (data && typeof data.url === "string") {
        data.url = scrubUrl(data.url);
      }
    }
    return breadcrumb;
  },

  beforeSend(event) {
    event.user = undefined; // we never attach a user; hard-clear in case anything populates it
    if (event.request) {
      event.request.url = scrubUrl(event.request.url);
      delete event.request.data; // drop any captured request body
      delete (event.request as any).query_string;
    }
    if (event.breadcrumbs) {
      for (const b of event.breadcrumbs) {
        if (b.data && typeof (b.data as any).url === "string") {
          (b.data as any).url = scrubUrl((b.data as any).url);
        }
      }
    }
    return event;
  },
});
