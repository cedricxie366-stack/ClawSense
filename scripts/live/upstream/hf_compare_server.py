"""Launch the pinned HF runtime as an independent loopback-only comparator.
The only replacement is STT's inference adapter, to use identical ONNX assets.
"""
import argparse, dataclasses, os, signal
from pathlib import Path
from threading import Event
import torch
from speech_to_speech import backend_registry as registry
from speech_to_speech.config import load_config, resolve_config
from speech_to_speech.configured_runtime import build_configured_server

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--silero-source',required=True)
    args=parser.parse_args()
    original=torch.hub.load
    source=Path(args.silero_source).resolve()
    if not (source/'hubconf.py').is_file():parser.error('prepare a pinned local Silero source first')
    def local_hub(repo_or_dir, model, *a, **kw):
        if str(repo_or_dir).startswith('snakers4/silero-vad'):
            kw.pop('trust_repo',None);kw.pop('skip_validation',None)
            return original(str(source),model,*a,source='local',**kw)
        raise RuntimeError('unconfigured_hub_download')
    torch.hub.load=local_hub
    old=registry.STT_BACKENDS['sense-voice']
    registry.STT_BACKENDS['sense-voice']=dataclasses.replace(old,
        create_handler=registry._simple_handler_factory('hf_sensevoice','SherpaSenseVoice',attach_speculative_turns=True),required_extra=None)
    config=resolve_config(load_config(args.config),environ={})
    stop=Event();runtime=build_configured_server(config,stop)
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:stop.set())
    try:
        runtime.start();print('Independent HF comparison server ready; no microphone or speaker.',flush=True);runtime.wait()
    finally:runtime.stop()

if __name__=='__main__':main()
