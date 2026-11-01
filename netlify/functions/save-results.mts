import type { Config } from "@netlify/functions";
import { STAGES, isJobId, jobsStore, json, parseMaybeJson, safeEqual } from "../lib/common.mts";

const MAX_BODY_CHARS = 200_000;

/**
 * n8n -> this function. Only n8n may call it: the request must carry the
 * shared secret in the x-results-secret header.
 *
 * Body (JSON):
 *   jobId  the id n8n received from the upload
 *   stage  "notes" | "context" | "error"
 *   topic  optional short text
 *   data   the payload, as an object or as a JSON string
 */
export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const expected = Netlify.env.get("RESULTS_SECRET");
  if (!expected) {
    console.error("save-results: RESULTS_SECRET is not set");
    return json({ error: "The server is not configured yet." }, 500);
  }
  if (!safeEqual(req.headers.get("x-results-secret") ?? "", expected)) {
    return json({ error: "Unauthorized." }, 401);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return json({ error: "Body is too large." }, 413);

  let body: { jobId?: unknown; stage?: unknown; topic?: unknown; data?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const { jobId, stage, topic } = body ?? {};
  if (!isJobId(jobId)) return json({ error: "Invalid jobId." }, 400);
  if (typeof stage !== "string" || !(STAGES as readonly string[]).includes(stage)) {
    return json({ error: `stage must be one of: ${STAGES.join(", ")}.` }, 400);
  }

  const data = parseMaybeJson(body.data);
  if (data === undefined || data === null || data === "") {
    return json({ error: "data is required." }, 400);
  }

  const store = jobsStore();
  // Refuse results for jobs this site never created, so the store cannot be filled with junk.
  if (!(await store.get(`${jobId}/meta`, { type: "json" }))) {
    return json({ error: "Unknown job." }, 404);
  }

  await store.setJSON(`${jobId}/${stage}`, {
    receivedAt: Date.now(),
    topic: typeof topic === "string" ? topic.slice(0, 500) : null,
    data,
  });
  return json({ ok: true });
};

export const config: Config = { path: "/api/save-results" };
