"""Rigforge backend routes — the door between the studio page and the agent.

Mounted by the Hermes server at ``/api/plugins/rigforge/`` and reached from the
page as ``ctx.rest(...)``::

    GET  /health                 liveness + resolved state dir
    GET  /queue?peek=1&limit=5   read the queue without consuming it
    GET  /queue?limit=5          DRAIN the queue (the page's poller)
    POST /queue                  {"brief": {...}|"...", "note": "..."} — enqueue from the UI
    GET  /state                  the summary the studio last posted
    POST /state                  the studio posts its computed summary after each build

The agent half writes the same files through ``rigforge_agent``, so the tool and
the page can never disagree. Nothing here calls a model, opens a socket, or
shells out — every payload is bounded before it is stored.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from fastapi import APIRouter, Body, Query

_PLUGIN_ROOT = str(Path(__file__).resolve().parent.parent)
if _PLUGIN_ROOT not in sys.path:
    sys.path.insert(0, _PLUGIN_ROOT)

from rigforge_agent import (  # noqa: E402  (path inserted above by design)
    directive,
    enqueue,
    load_state,
    normalise_brief,
    parse_brief,
    peek,
    pop,
    queue,
    save_state,
    state_root,
)

router = APIRouter(tags=["rigforge"])


@router.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "state_dir": str(state_root()), "queued": len(queue())}


@router.get("/queue")
def get_queue(peek_only: bool = Query(False, alias="peek"), limit: int = Query(5, ge=1, le=20)) -> Dict[str, Any]:
    """Default = drain (the page is the only consumer). ``?peek=1`` is read-only."""
    items = peek(limit) if peek_only else pop(limit)
    return {"ok": True, "requests": items, "remaining": len(queue())}


@router.post("/queue")
def post_queue(payload: Mapping[str, Any] = Body(...)) -> Dict[str, Any]:
    raw = payload.get("brief")
    if isinstance(raw, Mapping):
        brief = normalise_brief(raw)
    elif isinstance(raw, str) and raw.strip():
        brief = parse_brief(raw)
    else:
        return {"ok": False, "error": "brief is required"}
    entry = enqueue(brief, note=str(payload.get("note") or ""), source=str(payload.get("source") or "studio"))
    return {"ok": True, "request": entry, "directive": directive(brief)}


@router.get("/state")
def get_state() -> Dict[str, Any]:
    return {"ok": True, "state": load_state() or None, "queued": len(queue())}


@router.post("/state")
def post_state(payload: Optional[Mapping[str, Any]] = Body(None)) -> Dict[str, Any]:
    if not payload:
        return {"ok": False, "error": "summary required"}
    return {"ok": True, "state": save_state(payload)}
