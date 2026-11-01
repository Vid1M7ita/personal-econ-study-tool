import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

// Everything about one upload ("job") is kept under its own keys:
//   <jobId>/meta     created by upload.mts
//   <jobId>/notes    written by n8n when the notes are ready
//   <jobId>/context  written by n8n when the checked context is ready
//   <jobId>/error    written by n8n if something fails
// Each key has exactly one writer, so no key is ever read, changed and
// written back. Blobs has no locking, so that pattern could lose updates.
export const STAGES = ["notes", "context", "error"] as const;
export type Stage = (typeof STAGES)[number];

export const JOB_TTL_MS = 24 * 60 * 60 * 1000; // delete a job's data after 24 hours

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True only for a UUID like the ones crypto.randomUUID() makes. Keeps odd strings out of store keys. */
export const isJobId = (value: unknown): value is string =>
  typeof value === "string" && JOB_ID.test(value);

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** Strong consistency so a status poll right after a write sees it (the default can lag up to 60 s). */
export const jobsStore = () => getStore({ name: "jobs", consistency: "strong" });

/** Compare two secrets without leaking, through timing, how many leading characters matched. */
export function safeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export async function deleteJob(jobId: string): Promise<void> {
  const store = jobsStore();
  await Promise.all(["meta", ...STAGES].map((key) => store.delete(`${jobId}/${key}`)));
}

/**
 * n8n often sends nested JSON as a string, and models sometimes wrap JSON in
 * a ```json fence. Turn either into a real value; anything else stays text.
 */
export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const unfenced = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    return value;
  }
}
