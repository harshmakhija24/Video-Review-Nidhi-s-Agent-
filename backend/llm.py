"""Every Groq call goes through here: retries, model fallback chains, and a local Whisper fallback.

Design goal: never raise for a transient problem. Callers get either a result or LLMUnavailable
(meaning every model in the chain is exhausted) and must degrade gracefully.
"""
import os
import re
import json
import time
import random
import threading

from dotenv import load_dotenv
from groq import Groq, APIStatusError, APIConnectionError, APITimeoutError

load_dotenv()

TEXT_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]
VISION_MODELS = ["qwen/qwen3.8-27b"]  # only vision model on the key (verified); max 3 images/request
WHISPER_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"]
MAX_IMAGES = 3
MAX_WAIT = 90  # seconds; a longer retry-after means a daily cap -> move to the next model instead of waiting
# Free tier (checked via headers): 1000 requests/day and 8000 tokens/minute per model. Groq counts
# prompt + max_tokens against TPM, so keep every request well under 8K or it is rejected outright.
# qwen (vision) also has 200K tokens/day (rolling) - that is the real throughput limit (~14 reels/day).

client = Groq(api_key=os.environ.get("GROQ_API_KEY") or "missing-key", max_retries=0, timeout=180)  # missing key: calls fail cleanly, server still boots
_exhausted: dict[str, float] = {}  # model -> unix time until which we skip it
_lock = threading.Lock()


class LLMUnavailable(Exception):
    pass


def log(msg: str):
    print(f"[llm {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _retry_after(err) -> float:
    try:
        h = getattr(getattr(err, "response", None), "headers", None) or {}
        if h.get("retry-after"):
            return float(h["retry-after"])
        m = re.search(r"try again in (?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)(ms|s))?", str(err))
        if m and any(m.groups()):
            h, mi, s, unit = m.groups()
            return int(h or 0) * 3600 + int(mi or 0) * 60 + float(s or 0) / (1000 if unit == "ms" else 1)
    except Exception:
        pass
    return 0.0


def available_at(models: list[str]) -> float:
    """Unix time when the first model in the chain is usable again (0 = usable now)."""
    with _lock:
        t = min(_exhausted.get(m, 0) for m in models)
    return t if t > time.time() else 0


def _with_fallback(models: list[str], call, attempts: int = 4):
    """Run call(model) across the model chain. Retries transient errors, skips exhausted/broken models."""
    last = None
    for model in models:
        with _lock:
            if _exhausted.get(model, 0) > time.time():
                continue
        for i in range(attempts):
            try:
                return call(model)
            except APIStatusError as e:
                last = e
                code = e.status_code
                if code == 429:
                    wait = _retry_after(e) or 2 ** i
                    if wait > MAX_WAIT:  # daily/token cap: park this model, try the next one
                        with _lock:
                            _exhausted[model] = time.time() + wait
                        log(f"{model} hit its cap (retry in {wait:.0f}s) - switching model")
                        break
                    log(f"{model} rate-limited, waiting {wait:.1f}s")
                    time.sleep(wait + random.random())
                elif code >= 500 or code == 408:
                    log(f"{model} server error {code}, retrying")
                    time.sleep(2 ** i + random.random())
                else:  # 400/401/404/413: retrying the same request won't help
                    log(f"{model} rejected request ({code}): {str(e)[:160]}")
                    if code in (401, 403, 404):  # bad key / model gone: stop hammering it for a while
                        with _lock:
                            _exhausted[model] = time.time() + 600
                    break
            except (APIConnectionError, APITimeoutError) as e:
                last = e
                log(f"{model} connection problem ({type(e).__name__}), retrying")
                time.sleep(2 ** i + random.random())
            except Exception as e:  # e.g. unparseable JSON from the model; retry once, then next model
                last = e
                log(f"{model} bad output ({type(e).__name__}: {str(e)[:80]})")
                if i >= 1:
                    break
    raise LLMUnavailable(f"All models failed ({', '.join(models)}): {last}")


def _strip_reasoning(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip()


def parse_json(text: str):
    """Extract the first JSON object/array from model output (tolerates ```json fences and chatter)."""
    text = _strip_reasoning(text)
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        raise ValueError("no JSON in model output")
    start = min(starts)
    end = max(text.rfind("}"), text.rfind("]"))
    return json.loads(text[start:end + 1])


def chat_json(system: str, user: str, models: list[str] = TEXT_MODELS, max_tokens: int = 3000):
    """Text-only chat that must return JSON. Falls back across models."""
    def call(model):
        kwargs = {}
        if model.startswith("openai/gpt-oss"):
            kwargs = {"reasoning_effort": "low", "include_reasoning": False}
        r = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=0.2, max_tokens=max_tokens, **kwargs,
        )
        return parse_json(r.choices[0].message.content)
    return _with_fallback(models, call)


def vision_json(prompt: str, images_b64: list[str], max_tokens: int = 1000):
    """Up to 3 JPEG images (base64) + prompt -> parsed JSON."""
    assert 0 < len(images_b64) <= MAX_IMAGES, "Groq vision accepts at most 3 images per request"
    content = [{"type": "text", "text": prompt}] + [
        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b}"}} for b in images_b64
    ]

    def call(model):
        r = client.chat.completions.create(
            model=model, messages=[{"role": "user", "content": content}],
            temperature=0.1, max_tokens=max_tokens,
        )
        return parse_json(r.choices[0].message.content)
    return _with_fallback(VISION_MODELS, call, attempts=8)


_local_whisper = None


def transcribe(wav_path: str) -> dict:
    """Returns {"text", "words": [{word,start,end}], "source"}. Groq first, local faster-whisper last."""
    with open(wav_path, "rb") as f:
        audio = f.read()

    def call(model):
        r = client.audio.transcriptions.create(
            file=("audio.wav", audio), model=model, language="en",
            response_format="verbose_json", timestamp_granularities=["word", "segment"],
        )
        d = r.model_dump()
        words = [{"word": w["word"].strip(), "start": w["start"], "end": w["end"]} for w in d.get("words") or []]
        return {"text": d.get("text", "").strip(), "words": words, "source": model}

    try:
        return _with_fallback(WHISPER_MODELS, call)
    except LLMUnavailable:
        pass

    # ponytail: local CPU fallback is slow (~1x realtime on 'base'), fine as a last resort
    global _local_whisper
    from faster_whisper import WhisperModel
    if _local_whisper is None:
        _local_whisper = WhisperModel(os.environ.get("WHISPER_MODEL", "tiny"), device="cpu", compute_type="int8")
    segs, _ = _local_whisper.transcribe(wav_path, language="en", word_timestamps=True)
    words, text = [], []
    for s in segs:
        text.append(s.text)
        words += [{"word": w.word.strip(), "start": w.start, "end": w.end} for w in (s.words or [])]
    return {"text": " ".join(text).strip(), "words": words, "source": "local-faster-whisper"}


if __name__ == "__main__":
    assert parse_json('```json\n[{"a": 1}]\n```') == [{"a": 1}]
    assert parse_json('<think>hmm {x}</think> Sure: {"ok": true} done') == {"ok": True}
    _E = type("E", (), {"response": None, "__str__": lambda s: s.msg})
    for msg, want in [("Please try again in 4m2.784s.", 242.784), ("try again in 712ms", 0.712), ("try again in 1h2m", 3720)]:
        e = _E(); e.msg = msg
        assert abs(_retry_after(e) - want) < 1e-6, (msg, _retry_after(e))
    print(chat_json("Return JSON only.", 'Return {"status": "ok"}'))
