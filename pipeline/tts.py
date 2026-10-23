"""Narrate script.json with Kokoro (local, free) and write the timeline the animation syncs to.

Run:  uv run --python 3.12 --with kokoro-onnx --with soundfile python tts.py <model_dir>
<model_dir> holds kokoro.onnx and voices.bin (kokoro-onnx release "model-files-v1.0").
Writes narration.wav, timeline.json and timeline.js next to this file.
"""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = Path(__file__).parent
MODEL_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE
CACHE = MODEL_DIR / "line_cache"

LEAD_IN = 0.7      # silence before the first line
LINE_GAP = 0.32    # silence between lines of one scene
SCENE_GAP = 0.75   # silence between scenes
TAIL = 2.2         # hold on the last frame
SCENE_PRE = 0.45   # a scene becomes visible this long before its first line


def trim(samples, threshold=0.01, pad=240):
    loud = np.flatnonzero(np.abs(samples) > threshold)
    if loud.size == 0:
        return samples
    return samples[max(loud[0] - pad, 0): loud[-1] + pad]


def main():
    script = json.loads((HERE / "script.json").read_text())
    voice, speed = script["voice"], script["speed"]
    kokoro = Kokoro(str(MODEL_DIR / "kokoro.onnx"), str(MODEL_DIR / "voices.bin"))
    CACHE.mkdir(exist_ok=True)

    rate = 24000
    chunks, scenes = [], []
    cursor = LEAD_IN
    chunks.append(np.zeros(int(LEAD_IN * rate), dtype=np.float32))

    def silence(seconds):
        nonlocal cursor
        chunks.append(np.zeros(int(seconds * rate), dtype=np.float32))
        cursor += int(seconds * rate) / rate

    for si, scene in enumerate(script["scenes"]):
        lines = []
        for li, line in enumerate(scene["lines"]):
            spoken = line.get("say", line["text"])
            key = hashlib.sha1(f"{voice}|{speed}|{spoken}".encode()).hexdigest()[:16]
            wav = CACHE / f"{key}.wav"
            if wav.exists():
                samples, rate = sf.read(wav, dtype="float32")
            else:
                samples, rate = kokoro.create(spoken, voice=voice, speed=speed, lang="en-us")
                samples = trim(np.asarray(samples, dtype=np.float32))
                sf.write(wav, samples, rate)
            start = cursor
            chunks.append(samples)
            cursor += len(samples) / rate
            lines.append({"id": line["id"], "start": round(start, 3), "end": round(cursor, 3), "text": line["text"]})
            if li < len(scene["lines"]) - 1:
                silence(LINE_GAP)
        scenes.append({"id": scene["id"], "chip": scene["chip"], "lines": lines})
        if si < len(script["scenes"]) - 1:
            silence(SCENE_GAP)
    silence(TAIL)

    for i, scene in enumerate(scenes):
        scene["start"] = 0.0 if i == 0 else round(scene["lines"][0]["start"] - SCENE_PRE, 3)
    for i, scene in enumerate(scenes):
        scene["end"] = scenes[i + 1]["start"] if i < len(scenes) - 1 else round(cursor, 3)

    timeline = {"title": script["title"], "duration": round(cursor, 3), "scenes": scenes}
    sf.write(HERE / "narration.wav", np.concatenate(chunks), rate)
    (HERE / "timeline.json").write_text(json.dumps(timeline, indent=1))
    (HERE / "timeline.js").write_text("window.TIMELINE = " + json.dumps(timeline) + ";\n")
    print(f"duration {cursor:.1f}s, {sum(len(s['lines']) for s in scenes)} lines")
    for scene in scenes:
        print(f"  {scene['id']:9s} {scene['start']:6.1f} -> {scene['end']:6.1f}")


if __name__ == "__main__":
    main()
