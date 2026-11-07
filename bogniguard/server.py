"""BogniGuard API and web server.

Locally it binds to 127.0.0.1 and images stay on this machine. With
BOGNIGUARD_PUBLIC=1 it adds what a public deployment needs: preset prompts only,
the safety filter, rate limits, a daily cap, and timed deletion of photos.
Photos are only ever held in memory.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw, ImageFilter, ImageOps, UnidentifiedImageError
from pydantic import BaseModel, Field

from .engine import MODEL_ID, SIZE, STRENGTHS, Blocked, Cancelled, Engine, pick_device
from .public import PRESETS

PUBLIC = os.environ.get("BOGNIGUARD_PUBLIC") == "1"
API_ONLY = os.environ.get("BOGNIGUARD_API_ONLY") == "1"
ORIGIN_REGEX = os.environ.get("BOGNIGUARD_ORIGIN_REGEX")

MAX_UPLOAD = (10 if PUBLIC else 25) * 1024 * 1024
MAX_JOBS = 32 if PUBLIC else 8
JOB_TTL = 15 * 60  # public photos are deleted from memory after this
MAX_WAITING = 4  # public: refuse rather than queue for ever
LIMITS = {"protect": 4, "test": 3}  # per visitor, per hour
DAILY_CAP = 150  # GPU jobs per day across everyone; bounds the bill
# Total GPU seconds this deployment may ever use. It never resets, so a free-credit
# deployment stops itself. 0 turns it off. Each job also counts IDLE_AFTER_JOB seconds,
# because the GPU stays billable for a moment before it sleeps.
GPU_BUDGET = int(os.environ.get("BOGNIGUARD_GPU_BUDGET_SECONDS", "0"))
IDLE_AFTER_JOB = 75
WEB = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="BogniGuard", docs_url=None if PUBLIC else "/docs", redoc_url=None)
if ORIGIN_REGEX:
    app.add_middleware(CORSMiddleware, allow_origin_regex=ORIGIN_REGEX,
                       allow_methods=["GET", "POST"], allow_headers=["Content-Type"])
engine = Engine(safety=PUBLIC)
worker = ThreadPoolExecutor(max_workers=1)  # one GPU job at a time
limit_store: dict = {}  # replaced by a persistent store on Modal


def bump(key: str, limit: int) -> bool:
    count = limit_store.get(key, 0)
    if count >= limit:
        return False
    limit_store[key] = count + 1
    return True


def spend(started: float) -> None:
    if PUBLIC and GPU_BUDGET:
        used = limit_store.get("gpu:total", 0)
        limit_store["gpu:total"] = used + (time.time() - started) + IDLE_AFTER_JOB


def check_limits(request: Request, kind: str) -> None:
    """Rate-limit public GPU work. Visitors are keyed by a salted hash, not a stored IP."""
    if not PUBLIC:
        return
    if GPU_BUDGET and limit_store.get("gpu:total", 0) >= GPU_BUDGET:
        raise HTTPException(503, "BogniGuard's free demo has used up its GPU time. Please check back later.")
    if sum(1 for j in jobs.values() if not j.finished) >= MAX_WAITING:
        raise HTTPException(503, "BogniGuard is busy right now. Please try again in a few minutes.")
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")
    salt = os.environ.get("BOGNIGUARD_SALT", "bogniguard")
    who = hashlib.sha256(f"{salt}:{ip}".encode()).hexdigest()[:24]
    now = time.time()
    if not bump(f"{kind}:{who}:{int(now // 3600)}", LIMITS[kind]):
        raise HTTPException(429, "You've reached the hourly limit. Please try again later.")
    if not bump(f"day:{int(now // 86400)}", DAILY_CAP):
        raise HTTPException(429, "BogniGuard has reached today's limit. Please try again tomorrow.")


class Job:
    def __init__(self) -> None:
        self.id = uuid.uuid4().hex
        self.created = time.time()
        self.events: list[dict] = []
        self.finished = False
        self.stop = threading.Event()
        self.files: dict[str, bytes] = {}
        self.keep_mask: Optional[Image.Image] = None
        self.images: dict[str, Image.Image] = {}

    def emit(self, **event) -> None:
        self.events.append(event)

    def end(self, **event) -> None:
        self.emit(**event)
        self.finished = True


jobs: "OrderedDict[str, Job]" = OrderedDict()


def new_job() -> Job:
    job = Job()
    jobs[job.id] = job
    while len(jobs) > MAX_JOBS:
        for key, old in jobs.items():
            if old.finished:
                del jobs[key]
                break
        else:
            break
    return job


def expire_jobs() -> None:
    while True:
        time.sleep(60)
        cutoff = time.time() - JOB_TTL
        for key, job in list(jobs.items()):
            if job.finished and job.created < cutoff:
                jobs.pop(key, None)


if PUBLIC:
    threading.Thread(target=expire_jobs, daemon=True).start()


def png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, "PNG")
    return buf.getvalue()


def data_url(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, "JPEG", quality=70)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


async def read_image(upload: UploadFile) -> Image.Image:
    raw = await upload.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, f"That image is over {MAX_UPLOAD // (1024 * 1024)} MB.")
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise HTTPException(415, "That file isn't an image we can read.")
    return image


def default_edit_mask() -> Image.Image:
    """Repaint everything around a central oval. Used when a whole photo was protected."""
    mask = Image.new("L", (SIZE, SIZE), 255)
    ImageDraw.Draw(mask).ellipse((SIZE * 0.2, SIZE * 0.08, SIZE * 0.8, SIZE * 0.92), fill=0)
    return mask.filter(ImageFilter.GaussianBlur(1))


def run_protect(job: Job, image: Image.Image, mask: Optional[Image.Image], strength: str) -> None:
    started = time.time()
    try:
        job.emit(stage="loading")

        def on_step(event: dict) -> None:
            noise = event.pop("noise", None)
            if noise is not None:
                event["preview"] = data_url(noise)
            job.emit(stage="protecting", **event)

        result = engine.protect(image, mask, strength, on_step, job.stop.is_set)
        job.keep_mask = mask
        job.images = {"original": result["original"], "protected": result["protected"]}
        for name in ("original", "protected", "noise"):
            job.files[name] = png(result[name])
        stats = {**result["stats"], "seconds": round(time.time() - started, 1)}
        job.end(stage="done", stats=stats)
    except Cancelled:
        job.end(stage="cancelled")
    except Exception as exc:  # surfaced to the UI rather than hanging the stream
        job.end(stage="error", message=str(exc))
    finally:
        spend(started)


def run_test(job: Job, source: Job, prompt: str, seed: int, steps: int, guidance: float) -> None:
    started = time.time()
    try:
        job.emit(stage="loading")
        edit_mask = ImageOps.invert(source.keep_mask.convert("L")) if source.keep_mask else default_edit_mask()
        for name in ("original", "protected"):
            def on_step(step: int, total: int, which: str = name) -> None:
                job.emit(stage="editing", which=which, step=step, total=total)

            result = engine.edit(
                source.images[name], edit_mask, prompt, seed, steps, guidance,
                on_step, job.stop.is_set,
            )
            job.files[f"edit_{name}"] = png(result)
            job.emit(stage="edited", which=name, url=f"/api/jobs/{job.id}/files/edit_{name}.png")
        job.end(stage="done")
    except Cancelled:
        job.end(stage="cancelled")
    except Blocked:
        job.end(stage="error", message="The safety filter blocked this result. Try another scene or photo.")
    except Exception as exc:
        job.end(stage="error", message=str(exc))
    finally:
        spend(started)


@app.get("/api/status")
def status() -> dict:
    return {"device": pick_device(), "model": MODEL_ID, "size": SIZE, "public": PUBLIC,
            "strengths": {k: {"eps": v.eps, "iters": v.iters} for k, v in STRENGTHS.items()}}


@app.post("/api/protect")
async def protect(
    request: Request,
    image: UploadFile = File(...),
    mask: Optional[UploadFile] = File(None),
    strength: str = Form("balanced"),
    consent: str = Form(""),
) -> dict:
    if strength not in STRENGTHS or (PUBLIC and strength == "light"):
        raise HTTPException(422, "Unknown strength.")
    if PUBLIC and consent != "yes":
        raise HTTPException(422, "Please confirm you have the right to use this photo.")
    pil = await read_image(image)
    pil_mask = await read_image(mask) if mask else None
    if pil_mask is not None:
        rgba = pil_mask.convert("RGBA")
        pil_mask = rgba.getchannel("A") if rgba.getchannel("A").getextrema()[0] < 255 else rgba.convert("L")
        if pil_mask.getextrema()[1] < 128:
            raise HTTPException(422, "Paint the area to protect first.")
    await run_in_threadpool(check_limits, request, "protect")
    job = new_job()
    worker.submit(run_protect, job, pil, pil_mask, strength)
    return {"job": job.id}


class TestRequest(BaseModel):
    job: str
    prompt: str = Field("", max_length=300)
    preset: str = ""
    seed: int = Field(1234, ge=0, le=2**32 - 1)
    steps: int = Field(40, ge=10, le=100)
    guidance: float = Field(7.5, ge=1, le=20)


@app.post("/api/test")
def test(body: TestRequest, request: Request) -> dict:
    source = jobs.get(body.job)
    if source is None or "protected" not in source.images:
        raise HTTPException(404, "That photo has expired. Forge the shield again to run a test.")
    if PUBLIC:
        # Visitors choose a harmless scene; free-text prompts are never accepted here.
        if body.preset not in PRESETS:
            raise HTTPException(422, "Choose one of the scenes.")
        prompt, steps, guidance = PRESETS[body.preset], 30, 7.5
    else:
        if not body.prompt.strip():
            raise HTTPException(422, "Type an edit prompt.")
        prompt, steps, guidance = body.prompt, body.steps, body.guidance
    check_limits(request, "test")
    job = new_job()
    worker.submit(run_test, job, source, prompt, body.seed, steps, guidance)
    return {"job": job.id}


@app.post("/api/jobs/{job_id}/cancel")
def cancel(job_id: str) -> dict:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "No such job.")
    job.stop.set()
    return {"ok": True}


@app.get("/api/jobs/{job_id}/events")
async def events(job_id: str) -> StreamingResponse:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "No such job.")

    async def stream():
        sent = 0
        while True:
            while sent < len(job.events):
                yield f"data: {json.dumps(job.events[sent])}\n\n"
                sent += 1
            if job.finished and sent >= len(job.events):
                return
            await asyncio.sleep(0.1)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store"})


@app.get("/api/jobs/{job_id}/files/{name}.png")
def file(job_id: str, name: str, download: bool = False) -> Response:
    job = jobs.get(job_id)
    if job is None or name not in job.files:
        raise HTTPException(404, "Not found.")
    headers = {"Cache-Control": "no-store"}
    if download:
        headers["Content-Disposition"] = 'attachment; filename="bogniguard-protected.png"'
    return Response(job.files[name], media_type="image/png", headers=headers)


class FreshStaticFiles(StaticFiles):
    """Always revalidate, so a browser never shows an outdated UI or logo."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


if not API_ONLY:
    app.mount("/", FreshStaticFiles(directory=WEB, html=True), name="web")
