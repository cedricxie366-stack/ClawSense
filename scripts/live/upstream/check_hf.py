"""Independent HF Realtime protocol check with a quiet digital output sink."""
import argparse, asyncio, base64, json, time, wave
from pathlib import Path
import websockets

async def run(args):
    root=Path(args.root);rows=[]
    queries=['请原样朗读：会议安排在明天下午四点，预算五万元，方案周六交付。',
        '请原样朗读：测试订单金额为1,234.50元，约在16:30核对。',
        '请原样朗读：Please send the revised proposal before Friday afternoon and confirm the meeting time with the customer.']
    try:
        async with websockets.connect('ws://127.0.0.1:19731/v1/realtime',max_size=4*1024*1024) as ws:
            async def send(value):await ws.send(json.dumps(value))
            first=json.loads(await asyncio.wait_for(ws.recv(),15))
            if first['type']!='session.created':raise RuntimeError('session_not_created')
            await send({'type':'session.update','session':{'type':'realtime','instructions':'你是一位中文助手。直接回答问题；用户要求原样朗读时只输出原文，不加解释。','audio':{'input':{'turn_detection':None}}}})
            for number,query in enumerate(queries,1):
                await send({'type':'conversation.item.create','item':{'type':'message','role':'user','content':[{'type':'input_text','text':query}]}})
                began=time.monotonic();first_audio=None;audio=bytearray();text='';play_until=began;events=[]
                await send({'type':'response.create'})
                while True:
                    item=json.loads(await asyncio.wait_for(ws.recv(),120));kind=item['type'];events.append(kind)
                    if kind=='error':raise RuntimeError(json.dumps(item.get('error',{})))
                    if kind in ['response.output_audio.delta','response.audio.delta']:
                        now=time.monotonic();first_audio=first_audio or now
                        chunk=base64.b64decode(item['delta']);audio.extend(chunk);play_until=max(play_until,now)+len(chunk)/32000
                    if kind in ['response.output_audio_transcript.delta','response.audio_transcript.delta','response.output_text.delta','response.text.delta']:text+=item.get('delta','')
                    if kind=='response.done':
                        if item.get('response',{}).get('status') in ['failed','cancelled','incomplete']:raise RuntimeError('response_not_complete')
                        break
                generation_done=round((time.monotonic()-began)*1000)
                await asyncio.sleep(max(0,play_until-time.monotonic()))
                if not audio:raise RuntimeError('no_audio')
                with wave.open(str(root/f'hf-turn-{number}.wav'),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes(bytes(audio))
                row={'turn':number,'query':query,'text':text,'audioSeconds':len(audio)/32000,'firstReceivedMs':round((first_audio-began)*1000),'generationDoneMs':generation_done,'silentPlaybackCompletedMs':round((time.monotonic()-began)*1000),'physicalMicrophone':False,'audibleOutput':False,'eventTypes':sorted(set(events))}
                rows.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
    finally:
        (root/'hf-comparison.json').write_text(json.dumps({'completed':len(rows)==len(queries),'scope':'Pinned HF runtime with existing local LLM/TTS weights and ONNX STT adapter; separate process, no ClawSense memory; not identical model sampling or physical playback','rows':rows},ensure_ascii=False,indent=2))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True)
    asyncio.run(run(parser.parse_args()))
