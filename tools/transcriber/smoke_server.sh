#!/bin/bash
# Starts the sidecar on loopback, posts the synthetic stereo call, prints a short summary, stops the sidecar.
cd ~/whisper-bench && . .venv/bin/activate
SP=$(python -c 'import site;print(site.getsitepackages()[0])')
export LD_LIBRARY_PATH=$SP/nvidia/cublas/lib:$SP/nvidia/cudnn/lib:$LD_LIBRARY_PATH
TRANSCRIBER_PORT=8765 nice -n 10 python server.py & PID=$!
for i in $(seq 30); do curl -sf http://127.0.0.1:8765/healthz >/dev/null && break; sleep 1; done
curl -s http://127.0.0.1:8765/healthz; echo
for f in call_stereo call_1min; do
  /usr/bin/time -f "$f wall=%es" curl -s -X POST -H 'Content-Type: audio/wav' --data-binary @clips/$f.wav http://127.0.0.1:8765/v1/transcribe -o /tmp/$f.json
  python - "$f" <<'PY'
import json,sys,collections
d=json.load(open(f"/tmp/{sys.argv[1]}.json"))
c=collections.Counter(s["speaker"] for s in d["segments"])
print(sys.argv[1], "lang", d["language"], "durationMs", d["durationMs"], "segments", len(d["segments"]), dict(c))
print("  first:", [(s["speaker"], s["text"][:60]) for s in d["segments"][:3]])
PY
done
curl -s -o /dev/null -w "non-audio -> %{http_code}\n" -X POST -H 'Content-Type: text/plain' --data 'x' http://127.0.0.1:8765/v1/transcribe
kill $PID
