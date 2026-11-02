#!/usr/bin/env python3
"""Compare the original RMS gate and direct Silero on explicitly supplied PCM, no microphone capture."""
import argparse,json,time,hashlib
from pathlib import Path
import numpy as np
import sherpa_onnx
p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--speech-pcm',required=True);p.add_argument('--out',required=True);a=p.parse_args()
c=sherpa_onnx.VadModelConfig();c.silero_vad.model=a.model;c.silero_vad.threshold=.5;c.silero_vad.min_speech_duration=.032;c.silero_vad.min_silence_duration=.1;c.sample_rate=16000;c.num_threads=1
speech=np.frombuffer(Path(a.speech_pcm).read_bytes(),dtype='<i2').astype(np.float32)/32768
rng=np.random.default_rng(42);knocks=np.zeros(16000*10,np.float32)
for i in range(0,len(knocks),8000):knocks[i:i+240]=rng.normal(0,.1,240)
cases={'speech':speech,'quiet-speech':speech*.08,'silence':np.zeros(16000*10,np.float32),'noise':rng.normal(0,.002,16000*10).astype(np.float32),'knocks':knocks}
rows=[]
for name,samples in cases.items():
 vad=sherpa_onnx.VoiceActivityDetector(c,buffer_size_in_seconds=1);start=time.process_time();active=[];rms=[]
 for i in range(0,len(samples)-511,512):
  chunk=samples[i:i+512];vad.accept_waveform(chunk);active.append(vad.is_speech_detected());rms.append(float(np.sqrt(np.mean(chunk*chunk)))>=.0015)
  while not vad.empty():vad.pop()
 rows.append({'case':name,'durationMs':len(samples)/16,'sileroActiveMs':sum(active)*32,'rmsActiveMs':sum(rms)*32,'firstSileroMs':next((i*32 for i,v in enumerate(active) if v),None),'cpuMs':round((time.process_time()-start)*1000,2),'humanSpeech':False})
report={'implementation':'sherpa-onnx 1.13.8 / direct Silero','modelSha256':hashlib.sha256(Path(a.model).read_bytes()).hexdigest(),'samples':rows,'limits':'Synthetic authorized speech and generated noise only; TV/other speakers and phone energy require separate checks. RealTimeCut wrapper is not benchmarked by these numbers.'}
Path(a.out).write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False))
