# -*- coding: utf-8 -*-


import os, io, sys, ssl, json, time, wave, atexit, asyncio, threading, traceback, subprocess, random, queue
from typing import Optional, Callable, Dict, Any

# ---------- tiny .env loader (no dependencies) ----------
def load_env_file(path: str = ".env", overwrite: bool = True):
    import shlex
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith(";"):
                continue
            if line.lower().startswith("export "):
                line = line[7:].lstrip()
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip()
            if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                try:
                    v = shlex.split(v)[0]
                except Exception:
                    v = v[1:-1]
            if overwrite or k not in os.environ:
                os.environ[k] = v
load_env_file(".env", overwrite=True)

# --- UTF-8 console ---
for s in (sys.stdin, sys.stdout, sys.stderr):
    try: s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

import numpy as np
import pyaudio
import requests
import websockets

# ---------- helpers ----------
def envs(k, d=""):  return os.environ.get(k, d)
def envb(k, d=False):
    v = os.environ.get(k, str(int(d))).strip().lower()
    return v in ("1","true","yes","y","on")
def envi(k, d): 
    try: return int(float(os.environ.get(k, str(d))))
    except: return d
def envf(k, d):
    try: return float(os.environ.get(k, str(d)))
    except: return d

# ---------- constants ----------
RATE = 16000            # internal processing rate
CH   = 1
WIDTH= 2
FRAME_OUT = 512         # 32ms @16k
VAD_WIN   = 320         # 20ms window for WebRTC VAD
MIN_BYTES = lambda ms: int(ms*RATE/1000)*WIDTH

# ---------- beeps ----------
def _beep(f, ms):
    if not envb("PLAY_SOUNDS", True): return
    try:
        import winsound; winsound.Beep(int(f), int(ms))
    except Exception:
        pass
def beep_boot():      _beep(1000,120)
def beep_start():     _beep(880,120); _beep(1320,120)
def beep_stop():      _beep(660,160)
def beep_error():     _beep(300,250)

# ---------- optional libs ----------
PP_ENABLED = False
VAD_ENABLED = False
pp = vad = None

# Porcupine (optional)
try:
    import pvporcupine
    if envs("PICOVOICE_ACCESS_KEY") and envs("PORCUPINE_PPN") and not envb("HOTWORD_DISABLED", True):
        PP_ENABLED = True
except Exception:
    PP_ENABLED = False

# WebRTC VAD (optional)
try:
    import webrtcvad
    if envb("VAD_ENABLED", True):
        vad = webrtcvad.Vad()
        vad.set_mode(envi("VAD_MODE", 1))
        VAD_ENABLED = True
except Exception:
    VAD_ENABLED = False

# ---------- device list ----------
def list_inputs(pa):
    print("=== INPUT DEVICES ===")
    for i in range(pa.get_device_count()):
        info = pa.get_device_info_by_index(i)
        if int(info.get("maxInputChannels",0))>0:
            print(f"{i}: {info.get('name')} | in={info.get('maxInputChannels')} rate={int(info.get('defaultSampleRate',0))}")

# ---------- whisper ----------
def start_whisper() -> Optional[subprocess.Popen]:
    exe  = envs("JEMIMI_WHISPER_EXE")
    model= envs("JEMIMI_MODEL_MAIN")
    port = envi("JEMIMI_MAIN_PORT", 8080)
    dev  = envs("JEMIMI_DEVICE_FLAG","")
    if not exe or not os.path.exists(exe):
        print("[whisper] exe missing -> skip auto-launch"); return None
    if not model or not os.path.exists(model):
        print("[whisper] model missing (will likely fail)")
    args=[exe,"-m",model,"-t","8","-bs","3","-bo","3","-l","ja","--port",str(port),
          "--no-context","--suppress-nst","--no-fallback"]
    if dev: args += dev.split()
    print("[launch]"," ".join(a.replace("\\","\\\\") for a in args))
    try:
        p=subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        return p
    except Exception as e:
        print(f"[whisper] launch failed: {e}"); return None

