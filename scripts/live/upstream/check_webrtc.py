"""Headless authenticated WebRTC check with generated PCM, never audio devices."""
import argparse, asyncio, base64, json, time, uuid, wave
from fractions import Fraction
from pathlib import Path
import aiohttp
import av
import numpy as np
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, AudioStreamTrack

class SyntheticMicrophone(AudioStreamTrack):
    def __init__(self, pcm):
        super().__init__();self.pcm=pcm;self.offset=0;self.started=None;self.armed=False;self.sent_voice_frames=0
    async def recv(self):
        if self.started is None:self.started=time.monotonic()
        target=self.started+self.offset/16000
        await asyncio.sleep(max(0,target-time.monotonic()))
        count=320
        if self.armed and self.sent_voice_frames*count < len(self.pcm):
            start=self.sent_voice_frames*count;audio=self.pcm[start:start+count];self.sent_voice_frames+=1
            if len(audio)<count:audio=np.pad(audio,(0,count-len(audio)))
        else:audio=np.zeros(count,dtype=np.int16)
        frame=av.AudioFrame.from_ndarray(audio.reshape(1,-1),format='s16',layout='mono')
        frame.sample_rate=16000;frame.pts=self.offset;frame.time_base=Fraction(1,16000)
        self.offset+=count;return frame

