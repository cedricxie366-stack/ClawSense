"""Re-transcribe generated comparison WAVs, without any device audio IO."""
import argparse, json, wave
from pathlib import Path
import numpy as np
import sherpa_onnx

parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--model',required=True)
args=parser.parse_args();root=Path(args.root);model=Path(args.model)
recognizer=sherpa_onnx.OfflineRecognizer.from_sense_voice(tokens=str(model/'tokens.txt'),model=str(model/'model.int8.onnx'),language='auto',use_itn=True,num_threads=2)
rows=[]
for name in ['upstream-turn-1.wav','upstream-turn-9.wav','upstream-turn-10.wav','hf-turn-1.wav','hf-turn-2.wav','hf-turn-3.wav']:
    with wave.open(str(root/name),'rb') as f:
        assert f.getnchannels()==1 and f.getsampwidth()==2
        rate=f.getframerate();samples=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2').astype(np.float32)/32768
    normalized=np.interp(np.arange(int(len(samples)*16000/rate))*rate/16000,np.arange(len(samples)),samples).astype(np.float32)
    stream=recognizer.create_stream();stream.accept_waveform(16000,normalized);recognizer.decode_stream(stream)
    row={'file':name,'seconds':len(samples)/rate,'transcript':stream.result.text,'rms':float(np.sqrt(np.mean(samples**2))),'clippedFraction':float(np.mean(np.abs(samples)>.999)),'physicalMicrophone':False,'audibleOutput':False}
    rows.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
(root/'audio-comparison.json').write_text(json.dumps({'meaning':'Local ASR of actual generated PCM; not a human voice-naturalness verdict','rows':rows},ensure_ascii=False,indent=2))
