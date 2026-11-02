"""Pipecat media/turn owner. Models and evidence stay behind the ClawSense boundary.

No microphone, speakers, cloud credentials, or global model directories are opened
by this process. WebRTC capture is explicitly started by an authenticated client.
"""
import argparse
import asyncio
import base64
import contextlib
import io
import json
import secrets
import time
import re
import os
import sys
from pathlib import Path

import aiohttp
from fastapi import FastAPI, HTTPException, Request
from loguru import logger
from PIL import Image
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (Frame, ErrorFrame, InterruptionFrame, LLMContextFrame, LLMFullResponseStartFrame,
    LLMFullResponseEndFrame, LLMTextFrame, TranscriptionFrame, UserImageRawFrame, TTSStoppedFrame)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker, PipelineParams
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection
from pipecat.services.llm_service import LLMService
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.services.tts_service import TTSService
from pipecat.services.settings import LLMSettings, STTSettings, TTSSettings
from pipecat.adapters.services.open_ai_adapter import OpenAILLMAdapter
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequestHandler, SmallWebRTCRequest, SmallWebRTCPatchRequest, IceCandidate
from pipecat.utils.time import time_now_iso8601
from pipecat.workers.runner import WorkerRunner

def diagnostic(event, **values):
    if os.environ.get("CLAWSENSE_UPSTREAM_TEST_LOGS") == "1":
        print(json.dumps({"event": event, "at": time.monotonic(), **values}), file=sys.stderr, flush=True)


class ModelBridge:
    def __init__(self, url, token, authorization, http):
        self.url, self.token, self.authorization, self.http = url, token, authorization, http
        self.session_id = None
        self.response_id = ""
        self.latest_frame = None
        self.max_session_ms = 120000
        self.responses = {}
        self.receipts = set()
        self.receipt_errors = []

    @staticmethod
    def canonical(text):
        return re.sub(r'([。！？.!?])\s+', r'\1', text).strip()

    async def flush_receipts(self):
        if self.receipts:
            await asyncio.gather(*list(self.receipts))
        if self.receipt_errors:
            raise RuntimeError("playback_receipt_failed")

    async def commit_heard(self, message):
        if message.interrupted or not message.content:
            return
        match = next((key for key, text in self.responses.items() if self.canonical(text) == self.canonical(message.content)), None)
        if not match:
            self.receipt_errors.append("unmatched_playback_receipt")
            return
        self.responses.pop(match)
        task = asyncio.create_task(self.call("heard", text=message.content, responseId=match, interrupted=False))
        self.receipts.add(task)
        try:
            await task
        except Exception:
            self.receipt_errors.append("playback_receipt_failed")
        finally:
            self.receipts.discard(task)

    def request(self, op, **data):
        return self.http.post(self.url + "/api/clawsense/live-upstream/model",
            headers={"authorization": self.authorization, "x-clawsense-bridge": self.token},
            json={"op": op, "sessionId": self.session_id, **data})

    async def call(self, op, **data):
        async with self.request(op, **data) as response:
            value = await response.json()
            if response.status != 200:
                raise RuntimeError(value.get("error", "upstream_model_unavailable"))
            return value

    async def stream(self, op, **data):
        async with self.request(op, **data) as response:
            if response.status != 200:
                value = await response.json()
                raise RuntimeError(value.get("error", "upstream_model_unavailable"))
            async for line in response.content:
                if not line.strip():
                    continue
                value = json.loads(line)
                if value.get("type") == "error":
                    diagnostic("model-stream-error", operation=op, code=value.get("code"))
                    if value.get("code") in ("aborted", "upstream_stale_speech"):
                        raise asyncio.CancelledError()
                    raise RuntimeError(value.get("code", "upstream_model_unavailable"))
                yield value

    async def open(self, vision=False):
        result = await self.call("open")
        self.session_id = result["sessionId"]
        self.max_session_ms = result["maxSessionMs"]
        try:
            await self.call("prepare", vision=vision)
        except BaseException:
            await self.close()
            raise

    async def close(self):
        if self.session_id:
            with contextlib.suppress(Exception):
                await self.call("close")

    def current_frame(self):
        if not self.latest_frame:
            return None
        jpeg, captured, clock = self.latest_frame
        age = (time.monotonic() - clock) * 1000
        return {"jpeg": jpeg, "capturedAt": captured, "ageMs": age, "timestampBasis": "server-receive"} if age <= 2000 else None


class LocalSTT(SegmentedSTTService):
    def __init__(self, bridge):
        super().__init__(sample_rate=16000, settings=STTSettings(model="existing-sensevoice", language=None))
        self.bridge = bridge

    @property
    def wants_wav_segments(self):
        return False

    async def run_stt(self, audio):
        result = await self.bridge.call("asr", pcm=base64.b64encode(audio).decode())
        if result["text"].strip():
            yield TranscriptionFrame(result["text"], "", time_now_iso8601())


