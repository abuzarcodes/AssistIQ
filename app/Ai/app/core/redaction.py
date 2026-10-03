"""Redaction of third-party text before it reaches a log record.

Why this exists
---------------
The provider adapters log what the provider said, because that text is the only thing that
distinguishes "your key was revoked" from "that model id does not exist" from "we sent a
malformed request". It is also the text most likely to contain a credential: OpenAI's own
auth failure reads ``Incorrect API key provided: sk-...``, echoing the key straight back at
whoever logs the exception.

So the rule is: **no provider text reaches a log record except through `redact()`.** This
module is the one place that decides what is safe. Nothing here is a secret *source* — it
reads the configured credentials so it can remove them.

Two redaction strategies, because they defend against different things
---------------------------------------------------------------------
* **By value** — every credential this service holds is replaced literally. This is the one
  that actually works against a real key, since a vendor error echoes the exact string we
  sent. Pattern matching cannot catch a key whose format changes; comparing against the
  value we configured can.
* **By shape** — `sk-`, `gsk_`, `AIza` and friends, plus `Bearer` tokens. This catches
  credentials that are *not* ours: a key in a URL the provider echoed, a token from a
  neighbouring service.

The value pass runs first: a real key that also happens to look like a pattern is removed
whole rather than partially, which is what "longest secret first" ordering below is for.
"""

import re
from typing import Any, Iterable, List, Sequence

from app.core.config import settings

#: What replaces anything removed. Deliberately not empty: a log line reading
#: ``Incorrect API key provided: `` with nothing after it looks like a truncation bug.
PLACEHOLDER = "[redacted]"

#: Credential settings scrubbed by value. `AI_SERVICE_API_KEY` is the Node-to-Python shared
#: secret and is the most damaging of these to leak — it authenticates every internal call.
_CREDENTIAL_SETTINGS: Sequence[str] = (
    "LLM_API_KEY",
    "GROK_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_COMPATIBLE_API_KEY",
    "EMBEDDING_API_KEY",
    "AI_SERVICE_API_KEY",
)

#: A configured value shorter than this is not treated as a secret. Real credentials are far
#: longer, and scrubbing a short string by value would redact ordinary words out of every
#: message — a local `.env` holding `OPENAI_API_KEY="test"` would otherwise turn the word
#: "test" into `[redacted]` everywhere. Key *shapes* are still scrubbed regardless of length.
_MIN_SECRET_LENGTH = 8

#: Credential shapes worth removing even when they are not ours.
_KEY_SHAPES = re.compile(
    r"""
      (?:sk-or-v1-|sk-|gsk_|xai-)[A-Za-z0-9_\-]{6,}   # OpenAI, OpenRouter, Groq, xAI
    | AIza[A-Za-z0-9_\-]{10,}                          # Google
    """,
    re.VERBOSE,
)

#: `Authorization: Bearer <token>` and bare `Bearer <token>`. The scheme word is kept so the
#: line still reads as an auth header rather than as unexplained redaction.
_BEARER = re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._\-]{6,}")

#: Applied last. Long enough to hold a provider's sentence, short enough that one failure is
#: one readable line.
_DEFAULT_MAX_LENGTH = 300


def _configured_secrets() -> List[str]:
    """Every credential currently configured, longest first.

    Read from ``settings`` on each call rather than cached at import: the service reads its
    environment once, but tests monkeypatch credentials per case, and a cached list would
    keep scrubbing a value that is no longer configured while missing a new one.

    Longest first so a credential that contains another as a substring is removed whole.
    """
    secrets = set()
    for name in _CREDENTIAL_SETTINGS:
        value = (getattr(settings, name, "") or "").strip()
        if len(value) >= _MIN_SECRET_LENGTH:
            secrets.add(value)
    return sorted(secrets, key=len, reverse=True)


def redact(
    text: Any,
    *,
    redact_also: Iterable[str] = (),
    max_length: int = _DEFAULT_MAX_LENGTH,
) -> str:
    """Return `text` made safe to log.

    Args:
        text: The third-party string to sanitise. Non-strings are stringified; `None`
            becomes `""` so a caller can pass an absent cause without branching.
        redact_also: Strings to remove because the caller knows they are sensitive but this
            module cannot recognise — the prompt and system message. A provider that echoes
            the request body would otherwise write the customer's message into the log.
            Entries are scrubbed at **any** length, unlike credentials: the guarantee we want
            is "the prompt never appears", and a length floor would quietly weaken it for
            short prompts. Empty entries are skipped — `str.replace("")` inserts the
            placeholder between every character.
        max_length: Truncation point for the result.

    Returns:
        A single-line string with credentials replaced by ``[redacted]``, whitespace
        collapsed, and a truncation marker if it was cut.
    """
    if text is None:
        return ""

    result = text if isinstance(text, str) else str(text)

    for secret in _configured_secrets():
        result = result.replace(secret, PLACEHOLDER)

    for extra in redact_also:
        if extra:
            result = result.replace(extra, PLACEHOLDER)

    result = _BEARER.sub(lambda m: f"{m.group(1)} {PLACEHOLDER}", result)
    result = _KEY_SHAPES.sub(PLACEHOLDER, result)

    # Collapse runs of whitespace, including newlines: a multi-line provider error must not
    # break the one-record-per-line shape every log consumer here assumes.
    result = " ".join(result.split())

    if len(result) > max_length:
        removed = len(result) - max_length
        result = result[:max_length].rstrip() + f"…(+{removed} chars)"

    return result
