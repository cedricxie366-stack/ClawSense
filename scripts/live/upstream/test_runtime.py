import sys
from pathlib import Path
from types import SimpleNamespace
import pytest
from fastapi.testclient import TestClient
sys.path.insert(0,str(Path(__file__).parent))
from runtime import ModelBridge, create_app

def test_signaling_requires_bridge_secret_and_peer_ownership():
    with TestClient(create_app('http://127.0.0.1:1','s'*48)) as client:
        assert client.post('/api/offer',json={'sdp':'not-sdp','type':'offer'}).status_code==401
        headers={'x-clawsense-bridge':'s'*48,'x-clawsense-device':'fixture','authorization':'Bearer fixture'}
        assert client.patch('/api/offer',headers=headers,json={'pc_id':'someone-else','candidates':[]}).status_code==403
        assert client.post('/api/offer',headers=headers,json={'pc_id':'someone-else','sdp':'not-sdp','type':'offer'}).status_code==403

def test_frame_expiry_drops_an_old_picture():
    import time
    bridge=ModelBridge('unused','unused','unused',None)
    bridge.latest_frame=('synthetic-image',100,time.monotonic()-3)
    assert bridge.current_frame() is None
    bridge.latest_frame=('synthetic-image',100,time.monotonic())
    assert bridge.current_frame()['jpeg']=='synthetic-image'

@pytest.mark.asyncio
async def test_heard_receipt_uses_original_response_after_a_new_turn_and_ignores_interrupted_text():
    bridge=ModelBridge('unused','unused','unused',None);calls=[]
    async def call(op,**data):calls.append((op,data));return {'ok':True}
    bridge.call=call
    bridge.responses={'old':'第一句。第二句。','new':'新的回答。'};bridge.response_id='new'
    await bridge.commit_heard(SimpleNamespace(content='第一句。 第二句。',interrupted=False))
    assert calls[0][1]['responseId']=='old'
    await bridge.commit_heard(SimpleNamespace(content='新的',interrupted=True))
    assert len(calls)==1
    assert not bridge.receipt_errors

@pytest.mark.asyncio
async def test_missing_receipt_surfaces_failure_instead_of_claiming_completion():
    bridge=ModelBridge('unused','unused','unused',None)
    await bridge.commit_heard(SimpleNamespace(content='从未生成',interrupted=False))
    with pytest.raises(RuntimeError,match='playback_receipt_failed'):await bridge.flush_receipts()