def wait_whisper(timeout=8.0):
    port=envi("JEMIMI_MAIN_PORT",8080); url=f"http://127.0.0.1:{port}/health"
    t0=time.time()
    while time.time()-t0<timeout:
        try:
            r=requests.get(url,timeout=1.0)
            if r.status_code in (200,404,405): return True
        except: time.sleep(0.3)
    return False

# ---------- JSON-RPC over WebSocket ----------
class GeminiRPC:
    """
    JSON-RPC 2.0 client with:
      - sendUserMessage / fetchHistory / clearHistory
      - handle notifications: addMessage, streamAssistantMessageChunk, tool calls, historyCleared
      - auto reconnect with backoff
    """
    def __init__(self, url: str, verify_tls: bool = False):
        self.url = url
        self.verify_tls = verify_tls
        self.loop = asyncio.new_event_loop()
        self.ws = None
        self._id = 0
        self._pending: Dict[int, asyncio.Future] = {}
        self._recv_task = None
        self._stop = False
        self._lock = threading.Lock()

        # callbacks
        self.on_add_message: Optional[Callable[[dict], None]] = None
        self.on_stream_chunk: Optional[Callable[[dict], None]] = None
        self.on_history_cleared: Optional[Callable[[dict], None]] = None
        self.on_tool_event: Optional[Callable[[str, dict], None]] = None

        th = threading.Thread(target=self._run_loop, daemon=True)
        th.start()

    # ---- threading/loop ----
    def _run_loop(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self._connect_forever())

    def close(self):
        self._stop = True
        try:
            if self.ws:
                self.loop.run_until_complete(self.ws.close())
        except Exception:
            pass
        try:
            self.loop.call_soon_threadsafe(self.loop.stop)
        except Exception:
            pass

    # ---- connect with auto-retry ----
    async def _connect_forever(self):
        backoff = 1.0
        while not self._stop:
            try:
                ssl_ctx=None
                if self.url.startswith("wss://"):
                    if self.verify_tls:
                        ssl_ctx=ssl.create_default_context()
                    else:
                        ssl_ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
                        ssl_ctx.check_hostname=False; ssl_ctx.verify_mode=ssl.CERT_NONE
                print(f"[ws] connecting: {self.url}")
                self.ws = await websockets.connect(self.url, ssl=ssl_ctx, max_size=8*1024*1024, ping_interval=20)
                print("[ws] connected")
                backoff = 1.0
                self._recv_task = asyncio.create_task(self._recv_loop())
                await self._recv_task
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[ws] error: {e}")
            finally:
                if self.ws:
                    try: await self.ws.close()
                    except: pass
                self.ws = None
                if self._stop: break
                print(f"[ws] reconnect in {backoff:.1f}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff*2, 20.0)

    # ---- receive loop ----
    async def _recv_loop(self):
        try:
            async for raw in self.ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    print("[ws] non-json:", raw[:200]); continue
                self._dispatch(msg)
        except Exception as e:
            print(f"[ws] recv err: {e}")

    # ---- dispatch ----
    def _dispatch(self, msg: Dict[str, Any]):
        if "method" in msg and "id" not in msg:
            # Notification from server
            m = msg.get("method")
            p = msg.get("params", {})
            if m == "addMessage":
                if self.on_add_message: self.on_add_message(p)
                else: print(f"[addMessage] {p.get('message',{})}")
            elif m == "streamAssistantMessageChunk":
                if self.on_stream_chunk: self.on_stream_chunk(p)
                else: print(f"[chunk] {p.get('chunk',{})}")
            elif m in ("pushToolCall", "updateToolCall", "requestToolCallConfirmation"):
                if self.on_tool_event: self.on_tool_event(m, p)
                else: print(f"[tool:{m}] {p}")
            elif m == "historyCleared":
                if self.on_history_cleared: self.on_history_cleared(p)
                else: print(f"[historyCleared] {p}")
            else:
                print(f"[ws] unknown notif: {m} {p}")
            return

        # Response
        if "id" in msg:
            rid = msg["id"]
            fut = self._pending.pop(rid, None)
            if fut and not fut.done():
                if "result" in msg:
                    fut.set_result(msg["result"])
                elif "error" in msg:
                    fut.set_exception(RuntimeError(msg["error"]))
                else:
                    fut.set_result(None)

    # ---- send helpers ----
    def _next_id(self) -> int:
        with self._lock:
            self._id += 1
            return self._id

    def _send(self, payload: Dict[str, Any]) -> asyncio.Future:
        fut = self.loop.create_future()
        rid = payload.get("id")
        if rid is not None:
            self._pending[rid] = fut
        async def _do():
            try:
                if not self.ws:
                    raise RuntimeError("ws not connected")
                await self.ws.send(json.dumps(payload))
            except Exception as e:
                if rid is not None and rid in self._pending:
                    self._pending.pop(rid, None)
                if not fut.done():
                    fut.set_exception(e)
        asyncio.run_coroutine_threadsafe(_do(), self.loop)
        return fut

    # ---- public JSON-RPC methods ----
    def send_user_message(self, text: str, files: Optional[list] = None,
                          goal: Optional[dict] = None, session: Optional[dict] = None) -> asyncio.Future:
        rid = self._next_id()
        mid = f"user-msg-{int(time.time()*1000)}-{random.randint(1000,9999)}"
        chunk = {
            "text": text,
            "messageId": mid,
            "files": files if files is None else [],
            "goal": goal,
            "session": session
        }
        payload = {"jsonrpc":"2.0", "id": rid, "method":"sendUserMessage",
                   "params":{"chunks":[chunk]}}
        print(f"[rpc] sendUserMessage id={rid} mid={mid} len={len(text)}")
        return self._send(payload)

    def fetch_history(self, limit: int = 30, before_ts: Optional[int] = None) -> asyncio.Future:
        rid = self._next_id()
        params = {"limit": int(limit)}
        if before_ts is not None: params["before"] = int(before_ts)
        payload = {"jsonrpc":"2.0", "id": rid, "method":"fetchHistory", "params": params}
        print(f"[rpc] fetchHistory id={rid} params={params}")
        return self._send(payload)

    def clear_history(self) -> asyncio.Future:
        rid = self._next_id()
        payload = {"jsonrpc":"2.0", "id": rid, "method":"clearHistory", "params": {}}
        print(f"[rpc] clearHistory id={rid}")
        return self._send(payload)

# ---------- resampler ----------
def resample_linear(int16_buf: bytes, in_rate: int, out_samples: int) -> bytes:
    if in_rate == RATE:
        arr = np.frombuffer(int16_buf, dtype=np.int16)
        if arr.size == out_samples:
            return int16_buf
        x = np.linspace(0, 1, num=arr.size, endpoint=False, dtype=np.float32)
        xi = np.linspace(0, 1, num=out_samples, endpoint=False, dtype=np.float32)
        yi = np.interp(xi, x, arr.astype(np.float32))
        return np.clip(yi, -32768, 32767).astype(np.int16).tobytes()
    arr = np.frombuffer(int16_buf, dtype=np.int16).astype(np.float32)
    if arr.size == 0:
        return np.zeros(out_samples, dtype=np.int16).tobytes()
    x = np.linspace(0, 1, num=arr.size, endpoint=False, dtype=np.float32)
    xi = np.linspace(0, 1, num=out_samples, endpoint=False, dtype=np.float32)
    yi = np.interp(xi, x, arr)
    return np.clip(yi, -32768, 32767).astype(np.int16).tobytes()

# ---------- trim & normalize ----------
def trim_and_normalize(raw_pcm: bytes, thr_rms: float = 12.0, win: int = 160, hop: int = 80, peak_target: float = 0.8) -> bytes:
    x = np.frombuffer(raw_pcm, dtype=np.int16).astype(np.float32)
    if x.size == 0:
        return raw_pcm
    def frame_rms(sig):
        n = (len(sig) - win) // hop + 1
        if n <= 0: return np.array([np.sqrt(np.mean(sig**2))], dtype=np.float32)
        rms = np.empty(n, dtype=np.float32)
        for i in range(n):
            s = i * hop
            fr = sig[s:s+win]
            rms[i] = np.sqrt(np.mean(fr**2)) if fr.size else 0.0
        return rms
    rms = frame_rms(x)
    idx = np.where(rms >= thr_rms)[0]
    if idx.size > 0:
        first = int(max(0, idx[0]*hop - hop))
        last  = int(min(x.size, idx[-1]*hop + win))
        x = x[first:last]
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak > 0:
        g = (peak_target*32767.0) / peak
        x = np.clip(x * g, -32768, 32767)
    return x.astype(np.int16).tobytes()

# ---------- ASR Worker (non-blocking) ----------
class AsrWorker:
    """
    Whisper HTTP /inference を別スレッドで処理してメインループをブロックさせない。
    - タイムアウト時リトライ
    - 連続タイムアウト閾値で whisper を再起動（callback）
    """
    def __init__(self, on_result: Callable[[str],None], on_error: Callable[[str],None], restart_whisper_cb: Optional[Callable[[],None]] = None):
        self.on_result = on_result
        self.on_error  = on_error
        self.restart_cb= restart_whisper_cb
        self.qmax = int(os.environ.get("ASR_QUEUE_MAX", "2"))
        self.timeout = float(os.environ.get("ASR_TIMEOUT_SEC", "12"))
        self.retry = int(os.environ.get("ASR_RETRY", "1"))
        self.q = queue.Queue(maxsize=self.qmax)
        self._stop = False
        self._consec_to = 0
        self._thr = threading.Thread(target=self._loop, daemon=True)
        self._thr.start()

    def submit(self, raw_pcm: bytes):
        if self.q.full():
            try: self.q.get_nowait()
            except: pass
        try:
            self.q.put_nowait(raw_pcm)
            print("[asr] queued")
        except queue.Full:
            print("[asr] queue full -> dropped")

    def stop(self):
        self._stop = True
        try: self.q.put_nowait(None)
        except: pass

    def _loop(self):
        while not self._stop:
            raw = self.q.get()
            if raw is None: break
            ok = False
            last_err = None
            for attempt in range(1, self.retry+2):
                try:
                    txt = self._post_inference(raw, timeout=self.timeout)
                    ok = True
                    self._consec_to = 0
                    if self.on_result: self.on_result(txt)
                    break
                except requests.Timeout:
                    last_err = f"timeout({self.timeout}s) attempt={attempt}"
                    self._consec_to += 1
                except Exception as e:
                    last_err = f"{type(e).__name__}: {e}"
                    self._consec_to = 0
                    break
            if not ok and self.on_error:
                self.on_error(last_err or "unknown error")

            limit = int(os.environ.get("WHISPER_TIMEOUTS_BEFORE_RESTART","2"))
            if self._consec_to >= limit and self.restart_cb:
                print("[asr] too many timeouts -> restarting whisper...")
                try:
                    self.restart_cb()
                    self._consec_to = 0
                except Exception as e:
                    print(f"[asr] restart failed: {e}")

    def _post_inference(self, raw_pcm: bytes, timeout: float) -> str:
        buf=io.BytesIO()
        with wave.open(buf,"wb") as wf:
            wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(16000)
            wf.writeframes(raw_pcm)
        port=int(os.environ.get("JEMIMI_MAIN_PORT","8080"))
        url=f"http://127.0.0.1:{port}/inference"
        r=requests.post(url,
                        files={'file':('utt.wav', io.BytesIO(buf.getvalue()), 'audio/wav')},
                        data={'language':'ja','response_format':'json'},
                        timeout=timeout)
        r.raise_for_status()
        return (r.json().get("text") or "").strip()

# ---------- assistant ----------
class Assistant:
    def __init__(self, rpc: Optional[GeminiRPC]):
        self.pa=pyaudio.PyAudio()
        list_inputs(self.pa)

        self.device_index = None
        self.device_rate  = None
        self.frame_in     = None
        self.needs_resample = False
        self.stream = None

        # knobs（.envで上書き）
        self.force_sec=envf("FORCE_RECORD_AFTER_HOTWORD", 5.0)
        self.silence_sec=envf("SILENCE_THRESHOLD", 1.4)
        self.min_ms=envi("MIN_UTTER_MS", 350)
        self.max_utter_sec=envf("MAX_UTTER_SEC", 0.0)          # 0=無制限
        self.discard_silent_first=envf("DISCARD_SILENT_FIRST_SEC", 3.0)
        self.trim_rms=envf("TRIM_RMS", 12.0)
        self.debug=envb("DEBUG_AUDIO", False)
        self._dbg_t=0.0
        self._zero_cnt=0
        self._debounce_ms = int(os.environ.get("DEBOUNCE_AFTER_DROP_MS","200"))

        # --- end-of-utterance tuning (env configurable) ---
        self.end_silence_sec = envf("END_SILENCE_SEC", envf("SILENCE_THRESHOLD", 1.4))
        self.hangover_ms     = envi("HANGOVER_MS", 250)
        self.start_rms_mult  = envf("START_RMS_MULT", 6.0)
        self.stop_rms_mult   = envf("STOP_RMS_MULT", 3.2)
        self.force_grace_sec = envf("FORCE_GRACE_SEC", 0.8)

        # runtime states for EOU
        self._hangover_until = None
        self._last_speech_ts = None
        self._force_extended = False



        # engines (optional)
        self.pp=None
        self.vad=None
        self._vad_buf=bytearray()

        # buffers & states
        self.pre=[]; self.audio=[]
        self.collecting=False
        self.maybe_end=None
        self.force_until=None
        self.speech_seen=False
        self.rec_start_ts=None

        self.rpc = rpc              # JSON-RPC client (None可)
        self.asr_worker = None      # AsrWorker を main で注入

        self._open_mic_robust()
        self._init_engines()

    # ----- mic open with fallback & resample -----
    def _try_open(self, idx, rate):
        kw=dict(format=pyaudio.paInt16, channels=1, rate=rate, input=True,
                frames_per_buffer=int(rate*0.032))  # 32ms frame at given rate
        if idx is not None:
            kw["input_device_index"]=int(idx)
        return self.pa.open(**kw)

    def _open_mic_robust(self):
        print(">>> opening mic...")
        idx_env = envs("INPUT_DEVICE_INDEX")
        tried = []

        if idx_env is not None and idx_env != "":
            try:
                st = self._try_open(idx_env, RATE)
                self.stream = st; self.device_index = int(idx_env); self.device_rate = RATE
                self.frame_in = int(self.device_rate*0.032); self.needs_resample = False
                print(f"[mic] opened index={self.device_index} @ {self.device_rate}Hz")
                return
            except Exception as e:
                tried.append((idx_env, RATE, str(e)))

        for i in range(self.pa.get_device_count()):
            info = self.pa.get_device_info_by_index(i)
            if int(info.get("maxInputChannels",0))<=0: continue
            try:
                st = self._try_open(i, RATE)
                self.stream = st; self.device_index = i; self.device_rate = RATE
                self.frame_in = int(self.device_rate*0.032); self.needs_resample = False
                print(f"[mic] opened index={i} @ 16000Hz")
                return
            except Exception as e:
                tried.append((i, RATE, str(e)))

        for i in range(self.pa.get_device_count()):
            info = self.pa.get_device_info_by_index(i)
            if int(info.get("maxInputChannels",0))<=0: continue
            r_def = int(float(info.get("defaultSampleRate", RATE)))
            try:
                st = self._try_open(i, r_def)
                self.stream = st; self.device_index = i; self.device_rate = r_def
                self.frame_in = int(self.device_rate*0.032)
                self.needs_resample = (self.device_rate != RATE)
                print(f"[mic] opened index={i} @ {r_def}Hz (resample -> 16000Hz)")
                return
            except Exception as e:
                tried.append((i, r_def, str(e)))

        print("[fatal] could not open any input device")
        for (i,r,err) in tried[:6]:
            print(f"  - tried idx={i} rate={r}: {err}")
        raise OSError("No microphone available")

    # ----- engines -----
    def _init_engines(self):
        if PP_ENABLED:
            try:
                ak=envs("PICOVOICE_ACCESS_KEY"); kwp=envs("PORCUPINE_PPN")
                kwargs=dict(access_key=ak, keyword_paths=[kwp], sensitivities=[envf("PORCUPINE_SENS",0.6)])
                mp=envs("PORCUPINE_MODEL",""); 
                if mp: kwargs["model_path"]=mp
                global pp; pp=pvporcupine.create(**kwargs); self.pp=pp
                print("[pp] enabled")
            except Exception as e:
                print(f"[pp] disabled: {e}"); self.pp=None

        if VAD_ENABLED:
            global vad; self.vad = vad
            print("[vad] enabled (mode=", envi("VAD_MODE",1), ")")

    # ----- reading & conversions -----
    def _read_raw(self) -> bytes:
        return self.stream.read(self.frame_in, exception_on_overflow=False)

    def _read_16k_512(self) -> bytes:
        raw = self._read_raw()
        if self.needs_resample:
            return resample_linear(raw, self.device_rate, FRAME_OUT)
        arr = np.frombuffer(raw, dtype=np.int16)
        if arr.size == FRAME_OUT:
            return raw
        return resample_linear(raw, RATE, FRAME_OUT)

    # ----- detectors -----
    def _pp_hit(self, frame_512):
        if not self.pp: return False
        pcm = np.frombuffer(frame_512, dtype=np.int16)
        try: return self.pp.process(pcm)>=0
        except Exception as e:
            print(f"[pp] error: {e}"); return False

    def _vad_20ms(self, frame_512):
        if self.vad is None: return False
        self._vad_buf += frame_512
        need = VAD_WIN*WIDTH
        if len(self._vad_buf) < need:
            return False
        win = self._vad_buf[-need:]
        try: return self.vad.is_speech(win, RATE)
        except Exception: return False

    def _rms(self, frame_512):
        arr=np.frombuffer(frame_512, dtype=np.int16).astype(np.float32)
        if not arr.size: return 0.0, 0.0
        rms=float(np.sqrt(np.mean(arr**2))); peak=float(np.max(np.abs(arr)))
        return rms, peak

    # ----- debug/guards -----
    def _dbg(self, frame_512):
        if not self.debug: return
        now=time.time()
        if now-self._dbg_t<0.1: return
        self._dbg_t=now
        rms,peak=self._rms(frame_512)
        print(f"[dbg] rms={rms:.1f} peak={peak:.0f} collecting={self.collecting} force={self.force_until is not None}")

    def _zero_guard(self, frame_512):
        if not self.collecting:  # idle中は警告しない
            self._zero_cnt = 0
            return
        arr=np.frombuffer(frame_512, dtype=np.int16)
        if arr.size and np.max(np.abs(arr))<4:
            self._zero_cnt = getattr(self, "_zero_cnt", 0) + 1
        else:
            self._zero_cnt = 0
        if self._zero_cnt >= 16:  # ≈0.5s
            print("[warn] zero/silent >0.5s; mic level/device/privacy?")
            self._zero_cnt = 0

    # ----- flow helpers -----
    def _start(self):
        self.collecting=True; self.audio=list(self.pre); self.pre.clear()
        self.maybe_end=None
        self.force_until=time.time()+self.force_sec if self.force_sec>0 else None
        self.rec_start_ts = time.time()
        self.speech_seen = False
        beep_start(); print(">>> recording...")
        self._force_extended = False
        self._hangover_until = None
        self._last_speech_ts = None


    def _drop_recording(self, reason: str = "silent-first-window"):
        self.collecting=False; self.maybe_end=None; self.audio.clear(); self.force_until=None
        self.speech_seen=False; self.rec_start_ts=None
        beep_stop()
        print(f"[info] dropped ({reason})")
        # 小休止（暴発抑制）
        if self._debounce_ms > 0:
            time.sleep(self._debounce_ms / 1000.0)

    def _cut_and_send(self):
        raw=b"".join(self.audio)
        self.collecting=False; self.maybe_end=None; self.audio.clear(); self.force_until=None
        beep_stop()
        if len(raw)<MIN_BYTES(self.min_ms):
            print("[info] too short; dropped"); return
        # trim + normalize
        raw = trim_and_normalize(raw, thr_rms=self.trim_rms)
        if self.asr_worker:
            self.asr_worker.submit(raw)
        else:
            print("[asr] no worker -> dropped")

    # ----- main loop -----
    def loop(self):
        print(">>> Mic ready. Press ENTER to start (or say hotword if enabled)")
        beep_boot()

        # small prebuffer
        self.pre.clear()
        for _ in range(12):
            fr=self._read_16k_512(); self.pre.append(fr)

        # keyboard (Windows)
        try: import msvcrt
        except Exception: msvcrt=None

        # calibration
        base=0.0; ncal=20
        for _ in range(ncal):
            fr=self._read_16k_512(); 
            if len(self.pre) < 12: self.pre.append(fr)
            rms,_=self._rms(fr); base += rms
        base = base/max(1,ncal)
        rms_talk = max(60.0, base * self.start_rms_mult)   # 開始しきい値
        rms_stop = max(20.0, base * self.stop_rms_mult)    # 終了しきい値（小さめでヒステリシス）
        print(f"[calib] base_rms={base:.1f} talk_rms~{rms_talk:.1f} stop_rms~{rms_stop:.1f}")


        # auto start
        if os.environ.get("AUTO_START","0") in ("1","true","True"):
            print(">>> auto start (no key/hotword)")
            self._start()

        while True:
            fr=self._read_16k_512()
            if len(self.pre) < 12: self.pre.append(fr)  # keep small prebuffer
            self._dbg(fr); self._zero_guard(fr)

            # keyboard start (when hotword disabled or unavailable)
            hw_disabled = envb("HOTWORD_DISABLED", True) or (not PP_ENABLED)
            if msvcrt and hw_disabled and not self.collecting and msvcrt.kbhit():
                ch=msvcrt.getwch()
                if ch in ("\r","\n"):
                    print(">>> key start"); self._start(); continue

            # hotword
            if (not hw_disabled) and not self.collecting:
                try:
                    import pvporcupine
                    pcm = np.frombuffer(fr, dtype=np.int16)
                    if 'pp' in globals() and globals()['pp'] is not None:
                        if globals()['pp'].process(pcm) >= 0:
                            print(">>> hotword detected"); self._start(); continue
                except Exception as e:
                    print(f"[pp] error: {e}")

            # collect
            if self.collecting:
                self.audio.append(fr)

                # --- 発話検出（VAD優先、なければRMS） ---
                rms, _ = self._rms(fr)
                is_speech_frame = (self._vad_20ms(fr) if (VAD_ENABLED and self.vad) else (rms >= rms_talk))

                if is_speech_frame:
                    self.speech_seen = True
                    self._last_speech_ts = time.time()
                    self._hangover_until = None  # しゃべったので余韻タイマはリセット

                # --- 先頭無音（既定3s）ならASRせず破棄 ---
                if (not self.speech_seen) and ((time.time() - (self.rec_start_ts or time.time())) >= self.discard_silent_first):
                    self._drop_recording("silent-first-window")
                    continue

                # --- 最大長（0 なら無制限） ---
                if self.max_utter_sec and self.max_utter_sec > 0:
                    if (time.time() - (self.rec_start_ts or time.time())) >= self.max_utter_sec:
                        print("[info] max utter len reached; cutting")
                        self._cut_and_send(); continue

                # --- 強制録音ウィンドウ（無音無視） + 満了直前の猶予 ---
                if self.force_until is not None:
                    now = time.time()
                    if now >= self.force_until:
                        # 直近0.5s以内に発話があれば一回だけ猶予を延長
                        if (not self._force_extended) and self._last_speech_ts and (now - self._last_speech_ts) <= 0.5:
                            self.force_until = now + max(0.0, self.force_grace_sec)
                            self._force_extended = True
                        else:
                            self._cut_and_send(); continue
                    else:
                        # 猶予期間中は無音判定しない
                        continue

                # --- 通常の終端検出（ヒステリシス + ハングオーバー） ---
                if is_speech_frame:
                    self.maybe_end = None
                else:
                    # 「終了しきい値」を下回ったフレームだけを“無音”カウント
                    if rms < rms_stop:
                        if self.maybe_end is None:
                            self.maybe_end = time.time()
                        elif (time.time() - self.maybe_end) >= self.end_silence_sec:
                            # 終端と判定 → “余韻(ハングオーバー)”をさらに待つ
                            if self._hangover_until is None:
                                self._hangover_until = time.time() + (self.hangover_ms / 1000.0)
                            elif time.time() >= self._hangover_until:
                                self._cut_and_send()
                    else:
                        # 少し持ち上がれば無音カウントをリセット（ブレス・相槌での尻切れ防止）
                        self.maybe_end = None

# ---------- main ----------
def main():
    # Whisper
    proc = start_whisper()
    atexit.register(lambda: (proc.terminate() if proc and proc.poll() is None else None))
    if not wait_whisper(): print("[warn] whisper not ready (continuing)")

    # JSON-RPC WebSocket
    rpc=None
    ws_url = envs("GEMINI_WS_URL")
    if ws_url:
        rpc = GeminiRPC(ws_url, verify_tls=envb("GEMINI_VERIFY_TLS", False))

        # Optional: callbacks for logs
        def on_add(p):
            m=p.get("message",{})
            print(f"[addMessage] {m.get('role')} | {m.get('id')} | {m.get('text')[:120] if m.get('text') else ''}")
        def on_chunk(p):
            chk=p.get("chunk",{})
            t=chk.get("text") or ""
            th=chk.get("thought") or ""
            if t:  print(f"[chunk:text] {t}")
            if th: print(f"[chunk:thought] {th}")
        def on_hist(p):
            print(f"[historyCleared] reason={p.get('reason')}")
        def on_tool(ev, p):
            print(f"[tool:{ev}] {p}")
        rpc.on_add_message = on_add
        rpc.on_stream_chunk = on_chunk
        rpc.on_history_cleared = on_hist
        rpc.on_tool_event = on_tool

        atexit.register(lambda: rpc.close())

    # --- ASR worker callbacks ---
    def on_asr_result(text: str):
        print(f"[asr] {text}")
        try:
            if rpc and text.strip():
                fut = rpc.send_user_message(text)
                def _done_cb(f):
                    try: _ = f.result(); print("[rpc] stream complete (result=null)")
                    except Exception as e: print(f"[rpc] error (sendUserMessage): {e}")
                fut.add_done_callback(_done_cb)
        except Exception as e:
            print(f"[rpc] send err: {e}")

    def on_asr_error(msg: str):
        print(f"[asr] error: {msg}")

    def restart_whisper():
        nonlocal proc
        try:
            if proc and proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=3)
                except: proc.kill()
        except: pass
        proc = start_whisper()
        if not wait_whisper(timeout=8.0):
            print("[whisper] restart but healthcheck failed")

    asr = AsrWorker(on_result=on_asr_result, on_error=on_asr_error, restart_whisper_cb=restart_whisper)
    atexit.register(lambda: asr.stop())

    # Assistant
    try:
        assistant = Assistant(rpc)
        assistant.asr_worker = asr
        assistant.loop()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        beep_error()
        print(f"[fatal] {type(e).__name__}: {e}")
        traceback.print_exc()

if __name__=="__main__":
    main()
