"""Tests for provider failure logging: rendering, fault attribution, and redaction.

Why this file exists
--------------------
Before it, a provider failure produced a log line reading
``openrouter call failed: UPSTREAM`` and nothing else. Two separate reasons:

1. ``app/core/logging.py``'s formatter referenced only ``%(message)s``, so the context
   every call site attached through ``format_log_context`` became a LogRecord attribute
   and was then never printed. The structured logging was inert.
2. The provider's own error text was captured on ``ProviderError.cause`` and dropped.

Fixing (1) is a formatter change. Fixing (2) means putting third-party text into a log
record, which is how credentials leak — vendor auth errors echo the key back at you — so
it is only safe with the redaction tests below.

A note on how these tests assert
--------------------------------
``caplog.text`` formats records with **pytest's** formatter, which renders only
``%(message)s``. It therefore cannot see a context field, and an assertion like
``assert key not in caplog.text`` passes whether or not the key is in ``provider_message``.
These tests render through the real ``ContextFormatter`` and inspect ``record.__dict__``
instead, so that a leak in a context field actually fails something.
"""

import json
import logging

import pytest

from app.core.config import settings
from app.core.logging import ContextFormatter, format_log_context
from app.core.redaction import PLACEHOLDER, _CREDENTIAL_SETTINGS, redact
from app.providers.base import (
    ProviderError,
    ProviderErrorKind,
    ProviderFault,
    _FAULTS,
    fault_for,
)

_TEXT = ContextFormatter(style="text", datefmt="%Y-%m-%d %H:%M:%S")
_JSON = ContextFormatter(style="json", datefmt="%Y-%m-%d %H:%M:%S")

#: A credential with no recognisable vendor prefix, so only the by-value pass can remove it.
#: A `sk-...` shaped key would be caught by the shape rule instead, and the test would pass
#: even if value redaction were broken.
SHAPELESS_CREDENTIAL = "9f4c1e7a2b8d0356e1c9a4f7b2d8e0c3"


def _record(message: str = "a message", **context) -> logging.LogRecord:
    """A LogRecord carrying `context` exactly as `logger.x(..., extra=...)` would."""
    record = logging.LogRecord(
        name="assistiq_ai",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=(),
        exc_info=None,
    )
    for key, value in context.items():
        setattr(record, key, value)
    return record


def _rendered(records, formatter=_TEXT) -> str:
    """Every record rendered by our own formatter — the text an operator would actually see."""
    return "\n".join(formatter.format(record) for record in records)


def _all_attributes(records) -> str:
    """Every attribute on every record, whether or not the formatter renders it."""
    return "\n".join(
        f"{key}={value}" for record in records for key, value in record.__dict__.items()
    )


@pytest.fixture
def no_credentials(monkeypatch):
    """Blank every credential so these tests do not depend on the machine's `.env`."""
    for attr in _CREDENTIAL_SETTINGS:
        monkeypatch.setattr(settings, attr, "", raising=False)


