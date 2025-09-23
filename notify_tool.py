#!/usr/bin/env python3
"""notify_tool.py - AI-accessible helper to send autonomous notifications."""
from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from typing import Dict, Iterable, Optional, Tuple

DEFAULT_USER_ID = "local"
DEFAULT_ORIGIN = "ai_autonomous"
DEFAULT_TIMEOUT = 10


class NotifyToolError(Exception):
    """Custom error for notify tool issues."""


def iter_candidate_endpoints() -> Iterable[str]:
    env_endpoint = os.getenv("NOTIFY_TOOL_ENDPOINT", "").strip()
    if env_endpoint:
        for raw in env_endpoint.split(","):
            url = raw.strip().rstrip("/")
            if url:
                yield url
        return

    host = os.getenv("NOTIFY_TOOL_HOST", "127.0.0.1").strip() or "127.0.0.1"
    port_env = os.getenv("NOTIFY_TOOL_PORT", "").strip()
    scheme = os.getenv("NOTIFY_TOOL_SCHEME", "").strip().lower()

    def build(s: str, h: str, p: int) -> str:
        return f"{s}://{h}:{p}"

    candidates = []
    if port_env.isdigit():
        port = int(port_env)
        scheme_pref = scheme if scheme in {"http", "https"} else ("https" if port == 443 else "http")
        candidates.append(build(scheme_pref, host, port))
    else:
        # Prefer explicit HTTPS port first, then common dev HTTP port.
        candidates.extend([
            build("https", host, 443),
            build("http", host, 443),
            build("https", host, 3000),
            build("http", host, 3000),
        ])

    seen = set()
    for url in candidates:
        u = url.rstrip("/")
        if u not in seen:
            seen.add(u)
            yield u


def load_payload(argv: Iterable[str]) -> Dict[str, object]:
    arg_list = list(argv)
    raw_input: Optional[str] = arg_list[1] if len(arg_list) > 1 else None
    if raw_input is None or not raw_input.strip():
        raw_input = sys.stdin.read()
    if not raw_input or not raw_input.strip():
        raise NotifyToolError("payload is required via argument or stdin")
    try:
        payload = json.loads(raw_input)
    except json.JSONDecodeError as exc:
        raise NotifyToolError(f"invalid JSON payload: {exc}") from exc
    if not isinstance(payload, dict):
        raise NotifyToolError("payload must be a JSON object")
    return payload


def validate_payload(payload: Dict[str, object]) -> Tuple[str, Dict[str, object], Dict[str, object]]:
    origin = str(payload.get("origin") or DEFAULT_ORIGIN).strip() or DEFAULT_ORIGIN
    notification = payload.get("notification")
    if not isinstance(notification, dict):
        raise NotifyToolError("payload.notification must be an object")
    if "title" not in notification and "body" not in notification:
        raise NotifyToolError("notification requires at least a title or body")
    # Normalize optional fields
    user_id = str(payload.get("userId") or payload.get("user_id") or DEFAULT_USER_ID).strip() or DEFAULT_USER_ID
    context = payload.get("context")
    if context is None:
        context_dict: Dict[str, object] = {}
    elif isinstance(context, dict):
        context_dict = context
    else:
        raise NotifyToolError("payload.context must be an object when provided")
    context_dict.setdefault("origin", origin)
    return user_id, notification, context_dict


def post_json(url: str, data: Dict[str, object]) -> Dict[str, object]:
    body = json.dumps(data).encode("utf-8")
    request = urllib.request.Request(
        url=url + "/api/notify/tool/send",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # Accept self-signed certificates when using HTTPS on localhost.
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(request, timeout=DEFAULT_TIMEOUT, context=context) as response:
            resp_body = response.read().decode("utf-8")
            try:
                return json.loads(resp_body) if resp_body else {"ok": True}
            except json.JSONDecodeError:
                return {"ok": True, "raw": resp_body}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        raise NotifyToolError(f"server error {exc.code}: {text}") from exc
    except urllib.error.URLError as exc:
        raise NotifyToolError(f"connection error: {exc.reason}") from exc


def main(argv: Iterable[str]) -> int:
    try:
        payload = load_payload(argv)
        user_id, notification, context = validate_payload(payload)
        request_body = {
            "userId": user_id,
            "origin": payload.get("origin") or DEFAULT_ORIGIN,
            "notification": notification,
            "context": context,
        }
        last_error: Optional[Exception] = None
        for endpoint in iter_candidate_endpoints():
            try:
                response = post_json(endpoint, request_body)
                response.setdefault("ok", True)
                response.setdefault("endpoint", endpoint)
                print(json.dumps(response, ensure_ascii=False))
                return 0
            except Exception as exc:  # pylint: disable=broad-except
                last_error = exc
                continue
        if last_error:
            raise last_error
        raise NotifyToolError("no notify endpoints configured")
    except NotifyToolError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stdout)
        return 1
    except Exception as exc:  # Unexpected
        print(json.dumps({"ok": False, "error": f"unexpected error: {exc}"}), file=sys.stdout)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
