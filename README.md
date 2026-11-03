# Study Better Econ (SBE)

Upload an economics lecture PDF. Get study notes for up to three topics, then real-world context for each one: news articles, a US vs India comparison from World Bank data, and a modern-history parallel. Every outside fact links to its source.

Built for the AI Club Applied AI Development Program capstone (CU Boulder).

**Live site:** studybetterecon.netlify.app

## Who it is for

Students in an economics course who want dense lectures turned into short notes, plus real world context that show the ideas at work. The tool is economics only, and the comparison covers the United States and India only. Narrow scope keeps the results accurate.

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

I started with a narrow idea (economics lectures only), defined the user and the problem, and built it in layers, testing each layer before adding the next.

1. **Design.** The site lives on Netlify and handles upload, status and display. The AI work runs in an n8n workflow. A job ID links the two, and the page checks for results every few seconds, so the notes can appear first and the real-world context a few minutes later.
2. **Backend first.** The three Netlify functions (upload, save-results, status) came first, with 14 automated tests.
3. **The workflow, one stage at a time.** I built the n8n pipeline stage by stage and tested each with real lecture PDFs: webhook, Gemini writes the notes, a code step splits them into topics, the three agents, a merge step, and delivery to the site.
4. **Hardening.** Two separate secrets protect the two directions. Uploads get a PDF check, a 4 MB cap and a rate limit. AI output is shown as plain text under a strict content security policy. Results expire after 24 hours. Gemini calls retry, and a failure takes an error path instead of a blank page.
5. **Interface.** The SBE logo, a dark theme by default with a light option, and a wide layout that uses the whole window. Text contrast was checked in both themes, and the page was tested in a browser at five screen sizes.
6. **Shipping.** GitHub to Netlify. I scanned the exported workflow for secrets before committing it.

### Problems I hit and what I changed

- **Malformed JSON.** Gemini could not reliably write long notes as JSON, so it now writes plain lines and code builds the JSON.
- **Gemini overload (503 errors).** The notes step now tries up to four times, then sends a plain error message to the page.
- **Different data years.** The US and India can report different years for the same measure, so each value shows its own year. The page builds the World Bank link, so the AI cannot invent one.
- **A private Netlify site blocked n8n.** The site is public, and the secret header protects the endpoint.
- **A merge step assumed the agents returned text.** They return structured data, so it now handles both.
- **Saved test data can hold secrets.** I only exported the workflow after clearing it and scanning the file.

### Who did what

I came up with the idea, chose the scope and requirements, built, ran and tested the n8n workflow, set up the secrets and deployment, and tested everything on real lectures. I used Claude (Anthropic) as a coding assistant. It wrote the Netlify site and functions, drafted the agent prompts and code steps, and helped with debugging and the visual design. I chose the colors, the name and the logo concept, and I tested each part before moving on.

It has been tested on a small number of real lectures, not at scale.
