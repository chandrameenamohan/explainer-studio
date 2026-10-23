Build one narrated explainer video (mp4). Repo: {{repo_root}}. Work only inside your own folder `{{video_dir}}/{{folder}}/` (and any extra location the shared brief names, such as a reference solution for a coding video); other sessions build videos in other folders, do not touch them. Do not commit to git. Run from the repo root.

{{shared_brief_block}}

## The topic
{{topic}}

## Outline (who it is for, sections in order with rough times)
{{outline}}

## Rules for facts
- Every claim must trace to a source. Quote key phrases exactly. Save what you use in `source.md` with exact quotes.
- Mark on screen what is stated in a source, what is your inference ("likely"), and what is not disclosed.
- Do not invent stories, people, numbers or outcomes. Where a fact is missing, show a marked slot on screen ("your real one here") and narrate "say your real one here".
- Mark invented example numbers as "illustrative" and list them in your report.
- If you cannot find or fetch the main source, stop and report; do not build the video from guesses. If WebFetch returns only a summary of a page, download the HTML with curl and extract the text yourself.

**Length: target 4:00 to 4:45. Hard limit 5:00; over 5:00 is a failure.** At speed 1.1 the voice does about 150 to 165 words a minute. Check narration.wav after TTS and cut lines if over.

## Style
Pipeline scripts: copy `{{studio_dir}}/pipeline/tts.py` and `{{studio_dir}}/pipeline/render.mjs` into your folder unchanged. Template: `{{studio_dir}}/examples/sd-model-serving/`; read its `script.json` and `explainer.html` for the structure (`renderAt(t)` as a pure function of time, cue ids per line, timeline.js). 3Blue1Brown style: dark background, serif labels, little text (at most about 25 words newly on screen at once), blue for the weak or rejected thing and yellow for the strong or chosen one, diagrams that build piece by piece in sync with the narration, one concrete example carried through the whole video. Narration in short simple sentences, one idea each, active voice. One brief everyday analogy is welcome (home analogies work well).

## Pipeline (run inside your folder; prefix heavy steps with `{{studio_dir}}/pipeline/heavy.sh`, which limits how many run at once on this machine)
```
{{studio_dir}}/pipeline/heavy.sh uv run --python 3.12 --with kokoro-onnx --with soundfile python tts.py $HOME/.cache/explainer-video/tts
PUPPETEER_FROM={{studio_dir}} {{studio_dir}}/pipeline/heavy.sh node render.mjs --stills <out_dir> 10 20 30
PUPPETEER_FROM={{studio_dir}} {{studio_dir}}/pipeline/heavy.sh node render.mjs {{folder}}.mp4
```
- `$HOME/.cache/explainer-video/tts` holds the Kokoro model files (`kokoro.onnx`, `voices.bin`); TTS caches spoken lines there too. If they are missing, stop and report.
- A heavy step may wait for a slot; that is expected. Never kill other node, Chrome or ffmpeg processes, and never remove lock folders you do not own.
- zsh does not word-split `$VAR`; pass still times as literal arguments.
- Do not name a top-level function `top` in explainer.html (it collides with `window.top` and the page never becomes ready).
- Spell numbers and acronyms in the `say` field of script.json ("M C P", "A I", "G P U", "sequel" for SQL, "two billion", "evaluation" for eval). Voice am_michael, speed 1.1.

## Verification before you report
- Render stills for at least one moment in every scene (scratch dir `stills/` in your folder; delete it at the end), view them with the Read tool, and fix overlaps, clipped text and empty frames.
- Confirm the final mp4 exists, has an audio stream, and is under 5:00 (`ffprobe`). Pull three or four frames from the final mp4 and look at them.

## Report back (short)
Final mp4 path and exact duration; the scene list, one line each; the full text of anything the viewer is meant to say aloud; every slot, invented number, inference, and anything that is not from a source; anything you could not find or verify.

{{extra_rules}}
