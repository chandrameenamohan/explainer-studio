# Explainer Studio

A local web studio for AI-made, 3Blue1Brown-style explainer videos, built for interview prep. It does four jobs:

- **Library**: every video in one page, grouped by company and round kind, with search across the narration.
- **Watch**: the video with a synced transcript, and a chat where you ask Claude about the moment you are watching. Answers cite moments as links that seek the player.
- **Knowledge vault**: save the concepts you learn as plain markdown in an Obsidian vault, linked back to the moments in the videos.
- **Create**: write a topic and an outline, and a Claude build session makes a new narrated video from it (script, animation, voice, render).

Everything runs on your machine. The server binds to loopback and the agents run on your own Claude Code login.

## Prerequisites

| For | You need |
|---|---|
| The studio (library, watch, vault) | Node 22.18 or newer (TypeScript runs directly, no build step) |
| Chat, concept drafts, seeding, create | Claude Code installed and logged in (the Agent SDK uses that login; set `claudePath` to pin a binary) |
| `make e2e` | Google Chrome. The tests drive it with `puppeteer-core` at the macOS default path; set `CHROME=/path/to/chrome` elsewhere |
| Rendering videos (create jobs) | [uv](https://docs.astral.sh/uv/) (it fetches Python 3.12, `kokoro-onnx`, `soundfile`), the Kokoro model files, ffmpeg with libx264 and aac, and Chrome |

The Kokoro voice model is two files, `kokoro.onnx` and `voices.bin`, from the `kokoro-onnx` release `model-files-v1.0`. Put them in `$HOME/.cache/explainer-video/tts/`; the build agent is told to look there. Text-to-speech runs locally and costs nothing.

## Quick start

The repo ships a small sample corpus in `examples/`. Run against it first:

```
npm ci
STUDIO_CONFIG=test/studio.test.config.json npm start
```

Open `http://127.0.0.1:4399`. You will see four sample folders: two rendered videos (`sd-model-serving`, `basics-pagination-worked`) and two that are not rendered yet. The sample mp4s are silent black placeholders of the right length, so the transcript, seeking and chat work, but there is nothing to see or hear. To get real pictures and sound, render a sample (see [Pipeline](#pipeline)) or create your own video.

Then run it on your own videos:

```
npm start
```

This uses `studio.config.json`: videos in `./videos/`, state in `./state/`, the vault in `./knowledge/`, port 4310. All three are gitignored. The server reads and builds the catalog once at start. Send `POST /api/catalog/rescan` (with the `X-Studio: 1` header) or restart to pick up new folders. A finished create job rescans by itself.

## Where videos go

Each video is one folder in `videoRoot` (`./videos/` by default). A rendered folder looks like `examples/sd-model-serving/`:

```
script.json      the narration: scenes, lines, voice, speed
explainer.html   the animation, a pure function of time: window.renderAt(t)
timeline.json    line and scene timings written by tts.py (timeline.js is the same, for the page)
narration.wav    the voice track
<folder>.mp4     the final video
brief.md         the brief a create job was started from (optional)
source.md        the sources the build used, with exact quotes (optional)
```

## How the catalog is built

Every folder in `videoRoot` that is not hidden and has a `timeline.json`, `script.json` or `brief.md` becomes a record. A folder with none of these is listed as unreadable with the reason, and the server keeps going.

- Folder name rule: `series-kind-NN-slug`, for example `acme-sd-01-rate-limiter` or `globex-beh-02-biggest-failure`. The series is a company from `companies` in the config, or a general series from `generalSeries` (default `basics`). The kind token is one of `sd` (system design), `beh` (behavioral), `code`, `hm` (hiring manager), `mgr`, `loop`, `next`, or `00` for a primer. `NN` may carry a letter (`06b`). Kind and number are optional: `acme-alerting` is Acme, kind Other. A folder whose series is not configured is shown as General, kind Other, and marked unsorted.
- `catalog.overrides.json` fixes one folder at a time. Each entry may set `company`, `kind`, `title` or `hidden`. The shipped file files the unsorted sample `sd-model-serving` under General, system design.
- The title and the transcript come from `timeline.json`, or from `script.json` when there is no timeline (then lines have no timestamps).
- mp4 rule: use `<folder>-explainer.mp4`, else `<folder>.mp4`, else the only mp4 in the folder. If there are several and none match, the video counts as not rendered.
- A folder without an mp4 still shows in the library, marked as not rendered. In the samples: `acme-sd-01-rate-limiter` (brief and script) and `globex-beh-01-biggest-failure` (brief only).
- Watch position and the watched flag are saved per video in `stateDir`.
- The watch page has two layouts, like YouTube. Default: the video on the left, with the transcript above the chat in a rail on the right. Theater: the video spans the page in a black band, with the transcript and the chat side by side below it. Switch with the Default and Theater buttons next to the title, or press `t`. The choice is remembered in this browser. Below 1100px wide both layouts stack into one column.

### Adding a company

Add it to `companies` in `studio.config.json`, keyed by the series token you use in folder names:

```json
"companies": { "acme": "Acme", "globex": "Globex", "initech": "Initech" },
"generalSeries": ["basics", "bigdata"]
```

Restart the server. Folders named `initech-...` now group under Initech. A series in `generalSeries` sorts as its own series but shows under General. For a folder that does not follow the rule, add an entry to `catalog.overrides.json`:

```json
{ "my-old-video": { "company": "Initech", "kind": "sd", "title": "Initech system design: search" } }
```

## Chat

The chat on the watch page answers questions about the video you are on. It is told you are preparing for software engineering interviews, plus your current timestamp and the line playing. Answers cite moments as `@m:ss`, which become links that seek the player.

- Read-only. The agent gets `Read`, `Grep` and `Glob`, runs in that video's folder, loads no user or project settings, and stops after 6 turns.
- Budget cap: `chatBudgetUsd` per question (default 0.5).
- Limits: one chat at a time per video, and `chatConcurrency` at once overall (default 2). Extra requests get 409 or 429.
- Each video keeps one conversation. It is saved in `stateDir` and resumed on the next question. If the old session cannot be resumed, the chat starts a new thread and says so.
- "New" clears the saved conversation for that video.

## Create

1. Open `/create`. Pick a shared brief (any `briefs/<name>.md`, see `briefs/README.md`) or none, then give a folder name, a topic and an outline.
2. The server fills `brief.template.md` and writes the result to `brief.md` in the new folder under `videoRoot`.
3. One build session starts at `repoRoot` with permissions bypassed. It logs every tool call and result to `studio-job.jsonl` in that folder, and the page tails the log live.
4. Only one job runs at a time. Cancel stops it. The job lives in server memory and dies with the server.
5. A job is done when the folder holds an mp4. Without one it is marked failed, even if the agent said it finished.
6. Retry means submitting again with the same folder name. The server refuses a folder that already has a rendered video.

The server itself writes into `videoRoot` only the new folder's `brief.md` and `studio-job.jsonl`; the build agent writes the rest.

## Pipeline

A create job builds a video in five steps, all inside the new folder. The brief (`brief.template.md`) spells out each one and points the agent at `pipeline/` for the scripts and at `examples/sd-model-serving/` as the style template.

1. **Brief → sources.** The agent reads the brief (and the shared brief, if any), gathers sources and saves the quotes it uses in `source.md`. Facts must trace to a source; missing facts become marked slots ("your real one here"), invented numbers are marked illustrative.
2. **script.json.** Scenes of short narration lines, each with an id. A `say` field spells out numbers and acronyms for the voice. Target length 4:00 to 4:45, hard limit 5:00.
3. **explainer.html.** A dark, 3Blue1Brown-style animation where `window.renderAt(t)` draws the frame at time `t` using `timeline.js`, so any moment can be rendered on its own.
4. **TTS.** `pipeline/tts.py` (copied into the folder) voices every line with Kokoro, voice `am_michael` at speed 1.1, and writes `narration.wav`, `timeline.json` and `timeline.js`. Lines are cached by text, so a re-run only voices what changed.
5. **Render.** `pipeline/render.mjs` (copied too) opens the page in headless Chrome, steps it frame by frame at 30 fps across four workers, pipes the frames to ffmpeg and muxes in the narration. `--stills <dir> 10 20 30` renders single frames to check the layout first.

Heavy steps run through `pipeline/heavy.sh`, which holds one of `HEAVY_SLOTS` (default 2) lock slots under `$HOME/.cache/explainer-video/locks`, so parallel build sessions do not run the machine out of memory. To render a sample by hand:

```
cd examples/sd-model-serving
cp ../../pipeline/tts.py ../../pipeline/render.mjs .
../../pipeline/heavy.sh uv run --python 3.12 --with kokoro-onnx --with soundfile python tts.py $HOME/.cache/explainer-video/tts
PUPPETEER_FROM=$PWD/../.. ../../pipeline/heavy.sh node render.mjs sd-model-serving-explainer.mp4
```

`PUPPETEER_FROM` points `render.mjs` at a folder whose `node_modules` holds `puppeteer-core` (this repo after `npm ci`). `CHROME` overrides the Chrome binary path.

## Knowledge vault

Concepts you learn from the videos live as plain markdown in `knowledgeRoot` (`./knowledge/`, created on first write). It is an Obsidian vault: open that folder in Obsidian and the files are `concepts/<slug>.md`, `videos/<folder>.md` (stubs the studio keeps in step with the catalog) and `companies/<key>.md`. Links are `[[slug]]`. The studio writes `.obsidian/app.json` if absent so new notes land in `concepts/`. The vault is yours to commit or sync; the studio never does.

- `/knowledge` lists every concept. Filter by company, status (`fuzzy`, `learning`, `known`) and kind, or search titles, aliases and your own words. Selecting one company shows its note on top. The Seed panel is here too.
- `/k/<slug>` is the concept page: edit "In my words" and status, see sources as seek links into the videos, related concepts, backlinks and similar titles. Delete moves the file to `.trash/`, it never unlinks.
- Saving non-empty "In my words" on a `fuzzy` concept promotes it to `learning`. Only you set `known`.

### Saving a concept

- On the watch page, press `s` (or use the Save concept button under a chat answer, or the `+` on a transcript line). A modal opens with a draft from the answer (one cheap model call, about $0.02, capped by `draftBudgetUsd`). The agent's definition is shown but not saved. Write it in your own words, that is the point.
- If the slug already exists, the modal offers to add this moment to the existing concept.
- Saved concepts for the current video and company are fed back into the chat prompt, so answers build on what you know.

### Seeding

Seed asks the model for 4 to 8 concepts per video and writes them as `fuzzy`, `origin: seed`, with an empty "In my words" and the agent's one-liner in the `definition:` frontmatter field. Quotes that are not in the script are dropped. Cost is about $0.05 per video on Sonnet, capped per job by `seedBudgetUsd` (default 15); at the cap the job stops and reports where. Start with a pilot: seed 10 videos (`limit`), review them in Obsidian or `/knowledge`, then run the rest. Seeding is idempotent: videos already seeded are skipped, so re-running resumes. Cancel with the stop button on the create page job view (`DELETE /api/job`). Seed shares the one-job-at-a-time slot with create jobs and never writes under `videoRoot`.

### Limits

- Last writer wins. If Obsidian and the studio write the same file, the later write stays. The studio checks the file's mtime before saving and answers 409 `file changed on disk`; the page reloads.
- A file whose name is not a slug (for example `Dynamic batching.md`) is listed as unreadable: rename it to a slug.
- Renaming a file in Obsidian breaks links to it; they show as unresolved on the concept page.
- A concept slug cannot equal a video folder or a company key.
- Not built: ask-the-graph chat, a force-layout graph (use Obsidian's), separate company pages, library badges, a merge tool, spaced repetition, notes as sources, automatic merging of duplicates.

## The gate

Run `make check` before committing.

- `make check`: `tsc --noEmit`, then the unit tests. They run against `examples/` through `test/studio.test.config.json` (the npm scripts set `STUDIO_CONFIG`), so they pass on a fresh clone. No mocks of the file system; scratch state goes to temp dirs.
- `make e2e`: a browser run of library, watch, chat, create and the knowledge pages with a fake agent (`STUDIO_FAKE_AGENT=1`), also against `examples/`. It needs Chrome through `puppeteer-core`; set `CHROME` if it is not at the macOS default path.
- `make learn`: probes the real Agent SDK and writes down what it saw in `learning-tests/agent-sdk/findings.md`. It costs a few cents and needs a Claude login.

## Config

`studio.config.json`, or the file named by `STUDIO_CONFIG`. Paths are relative to the config file.

| Key | Meaning | Default |
|---|---|---|
| `repoRoot` | where create jobs run | `.` |
| `videoRoot` | folder holding the videos | `./videos` |
| `stateDir` | per-video state | `./state` |
| `knowledgeRoot` | the Obsidian vault | `./knowledge` |
| `briefsDir` | shared briefs, one `<name>.md` each | `./briefs` |
| `companies` | series token → company display name | `{}` |
| `generalSeries` | series shown under General but not unsorted | `["basics"]` |
| `port` | listen port | 4310 |
| `host` | listen address | `127.0.0.1` |
| `model` | model override, or null | null |
| `claudePath` | path to the `claude` binary, or null for the SDK default | null |
| `chatConcurrency` | chats at once | 2 |
| `chatBudgetUsd` | cap per chat question | 0.5 |
| `jobBudgetUsd` | cap per create job | 15 |
| `vaultName` | Obsidian vault name for open links | `knowledge` |
| `seedModel` | model for seeding | `sonnet` |
| `seedBudgetUsd` | cap per seed job | 15 |
| `draftBudgetUsd` | cap per concept draft | 0.1 |

## Known limits

- No login. The server binds to loopback only. Do not set `host` to `0.0.0.0` or a LAN address: the chat and create agents run on your Claude login and the create agent has full write access. Every POST, PUT and DELETE must send `X-Studio: 1` and, if an `Origin` is present, it must be local.
- A create job is not saved. Restarting the server forgets a running job, though its log file stays in the folder.
- The catalog is not watched. New folders appear after a rescan.
- A create job runs with bypassed permissions at `repoRoot`. Keep the brief and extra rules to things you trust.
- Submitting a folder name that exists without an mp4 reuses that folder and overwrites its `brief.md`.
- The pipeline was built on macOS (Chrome path, Kokoro on CPU). It should work elsewhere with `CHROME` set, but that is untested.
