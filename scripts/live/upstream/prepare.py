"""Prepare an isolated optional upstream runtime, never start capture or a server."""
import argparse, json, os, secrets, shutil, subprocess
from pathlib import Path

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source-config',required=True)
    parser.add_argument('--directory',required=True)
    parser.add_argument('--port',type=int,default=19721)
    parser.add_argument('--sidecar-port',type=int,default=19723)
    parser.add_argument('--live-port',type=int,default=19722)
    parser.add_argument('--install',action='store_true')
    args=parser.parse_args()
    ports=[args.port,args.sidecar_port,args.live_port]
    if len(set(ports))!=3 or any(p<1024 or p>65535 for p in ports):parser.error('use three distinct non-privileged ports')
    source=json.loads(Path(args.source_config).read_text()).get('live',{})
    root=Path(args.directory).expanduser().resolve()
    if root.exists() and any(root.iterdir()):parser.error('choose a new empty isolated directory; existing files will not be overwritten')
    keys=['python','worker','asrDir','asrRecheckDir','asrFinalLanguage','vadModel','llmModel','ttsModel','visionModel']
    live={k:source[k] for k in keys if k in source}
    for key in ['python','worker','asrDir','asrRecheckDir','llmModel','ttsModel']:
        if not isinstance(live.get(key),str) or not Path(live[key]).exists():parser.error('prepare valid local '+key+' first')
    root.mkdir(parents=True,exist_ok=True,mode=0o700);root.chmod(0o700)
    token_file=root/'bridge-token';token_file.write_text(secrets.token_urlsafe(48));token_file.chmod(0o600)
    live.update(enabled=True,host='127.0.0.1',port=args.live_port,projectId='live-upstream',
        upstream={'url':f'http://127.0.0.1:{args.sidecar_port}/','tokenFile':str(token_file),'maxSessionMs':120000})
    config={'hostModelImageMode':'metadata-only','hostModelVideoMode':'none','retrievalEmbeddingBackend':'none',
        'localAsrBackend':'none','asrWorkerEnabled':False,'publicBaseUrl':f'http://127.0.0.1:{args.port}','live':live}
    cfg=root/'config.json';cfg.write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n');cfg.chmod(0o600)
    if args.install:
        uv=shutil.which('uv')
        if not uv:parser.error('uv is required for optional dependency installation')
        env={**os.environ,'UV_CACHE_DIR':str(root/'uv-cache')}
        subprocess.run([uv,'venv','--python',live['python'],str(root/'venv')],env=env,check=True)
        subprocess.run([uv,'pip','install','--python',str(root/'venv/bin/python'),'-r',str(Path(__file__).with_name('requirements.txt'))],env=env,check=True)
    result={'configured':True,'dependenciesInstalled':args.install,'stateDirectory':str(root/'state'),
        'configuration':str(cfg),'ports':ports,'hardwareStarted':False,'externalModelsEnabled':False}
    (root/'prepared.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
