import type { Config } from "@netlify/functions";
import { JOB_TTL_MS, deleteJob, isJobId, jobsStore, json } from "../lib/common.mts";

type Meta = { createdAt: number; fileName: string };
type Saved = { receivedAt: number; topic: string | null; data: unknown };

/**
 * Browser -> this function, polled every few seconds.
 * Puts together what n8n has saved so far for one job. The job id is a random
 * UUID, so it works as the access key for that job's notes.
 */
export default async (req: Request) => {
  if (req.method !== "GET") return json({ error: "Use GET." }, 405);

  const id = new URL(req.url).searchParams.get("id");
  if (!isJobId(id)) return json({ error: "Invalid job id." }, 400);

  const store = jobsStore();
  const meta = (await store.get(`${id}/meta`, { type: "json" })) as Meta | null;
  if (!meta) return json({ error: "Job not found." }, 404);

  // Lecture notes should not live forever, so expire them lazily the next time they are requested.
  if (Date.now() - meta.createdAt > JOB_TTL_MS) {
    await deleteJob(id);
    return json({ error: "This job has expired. Upload the slides again." }, 410);
  }

  const [notes, context, error] = (await Promise.all(
    ["notes", "context", "error"].map((stage) => store.get(`${id}/${stage}`, { type: "json" })),
  )) as (Saved | null)[];

  // The page shows notes whenever they exist, even if a later stage failed.
  const status = context ? "complete" : error ? "error" : notes ? "notes_ready" : "processing";

  const errorMessage = error
    ? typeof error.data === "string"
      ? error.data
      : ((error.data as { message?: string } | null)?.message ?? "Something went wrong.")
    : null;

  return json({
    id,
    status,
    fileName: meta.fileName,
    createdAt: meta.createdAt,
    topic: (context ?? notes)?.topic ?? null,
    notes: notes?.data ?? null,
    context: context?.data ?? null,
    error: errorMessage,
  });
};

export const config: Config = { path: "/api/status" };