async def run(args):
    root=Path(args.root);device=json.loads((root/'fixture-device.json').read_text())
    with wave.open(args.audio,'rb') as f:
        assert f.getnchannels()==1 and f.getsampwidth()==2
        audio=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2');rate=f.getframerate()
    # Deterministic linear resampling is only the synthetic injection fixture.
    pcm=np.interp(np.arange(int(len(audio)*16000/rate))*rate/16000,np.arange(len(audio)),audio).astype(np.int16)
    if args.noise:
        count=48000;positions=np.arange(count)
        if args.noise=='white':pcm=np.random.default_rng(9127).integers(-700,701,count,dtype=np.int16)
        elif args.noise=='fan':pcm=(300*np.sin(2*np.pi*120*positions/16000)).astype(np.int16)
        else:
            phase=positions%12800;pcm=np.where(phase<160,1800*np.sin(2*np.pi*400*phase/16000)*np.exp(-phase/45),0).astype(np.int16)
    pc=RTCPeerConnection(RTCConfiguration(iceServers=[]));mic=SyntheticMicrophone(pcm);pc.addTrack(mic)
    channel=pc.createDataChannel('rtvi');ready=asyncio.Event();done=asyncio.Event();started_audio=asyncio.Event();events=[];received=[];tasks=[]
    @channel.on('open')
    def opened():channel.send(json.dumps({'label':'rtvi-ai','type':'client-ready','id':str(uuid.uuid4()),'data':{'version':'2.0.0'}}))
    @channel.on('message')
    def message(raw):
        try:
            value=json.loads(raw);events.append(value)
            if value.get('type') in ['bot-ready','bot-started-speaking','bot-stopped-speaking','error','error-response']:
                print(json.dumps({'event':value['type'],'at':time.monotonic()}),flush=True)
            if value.get('type') in ['error','error-response']:
                print(json.dumps({'testProtocolError':value.get('data')},ensure_ascii=False),flush=True)
            if value.get('type')=='bot-ready':ready.set()
            if value.get('type')=='bot-stopped-speaking':done.set()
        except (ValueError,TypeError):pass
    @pc.on('track')
    def track(remote):
        if remote.kind=='audio':
            async def read():
                while True:
                    frame=await remote.recv();peak=int(np.abs(frame.to_ndarray().astype(np.int32)).max());received.append({'samples':frame.samples,'rate':frame.sample_rate,'peak':peak,'at':time.monotonic()})
                    if peak>20:started_audio.set()
            tasks.append(asyncio.create_task(read()))
    outcome={'physicalMicrophone':False,'audibleOutput':False,'transport':'actual aiortc DTLS/SRTP with official SmallWebRTC','completed':False}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=95)) as http:
            offer=await pc.createOffer();await pc.setLocalDescription(offer)
            async with http.post('http://127.0.0.1:19721/api/clawsense/live-upstream/offer',headers={'authorization':'Bearer '+device['deviceSecret']},json={'sdp':pc.localDescription.sdp,'type':pc.localDescription.type,'request_data':{'vision':False}}) as response:
                if response.status!=200:raise RuntimeError('offer_failed_'+str(response.status))
                answer=await response.json()
            await pc.setRemoteDescription(RTCSessionDescription(sdp=answer['sdp'],type=answer['type']))
            await asyncio.wait_for(ready.wait(),30)
            if args.noise:
                mic.armed=True;await asyncio.sleep(7)
                assert not any(x['peak']>20 for x in received),'noise_triggered_speech'
                outcome['noiseCase']=args.noise
            elif args.stop or args.button_stop:
                def text(content):channel.send(json.dumps({'label':'rtvi-ai','type':'send-text','id':str(uuid.uuid4()),'data':{'content':content}}))
                text('请原样朗读：'+('火山内部的岩浆和气体压力不断增加，达到一定程度后会沿裂缝喷出地表。'*4))
                await asyncio.wait_for(started_audio.wait(),60)
                await asyncio.sleep(.5);begin=time.monotonic()
                if args.button_stop:
                    channel.send(json.dumps({'label':'rtvi-ai','type':'client-message','id':str(uuid.uuid4()),'data':{'t':'stop-speaking','d':{}}}))
                else:mic.armed=True
                await asyncio.wait_for(done.wait(),30)
                await asyncio.sleep(3)
                last=max(x['at'] for x in received if x['peak']>20)
                resumed=any(x['peak']>20 and x['at']>begin+1.0 for x in received)
                outcome.update(stopToLastReceivedNonSilentMs=round(max(0,last-begin)*1000),resumedAfterOneSecond=resumed)
                assert not resumed,'speech_resumed_after_stop'
                done.clear();before=len(events);text('六加八是多少？')
                await asyncio.wait_for(done.wait(),45)
                answer_text=''.join(e.get('data',{}).get('text','') for e in events[before:] if e.get('type')=='bot-output')
                assert '14' in answer_text or '十四' in answer_text,answer_text
                outcome['recoveryAnswer']=answer_text
            else:
                mic.armed=True
                await asyncio.wait_for(done.wait(),90)
            await asyncio.sleep(.5)
            texts=[x for x in events if x.get('type') in ['user-transcription','user-input','bot-output','bot-transcription']]
            outcome.update(completed=(not any(x['peak']>20 for x in received)) if args.noise else any(x['peak']>20 for x in received),injectedSpeechFrames=mic.sent_voice_frames,receivedAudioFrames=len(received),nonSilentFrames=sum(x['peak']>20 for x in received),events=texts)
            if not outcome['completed']:raise RuntimeError('no_remote_speech_audio')
    except Exception as error:
        outcome['error']=type(error).__name__+': '+str(error);raise
    finally:
        await pc.close()
        for task in tasks:task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        outcome['eventTypes']=[e.get('type') for e in events]
        outcome['errorEvents']=[e for e in events if e.get('type') in ['error','error-response']]
        outcome['transcripts']=[e.get('data',{}) for e in events if e.get('type') in ['user-transcription','bot-output']]
        filename='webrtc-noise-'+args.noise+'.json' if args.noise else 'webrtc-button-stop.json' if args.button_stop else 'webrtc-stop.json' if args.stop else 'webrtc-quiet.json'
        (root/filename).write_text(json.dumps(outcome,ensure_ascii=False,indent=2))
        print(json.dumps({k:v for k,v in outcome.items() if k!='events'},ensure_ascii=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--audio',required=True);parser.add_argument('--stop',action='store_true');parser.add_argument('--button-stop',action='store_true');parser.add_argument('--noise',choices=['white','fan','knocks'])
    asyncio.run(run(parser.parse_args()))
