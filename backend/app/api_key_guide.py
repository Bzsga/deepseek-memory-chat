"""Public, credential-free guide shared by the web and Android setup screens."""
from pathlib import Path
import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse


ASSETS = Path(__file__).with_name("guide_assets")


def build_api_key_guide_router():
    router = APIRouter()

    @router.get("/api-key-guide", response_class=HTMLResponse)
    def guide():
        html = (ASSETS / "index.html").read_text(encoding="utf-8")

        def available_figure(match):
            figure = match.group(0)
            asset = re.search(r"api-key-guide/(step-[1-6]\.jpg)", figure)
            return figure if asset is None or (ASSETS / asset[1]).is_file() else ""

        html = re.sub(r"<figure>.*?</figure>", available_figure, html, flags=re.S)
        return re.sub(r"<details><summary>[^<]+</summary>\s*</details>", "", html)

    @router.get("/api-key-guide/step-{step}.jpg", response_class=FileResponse)
    def screenshot(step: int):
        path = ASSETS / f"step-{step}.jpg"
        if not 1 <= step <= 6 or not path.is_file():
            raise HTTPException(404)
        return FileResponse(path, media_type="image/jpeg")

    return router
