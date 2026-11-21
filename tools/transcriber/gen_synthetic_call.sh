#!/bin/bash
# Synthetic test calls only (invented script, espeak-ng TTS). No real people or data.
set -e
mkdir -p ~/whisper-bench/clips && cd ~/whisper-bench/clips
AGENT=(
"Hi, this is Alex with the real estate team. Is now a good time to talk for a minute?"
"Great. You filled out a form on our website about selling your home. Are you still thinking about that?"
"That makes sense. When would you ideally like to be moved out?"
"Okay, so by March. Have you already found the place you are moving to?"
"Got it. Would it help if I sent you a few recent sales in your neighborhood so you know what your home might be worth?"
"Perfect. I will email those over this afternoon and give you a call back on Thursday to walk through them."
)
CLIENT=(
"Sure, I have a few minutes."
"Yes, we are planning to sell the house. My husband got orders, so we have to move."
"Probably by March, once the orders come through. Maybe sooner if the house sells quickly."
"Not yet. We will probably rent there for a year first and then buy something."
"Yes, that would be really helpful. We have no idea what it is worth right now."
"Thursday works. Thank you so much."
)
: > call_ref.txt
i=0
for n in 0 1 2 3 4 5; do
  espeak-ng -v en-us -s 165 -w a$n.wav "${AGENT[$n]}"
  espeak-ng -v en-us+f3 -s 170 -w c$n.wav "${CLIENT[$n]}"
  echo "${AGENT[$n]} ${CLIENT[$n]}" >> call_ref.txt
done
# mono 8 kHz phone-quality call (~1 min)
files=""; for n in 0 1 2 3 4 5; do files="$files -i a$n.wav -i c$n.wav"; done
ffmpeg -loglevel error -y $files -filter_complex "concat=n=12:v=0:a=1,aresample=8000" -ac 1 call_1min.wav
cp call_ref.txt call_1min.txt
# 10-minute call: the one-minute call ten times
for k in $(seq 10); do echo "file 'call_1min.wav'"; done > list.txt
ffmpeg -loglevel error -y -f concat -safe 0 -i list.txt -c copy call_10min.wav
for k in $(seq 10); do cat call_ref.txt; done | tr '\n' ' ' > call_10min.txt
# dual-channel (agent left, client right), the way a dialer records
L=""; R=""
for n in 0 1 2 3 4 5; do
  da=$(ffprobe -v error -show_entries format=duration -of csv=p=0 a$n.wav); dc=$(ffprobe -v error -show_entries format=duration -of csv=p=0 c$n.wav)
  ffmpeg -loglevel error -y -f lavfi -t $dc -i anullsrc=r=22050:cl=mono sc$n.wav
  ffmpeg -loglevel error -y -f lavfi -t $da -i anullsrc=r=22050:cl=mono sa$n.wav
  L="$L -i a$n.wav -i sc$n.wav"; R="$R -i sa$n.wav -i c$n.wav"
done
ffmpeg -loglevel error -y $L -filter_complex "concat=n=12:v=0:a=1" left.wav
ffmpeg -loglevel error -y $R -filter_complex "concat=n=12:v=0:a=1" right.wav
ffmpeg -loglevel error -y -i left.wav -i right.wav -filter_complex "[0][1]amerge=inputs=2,aresample=8000" -ac 2 call_stereo.wav
for f in call_1min call_10min call_stereo; do printf "%s %s\n" $f $(ffprobe -v error -show_entries format=duration -of csv=p=0 $f.wav); done
