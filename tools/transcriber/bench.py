#!/usr/bin/env python3
"""Realtime-factor benchmark for the local transcriber, on synthetic speech only.

  python bench.py clip.wav [clip2.wav ...]   (WHISPER_MODEL / WHISPER_DEVICE / WHISPER_COMPUTE as in server.py)

Prints one JSON line per clip: audio seconds, wall seconds, realtime factor (audio / wall, higher is
faster), peak GPU memory when nvidia-smi is present, and the word error rate against a .txt reference
next to the clip when there is one.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time

from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "float16")


def wer(ref: str, hyp: str) -> float:
    norm = lambda s: re.sub(r"[^a-z0-9' ]", " ", s.lower()).split()
    r, h = norm(ref), norm(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))


peak = {"mib": 0}
stop = threading.Event()


def watch_gpu():
    while not stop.is_set():
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5).stdout
            peak["mib"] = max(peak["mib"], int(out.strip().splitlines()[0]))
        except Exception:
            pass
        stop.wait(0.5)


t0 = time.time()
m = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE, cpu_threads=2)
load_s = time.time() - t0
threading.Thread(target=watch_gpu, daemon=True).start()
print(json.dumps({"model": MODEL, "device": DEVICE, "compute": COMPUTE, "load_s": round(load_s, 2)}))
for path in sys.argv[1:]:
    t = time.time()
    segs, info = m.transcribe(path, vad_filter=True, beam_size=5, condition_on_previous_text=False)
    text = " ".join(s.text.strip() for s in segs)
    wall = time.time() - t
    row = {"clip": os.path.basename(path), "audio_s": round(info.duration, 1), "wall_s": round(wall, 2), "rtf_x": round(info.duration / wall, 1)}
    ref = os.path.splitext(path)[0] + ".txt"
    if os.path.exists(ref):
        row["wer"] = round(wer(open(ref).read(), text), 3)
    print(json.dumps(row))
stop.set()
print(json.dumps({"gpu_peak_mib": peak["mib"]}))