class TestContextIsRendered:
    """The regression for the defect that made every other diagnostic invisible."""

    def test_the_attached_context_reaches_the_rendered_line(self):
        rendered = _TEXT.format(
            _record(
                "OpenRouter call failed: AUTH",
                **format_log_context(
                    operation="provider_generate",
                    provider="openrouter",
                    model_id="openai/gpt-4o-mini",
                    kind="AUTH",
                    fault="ours",
                    provider_status=401,
                ),
            )
        )

        for expected in (
            "operation=provider_generate",
            "provider=openrouter",
            "model_id=openai/gpt-4o-mini",
            "kind=AUTH",
            "fault=ours",
            "provider_status=401",
        ):
            assert expected in rendered, rendered

    def test_well_known_fields_render_in_a_stable_order(self):
        # Same fields in the same place every time, so a line can be scanned rather than read.
        rendered = _TEXT.format(
            _record(
                "x",
                provider="openrouter",
                kind="AUTH",
                fault="ours",
                operation="provider_generate",
            )
        )

        assert (
            rendered.index("operation=")
            < rendered.index("provider=")
            < rendered.index("kind=")
            < rendered.index("fault=")
        )

    def test_a_field_with_no_value_is_omitted_rather_than_printed_as_none(self):
        # `provider_status=None` would suggest a status was measured and found empty.
        rendered = _TEXT.format(_record("x", provider="openrouter", provider_status=None))

        assert "provider=openrouter" in rendered
        assert "provider_status" not in rendered

    def test_a_value_containing_a_space_is_quoted(self):
        # Otherwise `provider_message=the model does not exist` reads as four fields.
        rendered = _TEXT.format(_record("x", provider_message="the model does not exist"))

        assert 'provider_message="the model does not exist"' in rendered

    def test_json_style_emits_one_parseable_object(self):
        line = _JSON.format(
            _record("Openrouter call failed", provider="openrouter", fault="ours")
        )

        assert "\n" not in line
        payload = json.loads(line)
        assert payload["msg"] == "Openrouter call failed"
        assert payload["provider"] == "openrouter"
        assert payload["fault"] == "ours"
        assert payload["level"] == "ERROR"


class TestFaultAttribution:
    """`fault` answers the question the kind deliberately does not: whose problem is it."""

    def test_every_kind_has_a_fault_mapping(self):
        # Totality, checked against the mapping itself rather than through `fault_for`, whose
        # `unknown` default would make a missing entry indistinguishable from a considered
        # one. A kind added without a mapping should fail here.
        assert set(_FAULTS) == set(ProviderErrorKind)

    @pytest.mark.parametrize(
        "kind,expected",
        [
            (ProviderErrorKind.NOT_CONFIGURED, ProviderFault.OURS),
            (ProviderErrorKind.AUTH, ProviderFault.OURS),
            (ProviderErrorKind.BAD_REQUEST, ProviderFault.OURS),
            (ProviderErrorKind.UNKNOWN_PROVIDER, ProviderFault.OURS),
            (ProviderErrorKind.RATE_LIMIT, ProviderFault.PROVIDER),
            (ProviderErrorKind.UPSTREAM, ProviderFault.PROVIDER),
            # Genuinely unattributable — see the rationale in `base.py`.
            (ProviderErrorKind.TIMEOUT, ProviderFault.UNKNOWN),
            (ProviderErrorKind.UNKNOWN, ProviderFault.UNKNOWN),
        ],
    )
    def test_the_fault_of_each_kind(self, kind, expected):
        assert fault_for(kind) is expected

    def test_an_error_carries_its_own_fault(self):
        assert ProviderError(ProviderErrorKind.AUTH).fault is ProviderFault.OURS

    def test_the_fault_is_not_added_to_the_response_details(self):
        # `details` is serialised into the HTTP error envelope and is a contract with Node.
        # The fault is a log field; adding it to the response would change that contract.
        assert "fault" not in ProviderError(ProviderErrorKind.AUTH).details


