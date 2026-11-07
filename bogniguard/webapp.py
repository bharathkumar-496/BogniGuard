"""Lightweight public site. Serves the UI from a CPU, so visiting never wakes the GPU."""
from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from .public import PRESETS


class FreshStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


def build(web_dir: str, api_url: str) -> FastAPI:
    app = FastAPI(title="BogniGuard", docs_url=None, redoc_url=None, openapi_url=None)
    config = (f"window.BG_API={json.dumps(api_url.rstrip('/'))};"
              f"window.BG_PUBLIC=true;window.BG_PRESETS={json.dumps(PRESETS)};")

    @app.get("/config.js")
    def config_js() -> Response:
        return Response(config, media_type="text/javascript", headers={"Cache-Control": "no-cache"})

    app.mount("/", FreshStaticFiles(directory=web_dir, html=True), name="web")
    return app
