"""Benchmark-only HF adapter: identical existing ONNX weights, no model download.

Uses upstream SenseVoice handler lifecycle and pipeline messages unchanged.
"""
from pathlib import Path
import numpy as np
import sherpa_onnx
from speech_to_speech.STT.sense_voice_handler import SenseVoiceSTTHandler

class SherpaSenseVoice(SenseVoiceSTTHandler):
    def setup(self, model_name, device="cpu", language="zh", gen_kwargs=None):
        root=Path(model_name)
        self.device="cpu"
        self.model=sherpa_onnx.OfflineRecognizer.from_sense_voice(
            tokens=str(root/'tokens.txt'),model=str(root/'model.int8.onnx'),
            language=language,use_itn=True,num_threads=2)
        self.warmup()

    def _generate(self, audio):
        stream=self.model.create_stream()
        stream.accept_waveform(16000,np.asarray(audio,dtype=np.float32))
        self.model.decode_stream(stream)
        return stream.result.text.strip()
