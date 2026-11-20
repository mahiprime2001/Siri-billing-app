"""
(Same rules as siri-api/billitem_tax.py; keep the two in step.)

The tax rate of each bill line, as it was when the bill was made.

Shelf prices include tax. A bill line stores only the price BEFORE tax; since 2026-11-21 it also stores the rate
used (billitems.tax_percentage, migrations/billitem_tax_percentage.sql). Older lines have no rate saved, and using a
product's CURRENT rate for them is wrong whenever the product's HSN/tax was set or changed after the sale (a Rs.600
chain billed while it had no tax came back as Rs.618 in a replacement).

  insert_billitems(rows)          insert lines; works before AND after the column exists (drops it if missing)
  current_taxes(product_ids)      {product id: today's tax %} - what a NEW line is billed with
  sale_taxes(bill, lines)         the rate per line AT THE SALE: the saved rate when there is one, otherwise the
                                  rates that make the lines add up to what the bill actually charged
"""
import itertools
import logging
from typing import Any, Dict, Iterable, List, Optional

supabase = None  # the store app passes its own database client to every call

logger = logging.getLogger(__name__)

TAX_COLUMN = "tax_percentage"
# A bill total may be rounded (to the nearest 5 or 10 rupees) after the discount; inside this gap two answers are
# treated as equally good.
_TOTAL_TOLERANCE = 10.0
# Above this many unknown lines, trying every combination costs too much: today's rates are used as they are.
_MAX_GUESS_LINES = 10


def _num(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _column_missing(error: Exception) -> bool:
    text = str(error)
    return TAX_COLUMN in text and ("column" in text.lower() or "schema" in text.lower() or "PGRST" in text)


def insert_billitems(rows: List[Dict[str, Any]], client=None):
    """Insert bill lines. If the database does not have the tax column yet, the lines are saved without it."""
    if not rows:
        return None
    db = client or supabase
    try:
        return db.table("billitems").insert(rows).execute()
    except Exception as e:  # noqa: BLE001
        if not _column_missing(e):
            raise
        logger.warning("billitems.%s is missing (run migrations/billitem_tax_percentage.sql); saved lines without it",
                       TAX_COLUMN)
        return db.table("billitems").insert([{k: v for k, v in r.items() if k != TAX_COLUMN} for r in rows]).execute()


def current_taxes(product_ids: Iterable[str], client=None) -> Dict[str, float]:
    """Today's tax % per product (0 when the product has no HSN). Never raises."""
    ids = sorted({str(p) for p in product_ids if p})
    if not ids:
        return {}
    try:
        rows = (client or supabase).table("products").select("id, hsn_codes(tax)").in_("id", ids).execute().data or []
    except Exception:  # noqa: BLE001
        return {}
    out: Dict[str, float] = {}
    for row in rows:
        hsn = row.get("hsn_codes")
        if isinstance(hsn, list):
            hsn = hsn[0] if hsn else {}
        out[str(row.get("id"))] = _num((hsn or {}).get("tax")) or 0.0
    return out


def _charged(bill: Dict[str, Any], incl_sum: float) -> float:
    """What the bill would total for this tax-included line sum, after its discount."""
    pct = _num(bill.get("discount_percentage", bill.get("discountPercentage"))) or 0.0
    if pct > 0:
        return incl_sum * (1 - pct / 100)
    return incl_sum - (_num(bill.get("discount_amount", bill.get("discountAmount"))) or 0.0)


def sale_taxes(bill: Dict[str, Any], lines: List[Dict[str, Any]]) -> List[float]:
    """
    The tax % of each line at the time of sale. Each line: {"price", "quantity", "saved_tax", "current_tax"}.

    A saved rate always wins. For lines without one the usual cause of a wrong rate is that the product had NO tax set
    when it was sold and got one later, so each such line is tried at today's rate and at 0%. The combination whose
    total matches what the bill charged is used; when several match, the one keeping the most lines at today's rate
    wins (so a correct bill is never changed by rounding noise). With nothing to check against, today's rates are used.
    """
    base = []
    unknown = []
    for index, line in enumerate(lines):
        saved = _num(line.get("saved_tax"))
        current = _num(line.get("current_tax")) or 0.0
        base.append(saved if saved is not None else current)
        if saved is None and current > 0:
            unknown.append(index)
    total = _num(bill.get("total"))
    if not unknown or total is None or len(unknown) > _MAX_GUESS_LINES:
        return base

    def incl(rates: List[float]) -> float:
        return sum((_num(l.get("price")) or 0.0) * (_num(l.get("quantity")) or 0.0) * (1 + r / 100)
                   for l, r in zip(lines, rates))

    for k in range(len(unknown) + 1):                   # fewest lines moved off today's rate first
        fits = []
        for zeroed in itertools.combinations(unknown, k):
            rates = [0.0 if i in zeroed else r for i, r in enumerate(base)]
            gap = abs(_charged(bill, incl(rates)) - total)
            if gap <= _TOTAL_TOLERANCE:
                fits.append((gap, rates))
        if fits:
            return min(fits, key=lambda f: f[0])[1]     # the closest of the equally-few changes
    return base