class TestRedaction:
    """`redact` is the only thing standing between vendor error text and a leaked key."""

    def test_a_configured_credential_is_removed_by_value(self, no_credentials, monkeypatch):
        monkeypatch.setattr(settings, "OPENROUTER_API_KEY", SHAPELESS_CREDENTIAL)

        result = redact(f"Incorrect API key provided: {SHAPELESS_CREDENTIAL}")

        assert SHAPELESS_CREDENTIAL not in result
        assert PLACEHOLDER in result

    def test_the_service_to_service_secret_is_removed(self, no_credentials, monkeypatch):
        # The Node-to-Python shared secret. Leaking it would let anything holding the log
        # call every internal endpoint.
        monkeypatch.setattr(settings, "AI_SERVICE_API_KEY", SHAPELESS_CREDENTIAL)

        assert SHAPELESS_CREDENTIAL not in redact(f"X-API-Key: {SHAPELESS_CREDENTIAL}")

    @pytest.mark.parametrize(
        "secret",
        [
            "sk-abcdef1234567890",
            "sk-or-v1-abcdef1234567890",
            "gsk_abcdef1234567890",
            "xai-abcdef1234567890",
            "AIzaSyABCDEFGHIJKLMNOP",
        ],
    )
    def test_key_shapes_are_removed_even_when_they_are_not_ours(
        self, no_credentials, secret
    ):
        # Catches a credential echoed from somewhere we do not hold the value of — a URL the
        # provider quoted back, a token from a neighbouring service.
        result = redact(f"rejected: {secret}")

        assert secret not in result
        assert result == f"rejected: {PLACEHOLDER}"

    def test_a_bearer_token_is_removed_but_the_scheme_word_survives(self, no_credentials):
        result = redact("Authorization: Bearer abcdef123456")

        assert "abcdef123456" not in result
        # Kept, so the line still reads as an auth header rather than unexplained redaction.
        assert "Bearer" in result

    def test_the_prompt_is_removed_however_short_it_is(self, no_credentials):
        # No length floor here, deliberately: the guarantee we want is "the prompt never
        # appears", and a floor would quietly weaken it for a short one.
        assert redact("echo: hi", redact_also=("hi",)) == f"echo: {PLACEHOLDER}"

    def test_an_empty_redact_also_entry_is_ignored(self, no_credentials):
        # `str.replace("")` inserts the placeholder between every character; guarding it is
        # what lets adapters pass `system_message or ""` unconditionally.
        assert redact("unchanged", redact_also=("",)) == "unchanged"

    def test_newlines_are_collapsed_so_one_failure_stays_one_line(self, no_credentials):
        assert redact("first\n\nsecond\tthird") == "first second third"

    def test_long_text_is_truncated_and_says_by_how_much(self, no_credentials):
        result = redact("x" * 500)

        assert result.startswith("x" * 300)
        assert "…(+200 chars)" in result

    def test_a_short_configured_value_is_not_treated_as_a_secret(
        self, no_credentials, monkeypatch
    ):
        # Otherwise a local `.env` holding `OPENAI_API_KEY="test"` would redact the word
        # "test" out of every message, and the logs would be useless.
        monkeypatch.setattr(settings, "OPENAI_API_KEY", "test")

        assert redact("this is a test of the system") == "this is a test of the system"

    def test_none_becomes_an_empty_string(self, no_credentials):
        # So a caller can pass an absent cause without branching.
        assert redact(None) == ""


class TestFormattedProviderErrorsAreSafe:
    """End-to-end: a real `ProviderError` rendered the way the service renders it."""

    def test_a_redacted_provider_message_survives_rendering(
        self, no_credentials, monkeypatch
    ):
        monkeypatch.setattr(settings, "OPENROUTER_API_KEY", SHAPELESS_CREDENTIAL)
        prompt = "my card number is 4111 1111 1111 1111"

        err = ProviderError(ProviderErrorKind.AUTH, provider="openrouter", model_id="m")
        err.cause = Exception(
            f"Incorrect API key provided: {SHAPELESS_CREDENTIAL}. "
            f"Query was: {prompt}"
        )

        rendered = _TEXT.format(
            _record(
                "OpenRouter call failed: AUTH",
                **format_log_context(
                    operation="provider_generate",
                    provider=err.provider,
                    model_id=err.model_id,
                    kind=err.kind.value,
                    fault=err.fault.value,
                    provider_message=redact(
                        str(err.cause), redact_also=(prompt,)
                    ),
                ),
            )
        )

        assert SHAPELESS_CREDENTIAL not in rendered
        assert "4111" not in rendered
        # ...and the diagnostic itself survived, or the assertions above would be vacuous.
        assert "Incorrect API key provided" in rendered
        assert "fault=ours" in rendered