class CurrentFrame(FrameProcessor):
    def __init__(self, bridge, enabled):
        super().__init__()
        self.bridge, self.enabled = bridge, enabled

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, UserImageRawFrame):
            if self.enabled and frame.size[0] * frame.size[1] <= 4096 * 4096:
                # One bounded latest frame, no image history or disk writes.
                with Image.frombytes(frame.format or "RGB", frame.size, frame.image) as image:
                    image.thumbnail((768, 768))
                    output = io.BytesIO()
                    image.convert("RGB").save(output, format="JPEG", quality=80)
                self.bridge.latest_frame = (base64.b64encode(output.getvalue()).decode(), int(time.time()*1000), time.monotonic())
            return
        await self.push_frame(frame, direction)


class LocalLLM(LLMService):
    adapter_class = OpenAILLMAdapter
    def __init__(self, bridge):
        super().__init__(settings=LLMSettings(model="existing-local-model", system_instruction=None,
            temperature=None, max_tokens=None, top_p=None, top_k=None, frequency_penalty=None,
            presence_penalty=None, seed=None, filter_incomplete_user_turns=False,
            user_turn_completion_config=None, use_provider_thinking_default=False))
        self.bridge = bridge

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InterruptionFrame):
            # Stop upstream TTS/output first. A normal model cancellation must
            # not race ahead and be misclassified as a fatal synthesis error.
            diagnostic("upstream-interruption", direction=str(direction), response=self.bridge.response_id)
            await self.push_frame(frame, direction)
            # Pipecat cancels the in-flight HTTP generators and clears playout.
            # A second asynchronous cancel RPC can overtake its flush barrier
            # and affect a subsequent request. HTTP close cancels that exact
            # model operation at the bridge, without another turn controller.
        elif isinstance(frame, LLMContextFrame):
            await self.bridge.flush_receipts()
            messages = frame.context.get_messages()
            user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
            if not user or not isinstance(user.get("content"), str):
                return
            if re.fullmatch(r"\s*(?:停|停止|停一下|停止说话|停止朗读|别说了)[，。！？,.!?\s]*", user["content"]):
                # Explicit control completes silently after Pipecat's barge-in;
                # do not turn a stop command into a fresh spoken LLM answer.
                return
            await self.push_frame(LLMFullResponseStartFrame())
            try:
                async for item in self.bridge.stream("reply", text=user["content"], frame=self.bridge.current_frame()):
                    if item["type"] == "response":
                        self.bridge.response_id = item["responseId"]
                        self.bridge.responses[item["responseId"]] = ""
                        while len(self.bridge.responses) > 24:
                            self.bridge.responses.pop(next(iter(self.bridge.responses)))
                    elif item["type"] == "text":
                        self.bridge.responses[self.bridge.response_id] += item["text"]
                        await self.push_frame(LLMTextFrame(item["text"]))
            finally:
                await self.push_frame(LLMFullResponseEndFrame())
        else:
            await self.push_frame(frame, direction)


class LocalTTS(TTSService):
    def __init__(self, bridge):
        super().__init__(sample_rate=24000, push_start_frame=True, push_stop_frames=True,
            settings=TTSSettings(model="existing-qwen3-tts", voice="configured", language=None))
        self.bridge = bridge

    async def run_tts(self, text, context_id):
        response_id = self.bridge.response_id
        diagnostic("tts-start", context=context_id, response=response_id, characters=len(text))
        audio_bytes = 0
        async def audio():
            nonlocal audio_bytes
            async for item in self.bridge.stream("tts", text=text, responseId=response_id):
                if item["type"] == "audio":
                    if item["sampleRate"] != 24000:
                        raise RuntimeError("unexpected_tts_rate")
                    chunk = base64.b64decode(item["pcm"], validate=True); audio_bytes += len(chunk)
                    yield chunk
        try:
            async for frame in self._stream_audio_frames_from_iterator(audio(), in_sample_rate=24000, context_id=context_id):
                yield frame
        finally:
            diagnostic("tts-end", context=context_id, response=response_id, bytes=audio_bytes)


def make_pipeline(transport, bridge, vision=False):
    context = LLMContext()
    # Pipecat's bundled Smart Turn is the default stop strategy. No parallel
    # ClawSense endpoint detector, text-punctuation timer, or second recorder.
    user, assistant = LLMContextAggregatorPair(context, user_params=LLMUserAggregatorParams(
        vad_analyzer=SileroVADAnalyzer(), empty_user_turn=None))
    pipeline = Pipeline([transport.input(), CurrentFrame(bridge, vision), LocalSTT(bridge), user,
        LocalLLM(bridge), LocalTTS(bridge), transport.output(), assistant])
    @assistant.event_handler("on_assistant_turn_stopped")
    async def heard(_, message):
        # With no word timestamps, an interrupted sentence has no exact acoustic
        # alignment. Do not claim its unplayed text was heard.
        await bridge.commit_heard(message)
        if bridge.receipt_errors:
            await assistant.push_error_frame(ErrorFrame(error="upstream_playback_receipt_failed"))
    return pipeline, context, assistant


