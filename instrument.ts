import "react-native-url-polyfill/auto";
import * as Sentry from "@sentry/react-native";
import { scrubUrl, scrubString } from "./src/lib/scrub";

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
    // Defense-in-depth for the non-reportError paths (uncaught exceptions,
    // ErrorBoundary catches) — those still carry their real, unscrubbed
    // message. reportError() itself already scrubs before this ever runs.
    if (event.exception?.values) {
      for (const v of event.exception.values) {
        if (typeof v.value === "string") v.value = scrubString(v.value);
      }
    }
    return event;
  },
});
