// Run with:  npm test
// Starts a local Blobs server and a fake n8n webhook, then calls the real
// function handlers the same way Netlify would.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { BlobsServer } from "@netlify/blobs/server";

import upload from "../netlify/functions/upload.mts";
import saveResults from "../netlify/functions/save-results.mts";
import status from "../netlify/functions/status.mts";
import { JOB_TTL_MS, jobsStore } from "../netlify/lib/common.mts";

const N8N_SECRET = "test-n8n-in-secret";
const RESULTS_SECRET = "test-results-in-secret";

let blobs: BlobsServer;
let blobsDir: string;
let fakeN8n: http.Server;
let n8nMode: "ok" | "down" = "ok";
let lastN8nRequest: { headers: http.IncomingHttpHeaders; body: string } | null = null;

const env: Record<string, string | undefined> = {};
(globalThis as any).Netlify = { env: { get: (key: string) => env[key] } };

const pdfFile = (size = 2000, name = "L6 - Unemployment.pdf") =>
  new File([new TextEncoder().encode("%PDF-1.7\n"), new Uint8Array(size)], name, { type: "application/pdf" });

const uploadReq = (file?: File) => {
  const form = new FormData();
  if (file) form.append("file", file);
  return new Request("http://site.test/api/upload", { method: "POST", body: form });
};

const saveReq = (body: unknown, secret: string | null = RESULTS_SECRET) =>
  new Request("http://site.test/api/save-results", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-results-secret": secret } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const statusReq = (id: string) => new Request(`http://site.test/api/status?id=${id}`);

async function newJob(): Promise<string> {
  const res = await upload(uploadReq(pdfFile()));
  assert.equal(res.status, 202);
  return (await res.json()).jobId;
}

before(async () => {
  blobsDir = await mkdtemp(path.join(os.tmpdir(), "blobs-test-"));
  blobs = new BlobsServer({ directory: blobsDir, token: "test-token" });
  const { port } = await blobs.start();
  const url = `http://localhost:${port}`;
  // On Netlify this is set for you. Here we point Blobs at the local test server.
  (globalThis as any).netlifyBlobsContext = Buffer.from(
    JSON.stringify({ edgeURL: url, uncachedEdgeURL: url, token: "test-token", siteID: "test-site" }),
  ).toString("base64");

  fakeN8n = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastN8nRequest = { headers: req.headers, body: Buffer.concat(chunks).toString("latin1") };
      res.writeHead(n8nMode === "ok" ? 200 : 500).end("{}");
    });
  });
  await new Promise<void>((resolve) => fakeN8n.listen(0, resolve));
  const n8nPort = (fakeN8n.address() as any).port;

  env.N8N_WEBHOOK_URL = `http://localhost:${n8nPort}/webhook/study`;
  env.N8N_SECRET = N8N_SECRET;
  env.RESULTS_SECRET = RESULTS_SECRET;
});

after(async () => {
  await blobs.stop();
  fakeN8n.close();
  await rm(blobsDir, { recursive: true, force: true });
});

describe("upload", () => {
  test("rejects anything but POST", async () => {
    const res = await upload(new Request("http://site.test/api/upload"));
    assert.equal(res.status, 405);
  });

  test("rejects a missing file", async () => {
    assert.equal((await upload(uploadReq())).status, 400);
  });

  test("rejects a file that is not a PDF, even if named .pdf", async () => {
    const fake = new File([new TextEncoder().encode("<html>hi</html>")], "evil.pdf", { type: "application/pdf" });
    const res = await upload(uploadReq(fake));
    assert.equal(res.status, 400);
  });

  test("rejects a PDF over 4 MB", async () => {
    const res = await upload(uploadReq(pdfFile(4 * 1024 * 1024 + 1)));
    assert.equal(res.status, 413);
  });

  test("sends a valid PDF to n8n with the secret and a job id", async () => {
    n8nMode = "ok";
    const res = await upload(uploadReq(pdfFile()));
    assert.equal(res.status, 202);
    const { jobId } = await res.json();
    assert.match(jobId, /^[0-9a-f-]{36}$/);

    assert.equal(lastN8nRequest?.headers["x-secret"], N8N_SECRET);
    assert.match(lastN8nRequest!.body, /name="jobId"/);
    assert.ok(lastN8nRequest!.body.includes(jobId));
    assert.match(lastN8nRequest!.body, /name="file"/);
    assert.ok(lastN8nRequest!.body.includes("%PDF-"));

    const meta = await jobsStore().get(`${jobId}/meta`, { type: "json" });
    assert.equal(meta.fileName, "L6 - Unemployment.pdf");
  });

  test("returns 502 and leaves no job behind when n8n is down", async () => {
    const before = (await jobsStore().list()).blobs.length;
    n8nMode = "down";
    const res = await upload(uploadReq(pdfFile()));
    n8nMode = "ok";
    assert.equal(res.status, 502);
    assert.equal((await jobsStore().list()).blobs.length, before);
  });

  test("returns 500 when the server is not configured", async () => {
    const saved = env.N8N_WEBHOOK_URL;
    env.N8N_WEBHOOK_URL = undefined;
    assert.equal((await upload(uploadReq(pdfFile()))).status, 500);
    env.N8N_WEBHOOK_URL = saved;
  });
});

