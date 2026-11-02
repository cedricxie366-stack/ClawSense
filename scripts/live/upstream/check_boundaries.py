"""Actual-model/evidence boundary checks with synthetic data, no device IO."""
import asyncio, base64, io, json, time, wave
from pathlib import Path
import aiohttp
from PIL import Image, ImageDraw
from runtime import ModelBridge

async def check(root):
    root=Path(root);device=json.loads((root/'fixture-device.json').read_text());token=(root/'bridge-token').read_text().strip()
    connection=json.loads((root/'state/connection.json').read_text());admin=Path(connection['tokenFile']).read_text().strip()
    results=[]
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=150)) as http:
        def new():return ModelBridge('http://127.0.0.1:19721',token,'Bearer '+device['deviceSecret'],http)
        async def policy(location):
            async with http.post(connection['url']+'/api/clawsense/agent/call',headers={'authorization':'Bearer '+admin},json={'name':'clawsense_device_context_policy','arguments':{'deviceId':device['deviceId'],'policy':{'projectIds':['live-upstream'],'audience':'private','processingLocation':location,'allowedRecipients':[]}}}) as response:
                if response.status!=200:raise RuntimeError('test_policy_update_failed')
        async def reply(bridge,text,frame=None):
            response_id='';answer=''
            async for item in bridge.stream('reply',text=text,frame=frame):
                if item['type']=='response':response_id=item['responseId']
                if item['type']=='text':answer+=item['text']
            return response_id,answer
        bridge=new()
        try:
            await bridge.open()
            rid,answer=await reply(bridge,'请原样朗读：停。')
            pcm=bytearray()
            async for part in bridge.stream('tts',text=answer,responseId=rid):
                if part['type']=='audio':pcm.extend(base64.b64decode(part['pcm']))
            with wave.open(str(root/'stop-fixture.wav'),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(24000);f.writeframes(bytes(pcm))
            await reply(bridge,'客户小叶的预算更正为六万元。请简短确认。')
            await bridge.close();bridge=new();await bridge.open()
            _,answer=await reply(bridge,'小叶的预算是多少？')
            assert '六万' in answer or '6万' in answer,answer
            results.append({'case':'restart_session_reuses_authorized_memory','passed':True,'answer':answer})
            for color,expected in [('red','红'),('blue','蓝')]:
                image=Image.new('RGB',(512,512),'white');ImageDraw.Draw(image).rectangle((120,120,392,392),fill=color)
                output=io.BytesIO();image.save(output,format='JPEG')
                frame={'jpeg':base64.b64encode(output.getvalue()).decode(),'capturedAt':int(time.time()*1000),'ageMs':0,'timestampBasis':'server-receive'}
                _,answer=await reply(bridge,'当前画面中央是什么颜色的形状？',frame)
                assert expected in answer,answer
                results.append({'case':'new_'+color+'_image','passed':True,'answer':answer,'physicalCamera':False})
            frame['ageMs']=3000
            try:await reply(bridge,'当前画面里有什么？',frame)
            except RuntimeError as error:assert 'current_frame_unavailable' in str(error)
            else:raise AssertionError('stale_image_was_accepted')
            results.append({'case':'stale_image_rejected','passed':True})
            await policy('local-only')
            try:await bridge.call('check')
            except RuntimeError:pass
            else:raise AssertionError('revoked_owned_processing_still_allowed')
            await bridge.close()
            results.append({'case':'processing_revocation_and_teardown','passed':True})
        finally:
            await policy('owned-devices')
            await bridge.close()
            (root/'boundaries-real.json').write_text(json.dumps({'completed':len(results)==5,'physicalSensors':False,'rows':results},ensure_ascii=False,indent=2))
            print(json.dumps(results,ensure_ascii=False),flush=True)

if __name__=='__main__':
    import sys
    asyncio.run(check(sys.argv[1]))
