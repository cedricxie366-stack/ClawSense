#!/usr/bin/env python3
"""Isolated model worker. JSON frames only on stdout; never captures a microphone.
Each role owns its model and executes one request at a time. Input reader can cancel
between generated chunks without allowing concurrent access to MLX arrays.
"""
import argparse, atexit, base64, contextlib, io, json, math, os, platform, queue, re, sys, threading, time
from pathlib import Path
from process_activity import ProcessActivity
activity = ProcessActivity()
activity.begin()
atexit.register(activity.end)
import numpy as np
parser = argparse.ArgumentParser()
parser.add_argument('--role', choices=['asr','final-asr','llm','tts','native','vad','vision'], required=True)
parser.add_argument('--model', required=True)
args = parser.parse_args()
output = sys.stdout
# Dependencies and hub progress must never contaminate the wire protocol.
sys.stdout = sys.stderr
jobs = queue.Queue(maxsize=8)
cancelled = set()
pending = set()
lock = threading.Lock()
def emit(identifier, kind, **fields):
    with lock:
        output.write(json.dumps(dict(id=identifier, type=kind, **fields), ensure_ascii=False)+'\n'); output.flush()
def reader():
    for line in sys.stdin:
        try:
            request=json.loads(line)
            request['_received_monotonic']=time.monotonic()
            if request.get('op')=='cancel':
                if request.get('target') in pending:cancelled.add(request['target'])
                continue
            pending.add(request.get("id"));jobs.put(request)
        except Exception:
            emit('', 'error', code='invalid_worker_request')
    jobs.put(None)
threading.Thread(target=reader, daemon=True).start()
model = tokenizer = None
prompt_caches = None
wired_limit_bytes = 0
images = []
streams = {}
prepared_vad = None
def retain_active_model():
    global wired_limit_bytes
    if args.role not in ('llm','tts','vision'):return
    if wired_limit_bytes:return
    import mlx.core as mx
    maximum=mx.device_info().get('max_recommended_working_set_size',0)
    fraction={'llm':0.28,'tts':0.36,'vision':0.22}[args.role]
    try:
        wired_limit_bytes=int(maximum*fraction)
        mx.set_wired_limit(wired_limit_bytes)
    except RuntimeError:wired_limit_bytes=0
def load():
    global model,tokenizer,prompt_caches
    if model is not None:return
    if args.role in ('llm','tts','vision'):
        import mlx.core as mx
        # Each isolated model process otherwise keeps a large free-buffer pool.
        # Bound spare buffers without evicting live model weights or the KV cache.
        mx.set_cache_limit(64*1024*1024)
        retain_active_model()
    if args.role=='asr':
        import sherpa_onnx
        root=Path(args.model)
        model=sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=str(root/'tokens.txt'),encoder=str(root/'encoder.int8.onnx'),decoder=str(root/'decoder.int8.onnx'),num_threads=2)
    elif args.role=='final-asr':
        import sherpa_onnx
        root=Path(args.model)
        # Short-command rechecks compete with active synthesis on shared-memory
        # Macs. Keep a bounded CPU pool; smaller and other hosts retain two.
        threads=4 if platform.system()=='Darwin' and (os.cpu_count() or 1)>=8 else 2
        model=sherpa_onnx.OfflineRecognizer.from_sense_voice(tokens=str(root/'tokens.txt'),model=str(root/'model.int8.onnx'),language=os.environ.get('CLAWSENSE_ASR_LANGUAGE','zh'),use_itn=True,num_threads=threads)
    elif args.role=='llm':
        from mlx_lm import load as load_lm
        from mlx_lm.models.cache import LRUPromptCache
        # The subsequent required warmup exercises the live path. Avoid eagerly
        # materializing every tensor and then reading it again during warmup.
        model,tokenizer=load_lm(args.model,lazy=True)
        prompt_caches=LRUPromptCache(max_size=4,max_bytes=192*1024*1024)
    elif args.role=='tts':
        from mlx_audio.tts.utils import load_model
        model=load_model(args.model,lazy=True)
    elif args.role=='vad':
        import sherpa_onnx
        config=sherpa_onnx.VadModelConfig()
        config.silero_vad.model=args.model
        config.silero_vad.threshold=0.5
        config.silero_vad.min_speech_duration=0.032
        config.silero_vad.min_silence_duration=0.032
        config.sample_rate=16000
        config.num_threads=1
        model=config
    elif args.role=='vision':
        from mlx_vlm import load as load_vlm
        model,tokenizer=load_vlm(args.model)
    else:
        if platform.system()=='Darwin':raise RuntimeError('native_pytorch_adapter_requires_cuda_mac_cpp_runner_not_configured')
        import torch
        if not torch.cuda.is_available():raise RuntimeError('native_requires_supported_gpu_use_local_cascade')
        if torch.cuda.get_device_properties(0).total_memory < 28*1024**3:raise RuntimeError('native_pytorch_requires_28gb_gpu')
        from transformers import AutoModel
        model=AutoModel.from_pretrained(args.model,trust_remote_code=True,torch_dtype=torch.bfloat16,attn_implementation='sdpa').eval().cuda()
        model.init_tts()
