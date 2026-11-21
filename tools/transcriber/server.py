#!/usr/bin/env python3
"""Local call transcriber for Realty OS (faster-whisper on the office GPU).

A tiny HTTP sidecar. It listens on 127.0.0.1 by default and is meant to be reached only over the
loopback interface or a private network (the API refuses any public host, see
apps/api/src/providers/transcription/localWhisper.ts). Audio is never written to disk by this
server and never sent anywhere else: the model runs on this machine.

  POST /v1/transcribe   body = raw audio bytes, Content-Type = audio/* ; optional ?language=en
                        header Authorization: Bearer <TRANSCRIBER_TOKEN> when TRANSCRIBER_TOKEN is set
                        -> {"language": "en", "durationMs": 61234, "segments": [{"startMs", "endMs", "speaker", "text"}]}
  GET  /healthz         -> {"ok": true, "model": "...", "device": "cuda"}

Environment:
  TRANSCRIBER_HOST (127.0.0.1)  TRANSCRIBER_PORT (8765)  TRANSCRIBER_TOKEN (unset = no auth, loopback only)
  WHISPER_MODEL (large-v3-turbo)  WHISPER_DEVICE (cuda)  WHISPER_COMPUTE (float16)
  TRANSCRIBER_MAX_BYTES (52428800)  TRANSCRIBER_CPU_THREADS (2: keeps the host CPU light)

Speaker labels: whisper does not separate speakers. A dual-channel (stereo) dialer recording, agent on
the left channel and client on the right, is split and each channel is labelled; mono audio gets
speaker null.
"""
from __future__ import annotations

import hmac
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("TRANSCRIBER_HOST", "127.0.0.1")
PORT = int(os.environ.get("TRANSCRIBER_PORT", "8765"))
TOKEN = os.environ.get("TRANSCRIBER_TOKEN", "")
MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("WHISPER_DEVICE", "cuda")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "float16")
MAX_BYTES = int(os.environ.get("TRANSCRIBER_MAX_BYTES", str(50 * 1024 * 1024)))
CPU_THREADS = int(os.environ.get("TRANSCRIBER_CPU_THREADS", "2"))

if HOST not in ("127.0.0.1", "::1", "localhost") and not TOKEN:
    raise SystemExit("TRANSCRIBER_TOKEN is required when listening on a non-loopback address")

_model = None
_lock = threading.Lock()  # one transcription at a time: the GPU is shared with other work


def model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE, cpu_threads=CPU_THREADS)
    return _model


def _segments(audio, language):
    segs, info = model().transcribe(audio, language=language, vad_filter=True, beam_size=5, condition_on_previous_text=False)
    return [{"startMs": int(s.start * 1000), "endMs": int(s.end * 1000), "text": s.text.strip()} for s in segs if s.text.strip()], info


def transcribe(data: bytes, language: str | None):
    from faster_whisper.audio import decode_audio

    channels = decode_audio(io.BytesIO(data), split_stereo=True)
    left, right = channels if isinstance(channels, tuple) else (channels, None)
    with _lock:
        if right is not None and len(right) and abs(left - right).max() > 1e-3:
            a, info = _segments(left, language)
            b, _ = _segments(right, language or info.language)
            out = [{**s, "speaker": "agent"} for s in a] + [{**s, "speaker": "client"} for s in b]
            out.sort(key=lambda s: (s["startMs"], s["endMs"]))
        else:
            mono, info = _segments(left, language)
            out = [{**s, "speaker": None} for s in mono]
    return {"language": info.language, "durationMs": int(info.duration * 1000), "segments": out}


class Handler(BaseHTTPRequestHandler):
    server_version = "realty-transcriber/1"

    def log_message(self, fmt, *args):  # never log bodies or transcripts; method, path and status only
        pass

    def _send(self, code: int, body: dict):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorized(self) -> bool:
        if not TOKEN:
            return True
        got = self.headers.get("Authorization", "")
        return hmac.compare_digest(got.encode(), f"Bearer {TOKEN}".encode())

    def do_GET(self):
        if urlparse(self.path).path == "/healthz":
            return self._send(200, {"ok": True, "model": MODEL, "device": DEVICE})
        self._send(404, {"error": "not_found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/v1/transcribe":
            return self._send(404, {"error": "not_found"})
        if not self._authorized():
            return self._send(401, {"error": "unauthorized"})
        ctype = self.headers.get("Content-Type", "")
        if not ctype.startswith("audio/"):
            return self._send(415, {"error": "unsupported_media_type"})
        n = int(self.headers.get("Content-Length", "0") or 0)
        if n <= 0 or n > MAX_BYTES:
            return self._send(413, {"error": "too_large_or_empty"})
        data = self.rfile.read(n)
        lang = (parse_qs(u.query).get("language") or [None])[0]
        try:
            self._send(200, transcribe(data, lang))
        except Exception:  # noqa: BLE001 - the reason is not echoed (it can quote audio metadata)
            self._send(422, {"error": "transcription_failed"})


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