def create_app(bridge_url, token):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    handler = SmallWebRTCRequestHandler(ice_servers=[])
    owners, tasks = {}, set()

    async def run(connection, bridge, vision):
        transport = SmallWebRTCTransport(connection, TransportParams(audio_in_enabled=True,
            audio_out_enabled=True, video_in_enabled=vision, video_in_framerate=1))
        pipeline, context, assistant = make_pipeline(transport, bridge, vision)
        worker = PipelineWorker(pipeline, params=PipelineParams(audio_in_sample_rate=16000,
            audio_out_sample_rate=24000), idle_timeout_secs=180)
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)

        @worker.rtvi.event_handler("on_client_message")
        async def control(rtvi, message):
            if message.type == "stop-speaking":
                await rtvi.interrupt_bot()

        @worker.event_handler("on_pipeline_error")
        async def failed(*_):
            # Fail visibly and release capture instead of continuing a broken
            # session; no transcript or credentials are copied into diagnostics.
            await runner.cancel()
            await connection.disconnect()

        @transport.event_handler("on_client_disconnected")
        async def disconnected(*_):
            await runner.cancel()

        async def guard():
            expires = time.monotonic() + bridge.max_session_ms/1000
            try:
                while time.monotonic() < expires:
                    await asyncio.sleep(0.2)
                    await bridge.call("check")
            except Exception:
                pass
            finally:
                await runner.cancel()
                await connection.disconnect()

        guard_task = asyncio.create_task(guard())
        try:
            await runner.run()
        finally:
            guard_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await guard_task
            await bridge.close()
            await bridge.http.close()
            bridge.latest_frame = None
            owners.pop(connection.pc_id, None)

    async def authorize(request):
        if not secrets.compare_digest(request.headers.get("x-clawsense-bridge", ""), token):
            raise HTTPException(401, "unauthorized")
        authorization = request.headers.get("authorization", "")
        device = request.headers.get("x-clawsense-device", "")
        if not authorization.startswith("Bearer ") or not device:
            raise HTTPException(401, "unauthorized")
        return authorization, device

    @app.post("/api/offer")
    async def offer(request: Request):
        authorization, device = await authorize(request)
        data = await request.json()
        pc_id = data.get("pc_id")
        if pc_id and owners.get(pc_id) != (authorization, device):
            raise HTTPException(403, "peer_not_owned")
        if len(owners) >= 2 and not pc_id:
            raise HTTPException(503, "capacity")
        # request_data is a feature request, never a credential or model address.
        vision = (data.get("request_data") or data.get("requestData") or {}).get("vision") is True
        async def connected(connection):
            http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120))
            bridge = ModelBridge(bridge_url, token, authorization, http)
            try:
                await bridge.open(vision)
                if await request.is_disconnected():
                    raise RuntimeError("signaling_client_gone")
            except Exception:
                await bridge.close(); await http.close()
                await connection.disconnect()
                raise HTTPException(503, "model_preparation_failed")
            owners[connection.pc_id] = (authorization, device)
            task = asyncio.create_task(run(connection, bridge, vision))
            tasks.add(task); task.add_done_callback(tasks.discard)
        return await handler.handle_web_request(SmallWebRTCRequest.from_dict(data), connected)

    @app.patch("/api/offer")
    async def patch(request: Request):
        owner = await authorize(request)
        data = await request.json()
        if owners.get(data.get("pc_id")) != owner:
            raise HTTPException(403, "peer_not_owned")
        candidates = [IceCandidate(**c) for c in data.get("candidates", [])[:64]]
        await handler.handle_patch_request(SmallWebRTCPatchRequest(data["pc_id"], candidates))
        return {"ok": True}

    @app.on_event("shutdown")
    async def shutdown():
        for task in list(tasks): task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await handler.close()
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge-url", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--port", type=int, default=19723)
    args = parser.parse_args()
    from urllib.parse import urlparse
    url = urlparse(args.bridge_url)
    if url.scheme != "http" or url.hostname != "127.0.0.1" or url.username or url.password:
        parser.error("bridge must use a trusted loopback HTTP endpoint")
    token_path = Path(args.token_file)
    if token_path.is_symlink() or token_path.stat().st_mode & 0o077:
        parser.error("token file must be private")
    token = token_path.read_text().strip()
    if len(token) < 32: parser.error("invalid token")
    logger.remove()  # Upstream DEBUG logs can contain transcripts and SDP.
    logger.add(sys.stderr if os.environ.get("CLAWSENSE_UPSTREAM_TEST_LOGS") == "1" else lambda message: None, level="ERROR")
    import uvicorn
    uvicorn.run(create_app(args.bridge_url.rstrip("/"), token), host="127.0.0.1", port=args.port, access_log=False)
