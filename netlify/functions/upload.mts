import type { Config } from "@netlify/functions";
import { deleteJob, jobsStore, json } from "../lib/common.mts";

// Netlify buffers request bodies up to 6 MB, and binary data grows by about a
// third in transit, so stay well below that.
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Browser -> this function -> n8n.
 * Checks the PDF, creates a job, and hands the file to n8n's webhook with a
 * shared secret. n8n answers right away ("Respond: Immediately") and does the
 * real work later, then posts its results to /api/save-results.
 */
export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  const webhookUrl = Netlify.env.get("N8N_WEBHOOK_URL");
  const secret = Netlify.env.get("N8N_SECRET");
  if (!webhookUrl || !secret) {
    console.error("upload: N8N_WEBHOOK_URL or N8N_SECRET is not set");
    return json({ error: "The server is not configured yet." }, 500);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Send the PDF as a multipart form upload." }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return json({ error: "Choose a PDF file." }, 400);
  }
  if (file.size > MAX_BYTES) {
    return json({ error: "That PDF is over 4 MB. Export fewer slides or a smaller file." }, 413);
  }

  // A file name is user-controlled, so check the first bytes instead: every PDF starts with "%PDF-".
  const head = new TextDecoder().decode(await file.slice(0, 5).arrayBuffer());
  if (head !== "%PDF-") return json({ error: "That file does not look like a PDF." }, 400);

  const jobId = crypto.randomUUID();
  const fileName = (file.name || "lecture.pdf").replace(/[^\w.\- ()]/g, "_").slice(0, 100);

  // Create the job first so n8n's callback can never arrive before it exists.
  await jobsStore().setJSON(`${jobId}/meta`, { createdAt: Date.now(), fileName });

  const outbound = new FormData();
  outbound.append("jobId", jobId);
  outbound.append("file", file, "lecture.pdf"); // n8n reads this as binary field "file"

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "x-secret": secret },
      body: outbound,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`n8n answered with status ${res.status}`);
  } catch (err) {
    console.error("upload: could not hand the file to n8n:", err instanceof Error ? err.message : err);
    await deleteJob(jobId);
    return json({ error: "The processing service is not reachable right now. Try again in a minute." }, 502);
  }

  return json({ jobId }, 202);
};

export const config: Config = {
  path: "/api/upload",
  // Every upload spends free-tier AI and search quota, so cap how fast one visitor can trigger runs.
  rateLimit: { action: "rate_limit", windowLimit: 5, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
