"""Quiet upstream-pipeline check. Real models optional; never opens audio devices."""
import argparse, asyncio, base64, json, time, wave
from pathlib import Path
from types import SimpleNamespace
import aiohttp
from loguru import logger
from pipecat.frames.frames import Frame, LLMRunFrame, EndFrame
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams
from pipecat.pipeline.worker import PipelineWorker, PipelineParams
from pipecat.workers.runner import WorkerRunner
from runtime import ModelBridge, make_pipeline

class Passthrough(FrameProcessor):
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)

class SilentOutput(BaseOutputTransport):
    def __init__(self):
        super().__init__(TransportParams(audio_out_enabled=True, audio_out_sample_rate=24000))
        self.audio = bytearray(); self.first = None
    async def start(self, frame):
        await super().start(frame)
        await self.set_transport_ready(frame)
    async def write_audio_frame(self, frame):
        if self.first is None: self.first = time.monotonic()
        self.audio.extend(frame.audio)
        # Exercise the actual upstream queue with a bounded real-time silent sink.
        await asyncio.sleep(len(frame.audio)/(frame.sample_rate*2*frame.num_channels))
        return True

class FixtureBridge:
    response_id = "fixture"
    responses = {}
    receipt_errors = []
    async def flush_receipts(self): pass
    async def commit_heard(self,message): pass
    async def call(self, op, **data): return {"ok":True}
    def current_frame(self): return None
    async def stream(self, op, **data):
        if op == "reply":
            yield {"type":"response","responseId":"fixture"}
            yield {"type":"text","text":"这是一句完整的测试语音。"}
        elif op == "tts":
            for _ in range(5): yield {"type":"audio","pcm":base64.b64encode(bytes(9600)).decode(),"sampleRate":24000}

async def check(args):
    logger.remove()
    # Keep failures visible; model/processor debug logs may contain transcripts.
    logger.add(lambda m: print(str(m).strip()), level="ERROR")
    root=Path(args.root);root.mkdir(parents=True,exist_ok=True)
    http=None;bridge=FixtureBridge()
    if args.real:
        device=json.loads((root/'fixture-device.json').read_text())
        http=aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=150))
        bridge=ModelBridge('http://127.0.0.1:19721',(root/'bridge-token').read_text().strip(),'Bearer '+device['deviceSecret'],http)
        began=time.monotonic();await bridge.open();print(json.dumps({'preparationMs':round((time.monotonic()-began)*1000)}))
    sink=SilentOutput();transport=SimpleNamespace(input=lambda:Passthrough(),output=lambda:sink)
    pipeline,context,assistant=make_pipeline(transport,bridge)
    worker=PipelineWorker(pipeline,enable_rtvi=False,params=PipelineParams(audio_in_sample_rate=16000,audio_out_sample_rate=24000),idle_timeout_secs=180)
    runner=WorkerRunner(handle_sigint=False);await runner.add_workers(worker)
    done=asyncio.Event();ready=asyncio.Event();messages=[];errors=[]
    @worker.event_handler('on_pipeline_started')
    async def started(_,frame):ready.set()
    @worker.event_handler('on_pipeline_error')
    async def failed(_,frame):
        errors.append(frame.error)
    @assistant.event_handler('on_assistant_turn_stopped')
    async def finished(_,message):
        messages.append({'text':message.content,'interrupted':message.interrupted});done.set()
    task=asyncio.create_task(runner.run())
    queries=["请原样朗读：会议安排在明天下午四点，预算五万元，方案周六交付。"]
    if args.suite:
        queries += ["客户小叶周五要方案，预算六万元。请复述安排。", "客户叫什么？", "方案改为周四，预算改为八万元，请简短确认。", "小叶现在的安排是什么？", "为什么树叶是绿色的？", "把谢谢你今天的帮助翻译成英语。", "小叶的预算现在是多少？", "请原样朗读：测试订单金额为1,234.50元，约在16:30核对。", "请原样朗读：Please send the revised proposal before Friday afternoon and confirm the meeting time with the customer.", "读全文"]
    if args.reading_only:
        queries += ["请原样朗读：测试订单金额为1,234.50元，约在16:30核对。", "请原样朗读：Please send the revised proposal before Friday afternoon and confirm the meeting time with the customer."]
    results=[]
    try:
        await asyncio.wait_for(ready.wait(),20)
        for number,query in enumerate(queries,1):
            done.clear();sink.audio.clear();sink.first=None;began=time.monotonic()
            context.add_message({'role':'user','content':query})
            await worker.queue_frames([LLMRunFrame()])
            await asyncio.wait_for(done.wait(),90)
            await bridge.flush_receipts()
            duration=len(sink.audio)/48000
            row={'turn':number,'query':query,**messages[-1],'pcmSeconds':duration,'frames':len(sink.audio)//2,'firstSinkMs':round((sink.first-began)*1000) if sink.first else None,'completedMs':round((time.monotonic()-began)*1000),'physicalMicrophone':False,'audibleOutput':False}
            if not sink.audio or row['interrupted']:raise RuntimeError('incomplete_normal_turn')
            prefix='controlled' if args.reading_only else 'upstream'
            with wave.open(str(root/f'{prefix}-turn-{number}.wav'),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(24000);f.writeframes(bytes(sink.audio))
            row['pipelineErrors']=list(errors)
            results.append(row);print(json.dumps(row,ensure_ascii=False))
            if errors:raise RuntimeError('upstream_pipeline_reported_error')
    finally:
        await runner.cancel();await asyncio.gather(task,return_exceptions=True)
        if http:await bridge.close();await http.close()
        output='pipeline-controlled.json' if args.reading_only else 'pipeline-real.json' if args.real else 'pipeline-fixture.json'
        (root/output).write_text(json.dumps({'realModels':args.real,'completed':len(results)==len(queries) and not errors,'errors':errors,'rows':results},ensure_ascii=False,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--real',action='store_true');parser.add_argument('--suite',action='store_true');parser.add_argument('--reading-only',action='store_true')
    asyncio.run(check(parser.parse_args()))
