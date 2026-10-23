# Shared briefs

Put shared briefs here, one markdown file per series: `briefs/<name>.md`. The create page lists each file as a choice, labelled by its file stem (`acme.md` shows as `acme`). This README is skipped.

A shared brief holds what every video in a series has in common: where the sources are, the truth rules (what may be claimed and how to mark inferences), a template folder to copy the style from, and any extra locations the build agent may write to (for example a reference solution for coding videos). When you pick one on the create page, the generated `brief.md` tells the build agent to read it first and follow it.

The folder is set by `briefsDir` in `studio.config.json` (default `./briefs`). None ship with the repo.
