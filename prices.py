"""Live component prices, from a real supplier, cached and honest.

The studio's catalogue carries an *estimate* per part so the engine can run
offline. This module is the other half: it asks the LCSC parts index (the same
data JLCPCB uses for assembly) what a part actually costs right now, and hands
back a row that says where the number came from and when it was read.

Rules:
  * never invent a price — a miss returns ok=False and the UI keeps showing the
    estimate, labelled as an estimate;
  * cache for 12h so a page refresh does not hammer a supplier;
  * every row carries the product URL, so the number can be checked by hand.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List

API = "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList"
CACHE_TTL_S = 12 * 3600
CACHE_NAME = "prices.json"


def _root() -> Path:
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        base = Path(get_hermes_home())
    except Exception:  # pragma: no cover - bare interpreter
        import os

        base = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    root = base / "rigforge"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _load_cache() -> Dict[str, Any]:
    try:
        with (_root() / CACHE_NAME).open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_cache(cache: Dict[str, Any]) -> None:
    target = _root() / CACHE_NAME
    tmp = target.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(cache, fh, ensure_ascii=False, indent=1)
    tmp.replace(target)


def _search(query: str, limit: int = 5) -> List[Dict[str, Any]]:
    body = json.dumps({"currentPage": 1, "pageSize": limit, "keyword": query}).encode()
    req = urllib.request.Request(
        API,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": "rigforge/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as fh:
            payload = json.load(fh)
    except (urllib.error.URLError, TimeoutError, ValueError):
        return []
    page = (payload.get("data") or {}).get("componentPageInfo") or {}
    return page.get("list") or []


def _row(candidate: Dict[str, Any], query: str) -> Dict[str, Any]:
    breaks = candidate.get("componentPrices") or []
    unit = None
    if breaks:
        first = breaks[0]
        unit = first.get("productPrice")
    code = candidate.get("componentCode") or ""
    model = candidate.get("componentModelEn") or candidate.get("componentModel") or ""
    return {
        "query": query,
        "ok": unit is not None,
        "price": float(unit) if unit is not None else None,
        "currency": "USD",
        "sku": code,
        "model": model,
        "stock": candidate.get("stockCount"),
        "url": candidate.get("lcscGoodsUrl") or "",
        "source": "LCSC parts index",
        "fetched": int(time.time()),
    }


def _score(candidate: Dict[str, Any], query: str) -> float:
    """Prefer a candidate whose model number actually contains the query."""
    q = "".join(ch for ch in query.lower() if ch.isalnum())
    model = "".join(ch for ch in str(candidate.get("componentModelEn") or "").lower() if ch.isalnum())
    if not q or not model:
        return 0.0
    if model == q:
        return 3.0
    if q in model:
        return 2.0
    if model in q:
        return 1.5
    head = q[:6]
    return 1.0 if head and head in model else 0.0


def lookup(queries: Iterable[str], max_age_s: int = CACHE_TTL_S) -> Dict[str, Dict[str, Any]]:
    """query → row. Cached rows are reused until they age out."""
    cache = _load_cache()
    now = int(time.time())
    out: Dict[str, Dict[str, Any]] = {}
    dirty = False
    for raw in queries:
        query = str(raw or "").strip()
        if not query:
            continue
        hit = cache.get(query)
        if hit and now - int(hit.get("fetched") or 0) < max_age_s:
            out[query] = hit
            continue
        best = None
        best_score = 0.0
        for cand in _search(query):
            s = _score(cand, query)
            if s > best_score:
                best, best_score = cand, s
        # A loose match on a bare chip is not the part you are buying: an
        # SSD1306 *controller* is not an SSD1306 *module*. Below 2.0 we report a
        # miss and leave the estimate in place rather than print a wrong number.
        if best is not None:
            if best_score < 2.0:
                best = None
            elif not (best.get("stockCount") or 0) > 0:
                # listed but not orderable (JLCPCB shows "mail only" rows with
                # stock 0 and a placeholder price) — do not print that number
                best = None
        row = _row(best, query) if best else {
            "query": query, "ok": False, "price": None, "currency": "USD",
            "source": "LCSC parts index", "fetched": now,
            "reason": "not stocked by LCSC — buy this one from the vendor listed in the BOM",
        }
        cache[query] = row
        out[query] = row
        dirty = True
    if dirty:
        _save_cache(cache)
    return out


def price_design(parts: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Price a design's parts list. Returns rows plus a buy-vs-estimate total."""
    parts = [p for p in parts if isinstance(p, dict)]
    queries = []
    for p in parts:
        sku = str(p.get("sku") or p.get("name") or "").strip()
        if sku:
            queries.append(sku)
    rows = lookup(queries)
    by_sku = {}
    live_total = 0.0
    live_lines = 0
    estimate_total = 0.0
    for p in parts:
        sku = str(p.get("sku") or p.get("name") or "").strip()
        row = rows.get(sku) or {}
        qty = float(p.get("qty") or 1)
        est = float(p.get("price") or 0) * qty
        if row.get("ok"):
            line = float(row["price"]) * qty
            live_total += line
            live_lines += 1
            by_sku[sku] = {**row, "qty": qty, "line": round(line, 2), "kind": "live"}
        else:
            estimate_total += est
            by_sku[sku] = {**row, "qty": qty, "line": round(est, 2), "kind": "estimate"}
    return {
        "rows": by_sku,
        "liveTotal": round(live_total, 2),
        "estimateTotal": round(estimate_total, 2),
        "liveLines": live_lines,
        "lines": len(by_sku),
        "currency": "USD",
        "fetched": int(time.time()),
    }