def pcm(value):return np.frombuffer(base64.b64decode(value,validate=True),dtype='<i2').astype(np.float32)/32768
def memory_metrics():
    import mlx.core as mx
    return dict(activeMemoryMiB=mx.get_active_memory()/1024**2,cacheMemoryMiB=mx.get_cache_memory()/1024**2,peakMemoryMiB=mx.get_peak_memory()/1024**2,wiredLimitMiB=wired_limit_bytes/1024**2)
while True:
    try:
        request=jobs.get(timeout=2)
    except queue.Empty:
        activity.end()
        continue
    if request is None:break
    identifier=request.get('id','')
    try:
        if identifier in cancelled:continue
        operation_started=time.monotonic()
        op=request.get('op')
        if op not in ('idle','reset','barrier'):activity.begin()
        if op=='barrier':
            if model is not None and args.role in ('llm','tts','vision'):
                import mlx.core as mx
                mx.synchronize()
            continue
        if op=='idle':
            if model is not None and args.role in ('llm','tts','vision'):
                import mlx.core as mx
                if prompt_caches is not None:prompt_caches.trim_to(n_sequences=0)
                mx.synchronize();mx.set_wired_limit(0);wired_limit_bytes=0;mx.clear_cache()
            activity.end()
            continue
        if op=='reset':
            streams.pop(request.get('sessionId'),None)
            if args.role=='llm' and prompt_caches is not None:prompt_caches.trim_to(n_sequences=0)
            continue
        if args.role=='vision' and op=='preload':
            import mlx_vlm
            emit(identifier,'capabilities',librariesReady=True)
            continue
        if args.role=='vision' and op=='describe':
            from PIL import Image, ImageOps
            from vision_policy import instruction as visual_instruction, overview_question, quality_message, scoped_description
            images=[]
            for jpeg in request.get('images',[request.get('jpeg')])[:2]:
                with Image.open(io.BytesIO(base64.b64decode(jpeg,validate=True))) as raw:
                    image=ImageOps.exif_transpose(raw).convert('RGB')
                image.thumbnail((768,768));images.append(image)
            if not images:raise ValueError('empty_frames')
            for image in images:
                gray=np.asarray(image,dtype=np.float32).mean(axis=2)/255
                uncertain=quality_message(float(gray.mean()),float(gray.std()),float(np.percentile(gray,95)),len(images))
                if uncertain:break
            if uncertain:
                emit(identifier,'description',text=uncertain,quality='insufficient')
                continue
        model_load_started=time.monotonic();load();model_load_ms=(time.monotonic()-model_load_started)*1000
        residency_started=time.monotonic()
        if op in ('generate','speak','describe') or (op=='probe' and request.get('warmup',True)):retain_active_model()
        residency_ms=(time.monotonic()-residency_started)*1000
        if op=='probe':
            if args.role=='llm' and request.get('warmup',True):
                from mlx_lm import stream_generate
                from mlx_lm.sample_utils import make_sampler
                from mlx_lm.models.cache import make_prompt_cache
                warm_prompt=tokenizer.apply_chat_template(request.get('messages',[{'role':'user','content':'你好'}]),tokenize=False,add_generation_prompt=True,enable_thinking=False)
                warm_tokens=tokenizer.encode(warm_prompt,add_special_tokens=tokenizer.bos_token is None or not warm_prompt.startswith(tokenizer.bos_token))
                warm_cache,remaining=prompt_caches.fetch_nearest_cache(args.model,warm_tokens) if request.get('messages') and os.environ.get('CLAWSENSE_LLM_PREFIX_CACHE','1')!='0' else (None,warm_tokens)
                if warm_cache is None or not remaining:warm_cache=make_prompt_cache(model);remaining=warm_tokens
                warm_key=warm_tokens[:]
                for value in stream_generate(model,tokenizer,prompt=remaining,prompt_cache=warm_cache,max_tokens=1,sampler=make_sampler(temp=0.3,top_p=0.9)):warm_key.append(value.token)
                if request.get('messages') and os.environ.get('CLAWSENSE_LLM_PREFIX_CACHE','1')!='0':prompt_caches.insert_cache(args.model,warm_key,warm_cache)
            elif args.role=='tts' and request.get('warmup',True):
                style=request.get('style','自然、清楚、温和') if getattr(model.config,'tts_model_size','')=='1b7' else None
                # Exercise the real codec with one short frame. A full warmup
                # sentence needlessly delays readiness; actual replies retain
                # their original text, sampling and streaming interval.
                warm_stream=model.generate(text='好。',voice=request.get('voice','Vivian'),instruct=style,lang_code='Chinese',temperature=0.3,stream=True,streaming_interval=0.08,max_tokens=4)
                try:
                    next(warm_stream)
                finally:
                    warm_stream.close()
            elif args.role=='asr' and request.get('warmup',True):
                warm=model.create_stream();warm.accept_waveform(16000,np.zeros(24000,dtype=np.float32));warm.input_finished()
                while model.is_ready(warm):model.decode_stream(warm)
            elif args.role=='final-asr' and request.get('warmup',True):
                warm=model.create_stream();warm.accept_waveform(16000,np.zeros(5120 if request.get('control') else 16000,dtype=np.float32));model.decode_stream(warm)
            elif args.role=='vad' and prepared_vad is None:
                # Loading VadModelConfig alone does not load its ONNX model.
                # Make and exercise one clean detector before declaring ready,
                # so the first live frame is not stuck initializing the graph.
                import sherpa_onnx
                prepared_vad=sherpa_onnx.VoiceActivityDetector(model,buffer_size_in_seconds=1)
                prepared_vad.accept_waveform(np.zeros(512,dtype=np.float32))
                prepared_vad.reset()
            probe_metrics=dict(modelLoadMs=model_load_ms,probeMs=(time.monotonic()-operation_started)*1000,activityProtected=activity.active)
            if args.role=='native' :emit(identifier,'capabilities',ready=True,streamingInput=False,streamingText=True,streamingAudio=True,fullDuplex=False,voices=['reference'],styleControl=True,**probe_metrics)
            elif args.role=='tts':
                voices=list(model.supported_speakers)
                emit(identifier,'capabilities',ready=True,voices=voices,styleControl=getattr(model.config, 'tts_model_size', '') == '1b7',**probe_metrics)
            else:emit(identifier,'capabilities',ready=True,**probe_metrics)
        elif args.role=='asr' and op=='audio':
            sid=request['sessionId']; stream=streams.get(sid)
            if stream is None:stream=streams[sid]=model.create_stream()
            samples=pcm(request['pcm'])
            # Communication DSP can produce very quiet but valid speech. Keep the
            # waveform intact and lift low-level voiced chunks, without boosting silence.
            rms=float(np.sqrt(np.mean(samples*samples))) if samples.size else 0.0
            peak=float(np.max(np.abs(samples))) if samples.size else 0.0
            if 0.0003 < rms < 0.03 and peak > 0:
                samples=samples*min(8.0,0.03/rms,0.95/peak)
            stream.accept_waveform(16000,samples)
            if request.get('final'):
                stream.accept_waveform(16000,np.zeros(8000,dtype=np.float32));stream.input_finished()
            while model.is_ready(stream):model.decode_stream(stream)
            emit(identifier,'transcript',text=model.get_result(stream))
            if request.get('final'):streams.pop(sid,None)
        elif args.role=='final-asr' and op=='transcribe':
            samples=pcm(request['pcm']);rms=float(np.sqrt(np.mean(samples*samples))) if samples.size else 0.0
            if 0.0003 < rms < 0.03:samples=samples*min(8.0,0.03/rms,0.95/max(0.0001,float(np.max(np.abs(samples)))))
            stream=model.create_stream();stream.accept_waveform(16000,samples);model.decode_stream(stream)
            emit(identifier,'transcript',text=stream.result.text)
        elif args.role=='vad' and op=='audio':
            import sherpa_onnx
            sid=request['sessionId'];state=streams.get(sid)
            if state is None:
                detector=prepared_vad if prepared_vad is not None else sherpa_onnx.VoiceActivityDetector(model,buffer_size_in_seconds=1)
                prepared_vad=None
                state=streams[sid]={'detector':detector,'samples':np.array([],dtype=np.float32),'voiced':False}
            state['samples']=np.concatenate([state['samples'],pcm(request['pcm'])])
            decisions=[]
            while state['samples'].size>=512:
                state['detector'].accept_waveform(state['samples'][:512]);state['samples']=state['samples'][512:]
                decisions.append(state['detector'].is_speech_detected())
                while not state['detector'].empty():state['detector'].pop()
            # 20ms capture packets are shorter than Silero's 32ms window.
            # No new window means no new decision, not evidence of silence.
            if decisions:state['voiced']=decisions[-1]
            voiced=any(decisions) if decisions else state['voiced']
            emit(identifier,'vad',voiced=voiced)
        elif args.role=='vision' and op=='describe':
            from mlx_vlm import generate, stream_generate
            from mlx_vlm.prompt_utils import apply_chat_template
            question=request['query'][:500]
            prompt=apply_chat_template(tokenizer,model.config,visual_instruction(question,len(images)),num_images=len(images),enable_thinking=False)
            if len(images)==1 and overview_question(question):
                pieces=[];boundary=False;last=None
                stream=stream_generate(model,tokenizer,prompt,image=images,max_tokens=64,temperature=0.0)
                try:
                    for part in stream:
                        last=part
                        if identifier in cancelled:break
                        pieces.append(part.text)
                        if re.search(r'[，,。；;\n]', ''.join(pieces)):
                            boundary=True;break
                finally:
                    stream.close()
                    import mlx.core as mx
                    mx.synchronize()
                text=''.join(pieces)
                if not boundary and getattr(last,'finish_reason',None)=='length':raise RuntimeError('current_frame_unreadable')
            else:
                text=generate(model,tokenizer,prompt,image=images,max_tokens=96,temperature=0.0,verbose=False).text
            if identifier not in cancelled:emit(identifier,'description',text=scoped_description(text,question,len(images)))
        elif args.role=='llm' and op=='generate':
            from mlx_lm import stream_generate
            from mlx_lm.sample_utils import make_sampler
            from mlx_lm.models.cache import make_prompt_cache
            messages=request['messages']
            prompt=tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True,enable_thinking=False)
            tokens=tokenizer.encode(prompt,add_special_tokens=tokenizer.bos_token is None or not prompt.startswith(tokenizer.bos_token))
            enabled=os.environ.get('CLAWSENSE_LLM_PREFIX_CACHE','1')!='0'
            lookup=time.monotonic()
            cache,rest=prompt_caches.fetch_nearest_cache(args.model,tokens) if enabled else (None,tokens)
            lookup_ms=(time.monotonic()-lookup)*1000
            cached=len(tokens)-len(rest)
            if cache is None:cache=make_prompt_cache(model)
            # Exact matches still need the last token to compute logits.
            if not rest:
                cache=make_prompt_cache(model);rest=tokens;cached=0
            key=tokens[:];began=time.monotonic();first=None
            for result in stream_generate(model,tokenizer,prompt=rest,prompt_cache=cache,max_tokens=384,sampler=make_sampler(temp=0.3,top_p=0.9)):
                if identifier in cancelled:break
                if first is None:first=(time.monotonic()-began)*1000
                key.append(result.token)
                emit(identifier,'text',text=result.text)
            if enabled and identifier not in cancelled:prompt_caches.insert_cache(args.model,key,cache)
            emit(identifier,'model_metrics',promptTokens=len(tokens),cachedTokens=cached,firstTokenMs=first,cacheLookupMs=lookup_ms,cacheBytes=prompt_caches.nbytes,requestPreparationMs=(began-operation_started)*1000,workerQueueMs=(operation_started-request.get('_received_monotonic',operation_started))*1000,modelLoadMs=model_load_ms,residencyMs=residency_ms,**memory_metrics())
        elif args.role=='tts' and op=='speak':
            style=request.get('style') if getattr(model.config, 'tts_model_size', '') == '1b7' else None
            # A lower sampling temperature reduced short-utterance duration variance
            # in the local voice calibration. Do not add pacing prose to the style:
            # this model can turn it into exaggerated pauses instead.
            temperature=request.get('temperature',0.3)
            if isinstance(temperature,bool) or not isinstance(temperature,(int,float)) or not math.isfinite(temperature) or not 0.1<=temperature<=1.5:raise RuntimeError('invalid_tts_temperature')
            # One selected speaker/style gets stable sampling across sentences,
            # warmups, other voices and cancelled requests. This is a bounded
            # stability measure, not a claim of perceptually identical voices.
            seed=request.get('seed',0)
            if isinstance(seed,bool) or not isinstance(seed,int) or not 0<=seed<=0xffffffff:raise RuntimeError('invalid_tts_seed')
            import mlx.core as mx
            mx.synchronize();mx.random.seed(seed)
            began=time.monotonic();first=None;duration=0
            for result in model.generate(text=request['text'],voice=request.get('voice','Vivian'),instruct=style,lang_code='Chinese',stream=True,streaming_interval=0.24,max_tokens=1024,temperature=temperature):
                if identifier in cancelled:break
                if first is None:first=(time.monotonic()-began)*1000
                values=np.asarray(result.audio).reshape(-1)
                audio=(np.clip(values,-1,1)*32767).astype('<i2').tobytes()
                duration+=len(audio)/2/int(result.sample_rate)*1000
                emit(identifier,'audio',pcm=base64.b64encode(audio).decode(),sampleRate=int(result.sample_rate))
            emit(identifier,'model_metrics',firstAudioMs=first,totalMs=(time.monotonic()-began)*1000,generatedDurationMs=duration,modelLoadMs=model_load_ms,residencyMs=residency_ms,**memory_metrics())
        elif args.role=='native' and op in ('generate','speak'):
            import torch
            model.reset_session()
            ref=None
            reference=os.environ.get('CLAWSENSE_VOICE_REFERENCE')
            if reference:
                import librosa
                ref,_=librosa.load(reference,sr=16000,mono=True)
            model.init_token2wav_cache(ref)
            sid=identifier
            system=model.get_sys_prompt(ref_audio=ref,mode='omni',language='zh')
            system['content'].append(request.get('system','请自然地用中文回答。'))
            model.streaming_prefill(session_id=sid,msgs=[system])
            if op=='generate':
                history=[{'role':x['role'],'content':[x['content']]} for x in request.get('history',[])]
                if history:model.streaming_prefill(session_id=sid,msgs=history)
                if request.get('pcm'):
                    values=pcm(request['pcm'])
                    for offset in range(0,len(values),16000):
                        chunk=values[offset:offset+16000]
                        last=offset+16000>=len(values)
                        if last and len(chunk)<16000:chunk=np.pad(chunk,(0,16000-len(chunk)))
                        model.streaming_prefill(session_id=sid,msgs=[{'role':'user','content':[chunk]}],is_last_chunk=last)
                else:model.streaming_prefill(session_id=sid,msgs=[{'role':'user','content':[request['query']]}],is_last_chunk=True)
            else:model.streaming_prefill(session_id=sid,msgs=[{'role':'user','content':['请朗读以下内容。']}],is_last_chunk=True)
            options={'teacher_forcing':True,'teacher_forcing_text':request['text']} if op=='speak' else {}
            for wav,text in model.streaming_generate(session_id=sid,generate_audio=True,use_tts_template=True,enable_thinking=False,do_sample=True,max_new_tokens=384,**options):
                if identifier in cancelled:break
                if text:emit(identifier,'text',text=text)
                if wav is not None:
                    values=wav.detach().float().cpu().numpy().reshape(-1) if isinstance(wav,torch.Tensor) else np.asarray(wav).reshape(-1)
                    emit(identifier,'audio',pcm=base64.b64encode((np.clip(values,-1,1)*32767).astype('<i2').tobytes()).decode(),sampleRate=24000)
        else:raise RuntimeError('unsupported_worker_operation')
    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        code=str(exc) if isinstance(exc,RuntimeError) and (str(exc).startswith('native_') or str(exc)=='current_frame_unreadable') else 'model_'+type(exc).__name__.lower()
        emit(identifier,'error',code=code)
    finally:
        if args.role=='vision':
            # Retaining model weights must not retain the last camera payload while idle.
            for captured in images:
                with contextlib.suppress(Exception):captured.close()
            images=[];image=jpeg=raw=None
            request.pop('images',None);request.pop('jpeg',None)
        emit(identifier,'done');cancelled.discard(identifier);pending.discard(identifier)
