#!/bin/bash
# Runs the synthetic-audio benchmark on the local GPU (low CPU priority).
cd ~/whisper-bench && . .venv/bin/activate
SP=$(python -c 'import site;print(site.getsitepackages()[0])')
export LD_LIBRARY_PATH=$SP/nvidia/cublas/lib:$SP/nvidia/cudnn/lib:$LD_LIBRARY_PATH
nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader
WHISPER_MODEL=large-v3-turbo nice -n 10 python bench.py clips/call_1min.wav clips/call_10min.wav clips/call_stereo.wav 2>&1 | grep -v Warning
WHISPER_MODEL=small nice -n 10 python bench.py clips/call_1min.wav clips/call_10min.wav 2>&1 | grep -v Warning
echo BENCH_DONE
