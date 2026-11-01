# Study Better Econ (SBE)

Upload an economics lecture PDF. Get study notes for up to three topics, then real-world context for each one: news articles, a US vs India comparison from World Bank data, and a modern-history parallel. Every outside fact links to its source.

Built for the AI Club Applied AI Development Program capstone (CU Boulder).

**Live site:** [add your live URL here]

## Who it is for

Students in an intermediate economics course who want lecture slides turned into short notes, plus real examples that show the ideas at work. The tool is economics only, and the comparison covers the United States and India only. Narrow scope keeps the results accurate.

## What it does

1. The student uploads a lecture PDF (up to 4 MB).
2. Notes appear first: three topics, each with bullet points, and an analogy on topics that are hard for a first-time student.
3. About two to four minutes later, a "Real-world context" section appears:
   - **In the news:** up to three articles from search, each tagged with the topic it illustrates.
   - **United States and India:** two or three World Bank measures for the topic, each value with its own year.
   - **A similar moment in modern history:** a 20th- or 21st-century episode with a source link.

## How it works

```
Browser
  |  PDF
  v
Netlify function: upload         checks it is a PDF, makes a job id
  |  PDF + secret
  v
n8n workflow
  Webhook -> Gemini reads the PDF and writes notes -> Get Topics (code)
          -> Send notes ------------------------------------------+
          -> News agent -> US vs India agent -> History agent     |
          -> Combine context (code) -> Send results --------------+
                                                                  |
                                                                  v
Netlify function: save-results   checks a second secret, stores in Netlify Blobs
                                                                  |
Browser polls  <---  Netlify function: status  <------------------+
```

### Agents and automation

| Part | Type | What it does |
|---|---|---|
| Related News agent | Agent | Decides what to search for each topic, runs Tavily searches, picks real articles. |
| US vs India agent | Agent | Chooses the most relevant World Bank indicators from an allowed list, calls the World Bank API, writes a one-sentence comparison. |
| Modern history agent | Agent | Picks a modern episode for the clearest topics, searches for a reliable source, writes the similarity and difference. |
| Upload pipeline | Automation | Triggered by an upload. Receives the file, reads it with Gemini, writes the notes, builds the data, sends the notes, merges the three agent results, and sends them to the site. On failure it sends an error message instead. |

## Tech

Netlify (static page, Functions v2, Blobs), n8n Cloud, Google Gemini, Tavily search, World Bank Indicators API.

## Trust and security

- **Secrets stay out of the code.** They live in Netlify environment variables and n8n credentials. Two separate secrets protect the two directions (site to n8n, and n8n to site).
- **Uploads are checked.** The function reads the first bytes of the file to confirm it is a PDF, caps the size at 4 MB, and limits each visitor to five uploads a minute.
- **AI output is treated as untrusted.** The page shows it as plain text, never as HTML. Links must start with `http` or `https`. A strict content security policy blocks outside scripts.
- **Links to data are built by the page.** The World Bank link comes from the indicator code, so the AI cannot invent one.
- **Notes expire.** A job and its results are deleted 24 hours after upload.
- **Privacy.** Slides are sent to Google Gemini. The free tier may use inputs to improve Google's products, so upload only slides you are comfortable sharing.

## Known failure points

| What can go wrong | What the tool does |
|---|---|
| Gemini is overloaded (503 errors) | Tries up to four times. If it still fails, the page shows "The notes could not be made" with a plain next step. |
| The model returns malformed JSON | Avoided by design. Gemini writes simple text lines, and code builds the JSON. |
| An agent fails or returns nothing readable | The other two agents' results still reach the page, and a note says what is missing. |
| An agent picks a weak source or misreads one | Every item links to its source, and the page tells students to check before citing. |
| The two countries report different years | Each value shows its own year. |
| Free-tier limits (Tavily credits, n8n Cloud trial) | Runs are capped at a few searches each. The n8n trial ends in November, so the workflow is exported to this repo. |
| Slides that are not economics | Not handled. The tool is built and tested for economics lectures. |

## Run it yourself

1. Import the workflow from `n8n/` into n8n and create four credentials: a Header Auth credential named `x-secret` for the Webhook, a Header Auth credential named `x-results-secret` for the result nodes, a Gemini API key, and a Tavily API key.
2. Deploy this repo on Netlify and set three environment variables (mark them secret, Functions scope):
   - `N8N_WEBHOOK_URL`: the production URL of the n8n Webhook node
   - `N8N_SECRET`: the same value as the Webhook's `x-secret` credential
   - `RESULTS_SECRET`: the same value as the `x-results-secret` credential
3. Run the tests: `npm install` then `npm test`.

## Project layout

```
public/            the page (HTML, CSS, JavaScript) and fonts
netlify/functions/ upload, save-results, status
netlify/lib/       shared helpers
test/              backend tests (14)
docs/              the data format between n8n and the site
n8n/               the exported workflow
```

## How this was built

Vivi built, ran and tested the n8n workflow step by step. Claude (Anthropic) was used as a coding assistant: it wrote the Netlify site and functions and drafted the agent prompts, and Vivi tested each part. The site was also checked in a browser and with automated tests.
