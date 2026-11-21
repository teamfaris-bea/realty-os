# Local call transcriber (faster-whisper)

A small HTTP sidecar that turns call audio into text on the team's own GPU machine. There is no cloud transcriber in
Realty OS: the API adapter (`apps/api/src/providers/transcription/localWhisper.ts`) only talks to a loopback or
private address.

## Setup (WSL2 Ubuntu 24.04, NVIDIA GPU)

```bash
sudo apt-get install -y python3-venv ffmpeg espeak-ng
python3 -m venv ~/whisper-bench/.venv && . ~/whisper-bench/.venv/bin/activate
pip install faster-whisper nvidia-cublas-cu12 'nvidia-cudnn-cu12==9.*' 'av<16'   # av 16+ breaks faster-whisper 1.2.1
SP=$(python -c 'import site;print(site.getsitepackages()[0])')
export LD_LIBRARY_PATH=$SP/nvidia/cublas/lib:$SP/nvidia/cudnn/lib:$LD_LIBRARY_PATH
python server.py            # 127.0.0.1:8765, model large-v3-turbo, float16 on cuda
```

Listening on anything but loopback requires `TRANSCRIBER_TOKEN`. The server keeps no audio on disk, logs no bodies,
and runs one transcription at a time so it never hogs a shared GPU.

## Benchmark (synthetic speech only)

`gen_synthetic_call.sh` makes an invented one-minute agent/client call with espeak-ng (8 kHz, phone quality), a
ten-minute version, and a dual-channel version. `run_bench.sh` times it. Results on an RTX 4080 SUPER (16 GB),
2026-11-21, with another job sharing the machine:

| model | clip | audio | wall | realtime factor | WER* | peak GPU memory |
|---|---|---|---|---|---|---|
| large-v3-turbo fp16 | 1 min mono | 57.8 s | 2.21 s | 26x (includes warm-up) | 0.5% | 3.4 GB |
| large-v3-turbo fp16 | 10 min mono | 578.4 s | 11.26 s | 51x | 1.0% | 3.4 GB |
| large-v3-turbo fp16 | 1 min stereo | 57.8 s | 1.11 s | 52x | n/a | 3.4 GB |
| small fp16 | 10 min mono | 578.4 s | 14.08 s | 41x | 3.3% | 2.1 GB |

\* word error rate against the script. Synthetic TTS is clean speech: expect a higher error rate on real phone audio
(crosstalk, noise, accents). Re-measure on real calls only after the recording decisions in
`docs/design/draft-local-transcription.md` are made.

Through the HTTP sidecar (`smoke_server.sh`), the dual-channel call came back as 17 segments labelled agent (6) and
client (11); mono comes back with speaker `null`.