describe("save-results", () => {
  test("rejects a missing or wrong secret", async () => {
    const jobId = await newJob();
    const body = { jobId, stage: "notes", data: { topics: [] } };
    assert.equal((await saveResults(saveReq(body, null))).status, 401);
    assert.equal((await saveResults(saveReq(body, "wrong"))).status, 401);
    assert.equal((await saveResults(saveReq(body, RESULTS_SECRET + "x"))).status, 401);
  });

  test("rejects bad input", async () => {
    const jobId = await newJob();
    assert.equal((await saveResults(saveReq("not json"))).status, 400);
    assert.equal((await saveResults(saveReq({ jobId: "../../etc", stage: "notes", data: "x" }))).status, 400);
    assert.equal((await saveResults(saveReq({ jobId, stage: "meta", data: "x" }))).status, 400); // cannot overwrite meta
    assert.equal((await saveResults(saveReq({ jobId, stage: "notes" }))).status, 400);
    assert.equal((await saveResults(saveReq({ jobId: crypto.randomUUID(), stage: "notes", data: "x" }))).status, 404);
  });

  test("rejects an oversized body", async () => {
    const jobId = await newJob();
    const big = { jobId, stage: "notes", data: "x".repeat(200_001) };
    assert.equal((await saveResults(saveReq(big))).status, 413);
  });
});

describe("status", () => {
  test("rejects a bad or unknown id", async () => {
    assert.equal((await status(statusReq("nope"))).status, 400);
    assert.equal((await status(statusReq(crypto.randomUUID()))).status, 404);
  });

  test("walks through processing -> notes_ready -> complete", async () => {
    const jobId = await newJob();

    let body = await (await status(statusReq(jobId))).json();
    assert.equal(body.status, "processing");
    assert.equal(body.notes, null);

    // n8n often sends nested JSON as a string, sometimes inside a code fence.
    const notes = { topics: [{ title: "Unemployment", bullets: ["a", "b"] }] };
    let res = await saveResults(saveReq({ jobId, stage: "notes", topic: "Unemployment", data: "```json\n" + JSON.stringify(notes) + "\n```" }));
    assert.equal(res.status, 200);

    body = await (await status(statusReq(jobId))).json();
    assert.equal(body.status, "notes_ready");
    assert.deepEqual(body.notes, notes);
    assert.equal(body.topic, "Unemployment");
    assert.equal(body.context, null);

    const context = { articles: [{ title: "T", url: "https://example.com", why_it_fits: "w" }] };
    res = await saveResults(saveReq({ jobId, stage: "context", data: JSON.stringify(context) }));
    assert.equal(res.status, 200);

    body = await (await status(statusReq(jobId))).json();
    assert.equal(body.status, "complete");
    assert.deepEqual(body.context, context);
    assert.deepEqual(body.notes, notes);
  });

  test("keeps the notes when a later stage fails", async () => {
    const jobId = await newJob();
    await saveResults(saveReq({ jobId, stage: "notes", data: { topics: [] } }));
    await saveResults(saveReq({ jobId, stage: "error", data: { message: "Tavily out of credits" } }));
    const body = await (await status(statusReq(jobId))).json();
    assert.equal(body.status, "error");
    assert.equal(body.error, "Tavily out of credits");
    assert.deepEqual(body.notes, { topics: [] });
  });

  test("expires a job after 24 hours and deletes its data", async () => {
    const jobId = await newJob();
    await jobsStore().setJSON(`${jobId}/meta`, { createdAt: Date.now() - JOB_TTL_MS - 1000, fileName: "old.pdf" });
    assert.equal((await status(statusReq(jobId))).status, 410);
    assert.equal(await jobsStore().get(`${jobId}/meta`), null);
    assert.equal((await status(statusReq(jobId))).status, 404);
  });
});
