#!/usr/bin/env python3

from __future__ import annotations

import base64
import re
from pathlib import Path
from urllib.parse import quote


LABEL = "Decentralized"
MESSAGE = "Always"
COLOR = "0EA5E9"
STYLE = "flat"


def minify_svg(svg: str) -> str:
    svg = re.sub(r">\s+<", "><", svg.strip())
    svg = re.sub(r"\s{2,}", " ", svg)
    return svg


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    svg_path = repo_root / "assets" / "icons" / "decentralized-hub-spoke.svg"

    svg = svg_path.read_text(encoding="utf-8")
    svg_minified = minify_svg(svg)

    svg_base64 = base64.b64encode(svg_minified.encode("utf-8")).decode("ascii")
    logo_data_uri = f"data:image/svg+xml;base64,{svg_base64}"
    logo_payload = quote(logo_data_uri, safe="")

    badge_url = (
        "https://img.shields.io/badge/"
        f"{quote(LABEL)}-{quote(MESSAGE)}-{COLOR}"
        f"?style={STYLE}&logo={logo_payload}"
    )
    markdown = f"![Decentralized]({badge_url})"

    print("LOGO_PAYLOAD=")
    print(logo_payload)
    print()
    print("BADGE_URL=")
    print(badge_url)
    print()
    print("MARKDOWN=")
    print(markdown)


if __name__ == "__main__":
    main()
