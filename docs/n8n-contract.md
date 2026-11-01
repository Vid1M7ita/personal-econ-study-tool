# How n8n and the website talk to each other

The website never sees your API keys, and n8n never sees the visitor. They only
exchange two things, both protected by a shared secret.

## 1. Website to n8n (the upload)

n8n **Webhook** node:

| Setting | Value |
|---|---|
| HTTP Method | POST |
| Authentication | Header Auth. Credential name `x-secret`, value = the `n8n-in` secret |
| Respond | Immediately |
| Binary property | `file` |

What arrives:

- the PDF, as binary data in the property `file`
- a form field `jobId`, available as `{{ $json.body.jobId }}` right after the Webhook node
  (later, reach it with `{{ $('Webhook').item.json.body.jobId }}`)

Carry `jobId` through the whole workflow. Every result you send back needs it.

## 2. n8n to website (the results)

Use an **HTTP Request** node each time a stage finishes.

| Setting | Value |
|---|---|
| Method | POST |
| URL | `https://<your-site>.netlify.app/api/save-results` |
| Header | `x-results-secret` = the `results-in` secret |
| Body Content Type | JSON |

Body fields:

| Field | Value |
|---|---|
| `jobId` | the job id from step 1 |
| `stage` | `notes`, `context` or `error` |
| `topic` | optional short text |
| `data` | the payload below. An object or a JSON string both work |

Send `notes` as soon as the notes are written. Send `context` when the
enrichment agents finish. If anything fails, send `error` with
`data` = `{"message": "plain sentence the student can read"}`.
The page keeps showing the notes even if a later stage fails.

### `notes` payload

```json
{
  "topics": [
    {
      "title": "Types of unemployment",
      "bullets": ["Frictional: workers between jobs.", "Structural: skills do not match open jobs."],
      "analogy": "Optional. Only when the topic was flagged as hard."
    }
  ]
}
```

Plain text only. No markdown. (The page strips `**` and leading `-` if they slip through.)

### `context` payload

Every key is optional. The page shows only what is present.

```json
{
  "articles": [
    { "topic": "...", "title": "...", "url": "https://...", "published": "2026-07-08", "why_it_fits": "One sentence." }
  ],
  "comparison": [
    { "topic": "...", "code": "FP.CPI.TOTL.ZG", "indicator": "Inflation, consumer prices (annual %)", "us": "2.9", "us_year": "2024", "india": "2.4", "india_year": "2025", "takeaway": "One sentence." }
  ],
  "history": [
    { "episode": "The Volcker disinflation", "years": "1979 to 1982", "topic": "...", "similarity": "...", "difference": "...", "url": "https://..." }
  ],
  "note": "Optional message, for example: No article found for topic 2."
}
```

Set `"verified": false` on any item the verifier agent could not confirm. The page
labels it "Could not be verified".

The two countries often report different years, so give each value its own year. The page builds the World Bank link from `code`, so never write a URL for the comparison.

Links must start with `https://` or `http://`. Anything else is shown as plain text.

## Limits

- Result bodies over 200,000 characters are refused.
- A PDF over 4 MB is refused before it reaches n8n.
- Jobs and their results are deleted 24 hours after upload.
