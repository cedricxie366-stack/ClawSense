"""Bounded macOS activity for user-requested local inference; permits idle sleep.

No global power preference or priority is changed. A worker ends the activity
after an idle queue timeout, explicit cooldown, or process exit.
"""
import ctypes
import platform

USER_INITIATED_ALLOWING_IDLE_SLEEP = 0x00FFFFFF & ~(1 << 20)


class ProcessActivity:
    def __init__(self):
        self._token = None
        self._loaded = False
        self._disabled = platform.system() != "Darwin"

    @property
    def active(self):
        return self._token is not None

    def _load(self):
        self._foundation = ctypes.CDLL("/System/Library/Frameworks/Foundation.framework/Foundation")
        self._objc = ctypes.CDLL("/usr/lib/libobjc.A.dylib")
        self._objc.objc_getClass.argtypes = [ctypes.c_char_p]
        self._objc.objc_getClass.restype = ctypes.c_void_p
        self._objc.sel_registerName.argtypes = [ctypes.c_char_p]
        self._objc.sel_registerName.restype = ctypes.c_void_p
        ptr = ctypes.c_void_p
        self._send = ctypes.CFUNCTYPE(ptr, ptr, ptr)(("objc_msgSend", self._objc))
        self._string = ctypes.CFUNCTYPE(ptr, ptr, ptr, ctypes.c_char_p)(("objc_msgSend", self._objc))
        self._begin = ctypes.CFUNCTYPE(ptr, ptr, ptr, ctypes.c_uint64, ptr)(("objc_msgSend", self._objc))
        self._end = ctypes.CFUNCTYPE(None, ptr, ptr, ptr)(("objc_msgSend", self._objc))
        self._void = ctypes.CFUNCTYPE(None, ptr, ptr)(("objc_msgSend", self._objc))
        self._selectors = {name: self._objc.sel_registerName(name.encode()) for name in
                           ("new", "drain", "processInfo", "stringWithUTF8String:", "beginActivityWithOptions:reason:", "endActivity:", "retain", "release")}
        self._info = self._send(self._objc.objc_getClass(b"NSProcessInfo"), self._selectors["processInfo"])
        if not self._info:
            raise RuntimeError("process_activity_unavailable")
        self._loaded = True

    def begin(self):
        if self.active:
            return True
        if self._disabled:
            return False
        pool = None
        try:
            if not self._loaded:
                self._load()
            pool = self._send(self._objc.objc_getClass(b"NSAutoreleasePool"), self._selectors["new"])
            reason = self._string(self._objc.objc_getClass(b"NSString"), self._selectors["stringWithUTF8String:"], b"ClawSense local inference")
            token = self._begin(self._info, self._selectors["beginActivityWithOptions:reason:"], USER_INITIATED_ALLOWING_IDLE_SLEEP, reason)
            if not token:
                return False
            self._token = self._send(token, self._selectors["retain"])
            return self.active
        except (OSError, AttributeError, RuntimeError):
            self._disabled = True
            return False
        finally:
            if pool:
                self._void(pool, self._selectors["drain"])

    def end(self):
        token, self._token = self._token, None
        if token:
            self._end(self._info, self._selectors["endActivity:"], token)
            self._void(token, self._selectors["release"])
