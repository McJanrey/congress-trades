"""Parse a House PTR PDF into structured JSON transactions.

Usage: python parse_ptr.py <path-or-url> [doc_id]
Emits a single JSON document to stdout.
"""

from __future__ import annotations
import io
import json
import re
import sys
import urllib.request
import pdfplumber

# Owner codes at the start of each transaction row.
# SP=Spouse, JT=Joint, DC=Dependent Child, blank/-- = Self.
OWNER = r"(SP|JT|DC|--)?"

# Asset-type bracket tags that follow the asset name.
# Documented in the House Clerk instructions; covers the common ones.
ASSET_TAG = r"\[(?:ST|OP|RS|OL|ET|HE|MF|MA|OC|OI|PE|PM|RP|SA|VI|GS|BA|CO|CT|EF|FU|OT)\]"

# Transaction type: Purchase, Sale, Sale (partial), Exchange.
TX_TYPE = r"(P|S \(partial\)|S|E)"

DATE = r"\d{2}/\d{2}/\d{4}"

# Amount can break across a line, so amount matching is done after normalisation.
AMOUNT = r"\$[\d,]+\s*-\s*\$?[\d,]+"


def fetch_pdf_bytes(src: str) -> bytes:
    if src.startswith("http://") or src.startswith("https://"):
        req = urllib.request.Request(src, headers={"User-Agent": "congress-trades/0.1"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read()
    with open(src, "rb") as fh:
        return fh.read()


def extract_text(pdf_bytes: bytes) -> tuple[str, dict]:
    """Return (full_text, header_fields). Header fields: name, state_district, status."""
    full = []
    header = {}
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            t = page.extract_text() or ""
            full.append(t)
    text = "\n".join(full)

    m = re.search(r"Name:\s*(?:Hon\.\s*)?(.+)", text)
    if m:
        header["name"] = m.group(1).strip()
    m = re.search(r"State/District:\s*(\S+)", text)
    if m:
        header["state_district"] = m.group(1).strip()
    m = re.search(r"Status:\s*(\S+)", text)
    if m:
        header["status"] = m.group(1).strip()
    m = re.search(r"Filing ID #(\d+)", text)
    if m:
        header["filing_id"] = m.group(1)
    return text, header


def normalise(text: str) -> str:
    # Strip the form-feed/control chars pdfplumber leaves in label glyphs (F\x00 S\x00: etc.).
    text = re.sub(r"[\x00-\x08\x0b-\x1f]", "", text)
    # Collapse soft line-wraps that split an amount range across two lines.
    text = re.sub(r"(\$[\d,]+\s*-)\s*\n\s*(\$[\d,]+)", r"\1 \2", text)
    return text


# A transaction record block. Strategy: find lines anchored by
#   <tx_type> <date> <date> <amount>
# then walk backwards in the buffer to grab the owner + asset description.
TX_ANCHOR = re.compile(
    rf"^(?P<pre>.*?)\s+(?P<tx>{TX_TYPE})\s+(?P<tdate>{DATE})\s+(?P<ndate>{DATE})\s+(?P<amount>{AMOUNT})\s*$",
    re.MULTILINE,
)

TICKER_RE = re.compile(r"\(([A-Z][A-Z0-9.\-]{0,9})\)")


def parse_transactions(text: str) -> list[dict]:
    text = normalise(text)
    lines = text.split("\n")
    out: list[dict] = []

    # Walk line-by-line; when we hit an anchor line, gather preceding "context" lines
    # (the asset name often wraps from the previous line, and the ticker/[ST] tag
    # often lives on the FOLLOWING line).
    for i, line in enumerate(lines):
        m = TX_ANCHOR.match(line)
        if not m:
            continue
        pre = m.group("pre").strip()
        tx = m.group("tx")
        tdate = m.group("tdate")
        ndate = m.group("ndate")
        amount = m.group("amount")

        # Owner code is the first token of `pre` if it looks like one.
        owner = None
        asset_parts = [pre]
        tokens = pre.split(maxsplit=1)
        if tokens and tokens[0] in ("SP", "JT", "DC", "--"):
            owner = tokens[0]
            asset_parts = [tokens[1] if len(tokens) > 1 else ""]

        # Look one line ahead for a continuation of the asset name (e.g. "(ABT) [ST]").
        if i + 1 < len(lines):
            nxt = lines[i + 1].strip()
            # A continuation line typically starts with "(TICKER)" or "[ST]" or is plain text
            # before any "Filing Status:" / "Subholding Of:" / "Description:" label.
            # Accept the next line as a name continuation unless it's clearly a label,
            # a new transaction anchor, or the page/table header.
            if (
                nxt
                and not re.match(
                    r"(Filing Status|Subholding Of|Description|ID Owner|Name:|Status:|State|Cap\.|Type|Date)",
                    nxt,
                )
                and not TX_ANCHOR.match(nxt)
            ):
                asset_parts.append(nxt)

        asset_str = " ".join(p for p in asset_parts if p).strip()

        # Extract ticker if present.
        ticker = None
        tm = TICKER_RE.search(asset_str)
        if tm:
            ticker = tm.group(1)
            asset_name = (asset_str[: tm.start()] + asset_str[tm.end():]).strip()
        else:
            asset_name = asset_str

        # Strip the asset-type tag from the end of the name.
        asset_name = re.sub(rf"\s*{ASSET_TAG}\s*", " ", asset_name).strip()
        # Asset-type tag (ST/OP/etc) — keep for downstream filtering.
        tag_match = re.search(ASSET_TAG, asset_str)
        asset_type = tag_match.group(0).strip("[]") if tag_match else None

        out.append({
            "owner": owner,
            "asset": asset_name,
            "ticker": ticker,
            "asset_type": asset_type,
            "transaction_type": tx,
            "transaction_date": tdate,
            "notification_date": ndate,
            "amount_range": amount,
        })

    return out


def main():
    if len(sys.argv) < 2:
        print("usage: parse_ptr.py <path-or-url> [doc_id]", file=sys.stderr)
        sys.exit(2)
    src = sys.argv[1]
    doc_id = sys.argv[2] if len(sys.argv) > 2 else None

    pdf_bytes = fetch_pdf_bytes(src)
    text, header = extract_text(pdf_bytes)
    transactions = parse_transactions(text)

    result = {
        "source": src,
        "doc_id": doc_id or header.get("filing_id"),
        "member": header.get("name"),
        "state_district": header.get("state_district"),
        "transaction_count": len(transactions),
        "transactions": transactions,
    }
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
