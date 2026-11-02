#!/usr/bin/env python3
"""Prepare only a NEW isolated Live state. No global config, phone or main runtime changes."""
import argparse, hashlib, json, os, shutil, subprocess, sys, platform
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--state-dir',required=True);p.add_argument('--port',type=int,default=19495);p.add_argument('--live-port',type=int,default=19496);p.add_argument('--lan-host');p.add_argument('--skip-install',action='store_true');p.add_argument('--llm-model',default='mlx-community/Qwen3-4B-Instruct-2507-4bit');p.add_argument('--vision-model',default='mlx-community/Qwen3.5-2B-4bit');p.add_argument('--tts-model',default='mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit');a=p.parse_args()
if platform.system()!='Darwin' or platform.machine() not in ('arm64','aarch64'):p.error('The default local profile currently requires native Apple Silicon macOS/Python; other platforms need a separately configured provider.')
root=Path(a.state_dir).expanduser().resolve();repo=Path(__file__).resolve().parents[2]
existing=[root/'connection.json',root/'.standalone.lock',root/'state/connection.json',root/'state/.standalone.lock',root/'config.json']
if any(path.exists() for path in existing):p.error('Refusing to modify an existing Live profile or companion state. Choose a fresh directory.')
if a.port==a.live_port:p.error('Ports must be different')
root.mkdir(parents=True,exist_ok=True);root.chmod(0o700)
venv=root/'venv';uv=shutil.which('uv')
if not uv:p.error('Install uv to prepare the isolated Python runtime')
if not (venv/'bin/python').exists():subprocess.run([uv,'venv',str(venv),'--python','3.12'],check=True)
python=venv/'bin/python'
if not a.skip_install:subprocess.run([uv,'pip','install','--python',str(python),'-r',str(repo/'scripts/live/requirements.txt')],check=True)
# Download in this interpreter so preparation works from a plain system Python.
code='''
import hashlib,json,sys
from pathlib import Path
from huggingface_hub import HfApi,snapshot_download
api=HfApi();manifest={};paths={}
pinned={'mlx-community/Qwen3-4B-Instruct-2507-4bit':'50d427756c6b1b2fe0c0a10f67fbda1fc8e82c1b','mlx-community/Qwen3.5-2B-4bit':'674aaa7240b91e8012fcad5d791b7dfe5ba90207','mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit':'049ef77fe8816b536193c0c25f9a214d17921282','csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en':'8e40c43232a1c5c66c82111efc5820d3accca11b','mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit':'41d3337e8b7f2843a75841595fc14e4b9a7a4b96'}
for role,name in [('llm',sys.argv[2]),('tts',sys.argv[3]),('vision',sys.argv[4]),('asr','csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en')]:
 info=api.model_info(name,revision=pinned.get(name));kwargs={}
 if role=='asr':kwargs['allow_patterns']=['encoder.int8.onnx','decoder.int8.onnx','tokens.txt','README.md']
 location=snapshot_download(name,revision=info.sha,**kwargs)
 paths[role]=location;files=[]
 for f in Path(location).rglob('*'):
  if f.is_file():
   h=hashlib.sha256()
   with f.open('rb') as stream:
    for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
   files.append({'file':str(f.relative_to(location)),'bytes':f.stat().st_size,'sha256':h.hexdigest()})
 manifest[role]={'repo':name,'revision':info.sha,'files':files}
Path(sys.argv[1]).write_text(json.dumps({'paths':paths,'models':manifest},indent=2))
'''
subprocess.run([str(python),'-c',code,str(root/'models.json'),a.llm_model,a.tts_model,a.vision_model],check=True)
models=json.loads((root/'models.json').read_text())
# Direct upstream Silero; checksum is part of the tested profile.
import urllib.request
vad=root/'silero_vad.onnx'
if not vad.exists():urllib.request.urlretrieve('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',vad)
if hashlib.sha256(vad.read_bytes()).hexdigest()!='9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6':p.error('Unexpected VAD model checksum')
asr_code="const {prepareLocalAsr}=await import(process.argv[1]);const r=await prepareLocalAsr({stateDir:process.argv[2]});process.stdout.write(JSON.stringify(r.config));"
asr_result=subprocess.run(['node','--input-type=module','-e',asr_code,str(repo/'dist/src/local-asr-setup.js'),str(root/'ambient-asr')],check=True,capture_output=True,text=True)
background_asr=json.loads(asr_result.stdout)
config={**background_asr,'hostModelImageMode':'metadata-only','hostModelVideoMode':'keyframes','retrievalEmbeddingBackend':'none','hostModelAudioMode':'asr-first','live':{'enabled':True,'host':'0.0.0.0' if a.lan_host else '127.0.0.1','port':a.live_port,'python':str(python),'worker':str(repo/'scripts/live/worker.py'),'llmModel':models['paths']['llm'],'ttsModel':models['paths']['tts'],'asrDir':models['paths']['asr'],'asrRecheckDir':background_asr['localAsrModelDir'],'vadModel':str(vad),'visionModel':models['paths']['vision']}}
if a.lan_host:config['publicBaseUrl']=f'http://{a.lan_host}:{a.port}'
# Local path names do not contain parameter counts, so preserve explicit model metadata.
config['live']['ttsModel']=models['paths']['tts']
file=root/'config.json';file.write_text(json.dumps(config,indent=2));file.chmod(0o600)
print(json.dumps({'ready':True,'config':str(file),'command':['node',str(repo/'dist/src/cli.js'),'live-serve','--state-dir',str(root/'state'),'--port',str(a.port),'--host','0.0.0.0' if a.lan_host else '127.0.0.1','--config',str(file)]},indent=2))
