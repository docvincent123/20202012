import type { Config, Handler } from "@netlify/functions";
import { handler as apiHandler } from "./api";

/** Canonical API entrypoint for Windows desktop and mobile. */
export const config: Config = {
  path: ["/api/baas", "/api/baas/*"],
};

export const handler: Handler = async (event, context) => {
  const rawPath = event.path || "";
  const normalizedPath = rawPath
    .replace(/^\/.netlify\/functions\/baas/, "")
    .replace(/^\/api\/baas/, "") || "/";

  const forwardedEvent = {
    ...event,
    path: normalizedPath,
    rawUrl: event.rawUrl
      ? event.rawUrl.replace(/\/api\/baas(?=\/|$)/, "")
      : event.rawUrl,
  };

  return apiHandler(forwardedEvent, context);
};
