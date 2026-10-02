"""Tests for the OpenRouter adapter and the status endpoint's adapter reporting.

Two things are being pinned here and they are different in kind.

The first is **behaviour**: which `ProviderError.kind` each provider failure produces,
what reaches the SDK, and how a message body is flattened.

The second is **disclosure**: that a credential cannot escape through this code path.
Those tests capture logs and inspect response bodies, and they are not decoration —
`GET /ai/status` is rendered in a browser, and the log is a file an operator shares.

No test here touches the network. `ChatOpenAI` is replaced at the module boundary, and
the one test that proves an unconfigured adapter makes no call asserts on the seam
rather than trusting it.
"""

import logging
import sys
import types
from typing import ClassVar

import pytest

from app.core.config import settings
from app.providers import ProviderError, ProviderErrorKind, get_provider, registered_slugs
from app.providers.openrouter import OpenRouterProvider, classify_error

# A credential-shaped string. If any assertion in this file ever matches on it, the
# assertion is telling us the key leaked.
FAKE_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"


@pytest.fixture
def configured(monkeypatch):
    """Pin a credential so the adapter is in its configured state.

    Set explicitly rather than inherited: the suite must behave identically on a machine
    whose `.env` holds a real key and on one where it is empty.
    """
    monkeypatch.setattr(settings, "OPENROUTER_API_KEY", FAKE_KEY)
    monkeypatch.setattr(settings, "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setattr(settings, "OPENROUTER_REQUEST_TIMEOUT", 12.5)
    monkeypatch.setattr(settings, "OPENROUTER_SITE_URL", "https://assistiq.example")
    monkeypatch.setattr(settings, "OPENROUTER_APP_NAME", "AssistIQ Test")


@pytest.fixture
def unconfigured(monkeypatch):
    monkeypatch.setattr(settings, "OPENROUTER_API_KEY", "")


class FakeChatOpenAI:
    """Stands in for `langchain_openai.ChatOpenAI`.

    Patched into `sys.modules` rather than onto the real class so that importing it costs
    nothing and cannot accidentally reach the network if an argument is wrong.

    `next_error` / `next_content` are **class**-level because each `generate` call builds
    a fresh client. Priming `instances[-1]` would arm a client that the next call never
    uses — a mistake that reads as "the error was never raised".
    """

    instances: ClassVar[list["FakeChatOpenAI"]] = []
    next_error: ClassVar[BaseException | None] = None
    next_content: ClassVar[object] = "a completion"

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.invocations: list = []
        self.raise_on_invoke = FakeChatOpenAI.next_error
        self.content = FakeChatOpenAI.next_content
        FakeChatOpenAI.instances.append(self)

    async def ainvoke(self, messages):
        self.invocations.append(messages)
        if self.raise_on_invoke is not None:
            raise self.raise_on_invoke
        return types.SimpleNamespace(content=self.content)


@pytest.fixture
def fake_sdk(monkeypatch):
    """Install the fake `langchain_openai` module and reset recorded instances."""
    FakeChatOpenAI.instances = []
    FakeChatOpenAI.next_error = None
    FakeChatOpenAI.next_content = "a completion"
    module = types.ModuleType("langchain_openai")
    module.ChatOpenAI = FakeChatOpenAI
    monkeypatch.setitem(sys.modules, "langchain_openai", module)
    return module


@pytest.fixture
def last_client() -> FakeChatOpenAI:
    assert FakeChatOpenAI.instances, "no ChatOpenAI was constructed"
    return FakeChatOpenAI.instances[-1]


class FakeAPIError(Exception):
    """Mirrors the two attribute layouts the SDK uses for a status."""

    def __init__(self, status_code=None, response=None):
        super().__init__("upstream said no")
        if status_code is not None:
            self.status_code = status_code
        if response is not None:
            self.response = response


class TestRegistryIntegration:
    def test_openrouter_is_registered(self):
        assert "openrouter" in registered_slugs()

    def test_get_provider_returns_a_configured_aware_adapter(self):
        provider = get_provider("openrouter")

        assert provider.slug == "openrouter"
        assert isinstance(provider.is_configured, bool)

    def test_the_registry_returns_a_singleton_not_a_fresh_adapter(self):
        # The adapter is stateless, but a fresh instance per lookup would still be a
        # surprise; registering at import time makes identity stable.
        assert get_provider("openrouter") is get_provider("openrouter")


class TestConfigurationState:
    def test_configured_reflects_a_present_key(self, configured):
        assert OpenRouterProvider().is_configured is True

    def test_unconfigured_reflects_an_absent_key(self, unconfigured):
        assert OpenRouterProvider().is_configured is False

    def test_whitespace_only_key_counts_as_absent(self, monkeypatch):
        # A key of spaces is a misconfiguration, not a credential.
        monkeypatch.setattr(settings, "OPENROUTER_API_KEY", "   \n\t ")

        assert OpenRouterProvider().is_configured is False

    def test_is_configured_makes_no_network_call(self, unconfigured, fake_sdk):
        # Reading the property is the whole test; it must not construct a client.
        assert OpenRouterProvider().is_configured is False
        assert FakeChatOpenAI.instances == []


class TestUnconfiguredBehaviour:
    @pytest.mark.asyncio
    async def test_raises_not_configured(self, unconfigured):
        with pytest.raises(ProviderError) as excinfo:
            await OpenRouterProvider().generate(prompt="hello", model_id="openai/gpt-4o-mini")

        assert excinfo.value.kind is ProviderErrorKind.NOT_CONFIGURED

    @pytest.mark.asyncio
    async def test_makes_no_network_call_and_builds_no_client(self, unconfigured, fake_sdk):
        with pytest.raises(ProviderError):
            await OpenRouterProvider().generate(prompt="hello", model_id="m")

        # The claim in the docstring — that a missing key costs no round trip — asserted
        # at the seam rather than trusted.
        assert FakeChatOpenAI.instances == []

    @pytest.mark.asyncio
    async def test_the_failure_names_the_provider_and_model(self, unconfigured):
        with pytest.raises(ProviderError) as excinfo:
            await OpenRouterProvider().generate(prompt="hello", model_id="openai/gpt-4o-mini")

        assert excinfo.value.provider == "openrouter"
        assert excinfo.value.model_id == "openai/gpt-4o-mini"


class TestRequestConstruction:
    @pytest.mark.asyncio
    async def test_model_id_and_temperature_reach_the_sdk(self, configured, fake_sdk):
        await OpenRouterProvider().generate(
            prompt="hello", model_id="anthropic/claude-sonnet-4", temperature=0.3
        )

        client = FakeChatOpenAI.instances[-1]
        assert client.kwargs["model"] == "anthropic/claude-sonnet-4"
        assert client.kwargs["temperature"] == 0.3

    @pytest.mark.asyncio
    async def test_retries_are_disabled(self, configured, fake_sdk):
        # Node's failure policy owns retries; a hidden loop here would multiply spend.
        await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert FakeChatOpenAI.instances[-1].kwargs["max_retries"] == 0

    @pytest.mark.asyncio
    async def test_timeout_and_base_url_come_from_settings(self, configured, fake_sdk):
        await OpenRouterProvider().generate(prompt="hello", model_id="m")

        client = FakeChatOpenAI.instances[-1]
        assert client.kwargs["request_timeout"] == 12.5
        assert client.kwargs["base_url"] == "https://openrouter.ai/api/v1"

    @pytest.mark.asyncio
    async def test_attribution_headers_are_sent_when_configured(self, configured, fake_sdk):
        await OpenRouterProvider().generate(prompt="hello", model_id="m")

        headers = FakeChatOpenAI.instances[-1].kwargs["default_headers"]
        assert headers == {
            "HTTP-Referer": "https://assistiq.example",
            "X-Title": "AssistIQ Test",
        }

    @pytest.mark.asyncio
    async def test_attribution_headers_are_omitted_when_blank(self, monkeypatch, configured, fake_sdk):
        monkeypatch.setattr(settings, "OPENROUTER_SITE_URL", "")
        monkeypatch.setattr(settings, "OPENROUTER_APP_NAME", "   ")

        await OpenRouterProvider().generate(prompt="hello", model_id="m")

        # `None` rather than an empty dict, so the SDK does not receive a header block it
        # would merge as blank keys.
        assert FakeChatOpenAI.instances[-1].kwargs["default_headers"] is None

    @pytest.mark.asyncio
    async def test_system_message_is_sent_only_when_present(self, configured, fake_sdk):
        await OpenRouterProvider().generate(prompt="hello", model_id="m", system_message="be brief")
        with_system = FakeChatOpenAI.instances[0].invocations[0]

        await OpenRouterProvider().generate(prompt="hello", model_id="m", system_message=None)
        without_system = FakeChatOpenAI.instances[1].invocations[0]

        assert [type(m).__name__ for m in with_system] == ["SystemMessage", "HumanMessage"]
        assert [type(m).__name__ for m in without_system] == ["HumanMessage"]


class TestContentNormalisation:
    @pytest.mark.asyncio
    async def test_a_string_body_is_returned_as_is(self, configured, fake_sdk):
        FakeChatOpenAI.next_content = "plain answer"

        result = await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert result == "plain answer"

    @pytest.mark.asyncio
    async def test_a_list_body_is_flattened(self, configured, fake_sdk):
        FakeChatOpenAI.next_content = [
            {"type": "text", "text": "part one "},
            {"type": "text", "text": "part two"},
        ]

        result = await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert result == "part one part two"

    @pytest.mark.asyncio
    async def test_non_dict_list_parts_are_stringified(self, configured, fake_sdk):
        FakeChatOpenAI.next_content = ["bare"]

        result = await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert result == "bare"

    @pytest.mark.asyncio
    async def test_an_empty_list_body_yields_an_empty_string(self, configured, fake_sdk):
        FakeChatOpenAI.next_content = []

        result = await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert result == ""


class TestErrorClassification:
    """Unit-level: the mapping table itself, independent of the SDK."""

    @pytest.mark.parametrize(
        "status,expected",
        [
            (400, ProviderErrorKind.BAD_REQUEST),
            (401, ProviderErrorKind.AUTH),
            (402, ProviderErrorKind.AUTH),
            (403, ProviderErrorKind.AUTH),
            (429, ProviderErrorKind.RATE_LIMIT),
            (500, ProviderErrorKind.UPSTREAM),
            (502, ProviderErrorKind.UPSTREAM),
            (503, ProviderErrorKind.UPSTREAM),
        ],
    )
    def test_statuses_map_to_the_documented_kinds(self, status, expected):
        kind, reported = classify_error(FakeAPIError(status_code=status))

        assert kind is expected
        assert reported == status

    def test_a_timeout_maps_to_timeout(self):
        kind, _ = classify_error(TimeoutError("too slow"))

        assert kind is ProviderErrorKind.TIMEOUT

    def test_a_timeout_wins_over_a_status(self):
        # A provider that returns 504 is UPSTREAM; a client-side timeout has no status at
        # all. When both are present the timeout is the more actionable fact.
        class APITimeoutError(Exception):
            status_code = 504

        kind, _ = classify_error(APITimeoutError())

        assert kind is ProviderErrorKind.TIMEOUT

    def test_an_unrecognised_error_maps_to_unknown(self):
        kind, status = classify_error(RuntimeError("what"))

        assert kind is ProviderErrorKind.UNKNOWN
        assert status is None

    def test_a_status_is_read_from_a_nested_response_object(self):
        # The SDK exposes `status_code` directly on most errors and on `.response` for
        # others; both layouts must classify identically.
        kind, status = classify_error(FakeAPIError(response=types.SimpleNamespace(status_code=429)))

        assert kind is ProviderErrorKind.RATE_LIMIT
        assert status == 429

    def test_a_non_integer_status_is_not_mistaken_for_one(self):
        kind, status = classify_error(FakeAPIError(status_code="429"))

        assert kind is ProviderErrorKind.UNKNOWN
        assert status is None

    def test_an_unmapped_status_is_unknown_not_a_guess(self):
        # 404 is not in the table. A bad model id usually surfaces as 400, so 404 means
        # something we do not have a story for — and inventing one would mislead.
        kind, status = classify_error(FakeAPIError(status_code=404))

        assert kind is ProviderErrorKind.UNKNOWN
        assert status == 404


class TestFailurePropagation:
    @pytest.mark.asyncio
    async def test_a_429_becomes_a_rate_limit_error(self, configured, fake_sdk):
        FakeChatOpenAI.next_error = FakeAPIError(status_code=429)

        with pytest.raises(ProviderError) as excinfo:
            await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert excinfo.value.kind is ProviderErrorKind.RATE_LIMIT
        assert excinfo.value.provider_status == 429

    @pytest.mark.asyncio
    async def test_a_401_becomes_an_auth_error(self, configured, fake_sdk):
        FakeChatOpenAI.next_error = FakeAPIError(status_code=401)

        with pytest.raises(ProviderError) as excinfo:
            await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert excinfo.value.kind is ProviderErrorKind.AUTH

    @pytest.mark.asyncio
    async def test_a_500_becomes_an_upstream_error(self, configured, fake_sdk):
        FakeChatOpenAI.next_error = FakeAPIError(status_code=503)

        with pytest.raises(ProviderError) as excinfo:
            await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert excinfo.value.kind is ProviderErrorKind.UPSTREAM

    @pytest.mark.asyncio
    async def test_the_underlying_exception_is_retained_for_logs_only(self, configured, fake_sdk):
        original = FakeAPIError(status_code=500)
        FakeChatOpenAI.next_error = original

        with pytest.raises(ProviderError) as excinfo:
            await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert excinfo.value.cause is original
        # ...but it must not be rendered. `__cause__` is set by `raise ... from err`, and
        # the *message* is the fixed string, not the upstream text.
        assert "upstream said no" not in excinfo.value.message

    @pytest.mark.asyncio
    async def test_a_client_construction_failure_is_also_classified(self, configured, monkeypatch):
        # A bad base URL or an incompatible SDK surfaces at construction, not at invoke.
        class Exploding:
            def __init__(self, **kwargs):
                raise FakeAPIError(status_code=400)

        module = types.ModuleType("langchain_openai")
        module.ChatOpenAI = Exploding
        monkeypatch.setitem(sys.modules, "langchain_openai", module)

        with pytest.raises(ProviderError) as excinfo:
            await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert excinfo.value.kind is ProviderErrorKind.BAD_REQUEST


class TestCredentialIsNeverDisclosed:
    """The disclosure tests. These are the reason this file exists."""

    @pytest.mark.asyncio
    async def test_the_key_is_sent_to_the_sdk_and_nowhere_else(self, configured, fake_sdk):
        await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert FakeChatOpenAI.instances[-1].kwargs["api_key"] == FAKE_KEY

    @pytest.mark.asyncio
    async def test_the_key_never_appears_in_a_log_record(self, configured, fake_sdk, caplog):
        FakeChatOpenAI.next_error = FakeAPIError(status_code=401)

        with caplog.at_level(logging.DEBUG), pytest.raises(ProviderError):
            await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert FAKE_KEY not in caplog.text
        assert "sk-or" not in caplog.text

    @pytest.mark.asyncio
    async def test_the_key_never_appears_in_the_unconfigured_log(self, unconfigured, caplog):
        with caplog.at_level(logging.DEBUG), pytest.raises(ProviderError):
            await OpenRouterProvider().generate(prompt="hello", model_id="m")

        assert "sk-or" not in caplog.text

    @pytest.mark.asyncio
    async def test_the_prompt_never_appears_in_a_log_record(self, configured, fake_sdk, caplog):
        FakeChatOpenAI.next_error = FakeAPIError(status_code=500)

        with caplog.at_level(logging.DEBUG), pytest.raises(ProviderError):
            await OpenRouterProvider().generate(
                prompt="my card number is 4111 1111 1111 1111", model_id="m"
            )

        assert "4111" not in caplog.text

    @pytest.mark.asyncio
    async def test_the_error_details_carry_no_credential_derived_value(
        self, configured, fake_sdk
    ):
        FakeChatOpenAI.next_error = FakeAPIError(status_code=401)

        with pytest.raises(ProviderError) as excinfo:
            await OpenRouterProvider().generate(prompt="hello", model_id="m")

        serialised = repr(excinfo.value.details)
        assert FAKE_KEY not in serialised
        assert "sk-or" not in serialised
        assert "key" not in serialised.lower()

    @pytest.mark.asyncio
    async def test_the_error_message_is_a_fixed_string_not_the_upstream_text(
        self, configured, fake_sdk
    ):
        FakeChatOpenAI.next_error = FakeAPIError(status_code=401)

        with pytest.raises(ProviderError) as excinfo:
            await OpenRouterProvider().generate(prompt="hello", model_id="m")

        # Upstream error text can echo the request URL and headers. The message is one of
        # the fixed strings in `base.py` and interpolates nothing.
        assert excinfo.value.message == "The provider rejected the credentials."

    @pytest.mark.asyncio
    async def test_logging_an_auth_failure_is_an_error_and_a_throttle_is_a_warning(
        self, configured, fake_sdk, caplog
    ):
        FakeChatOpenAI.next_error = FakeAPIError(status_code=401)
        with caplog.at_level(logging.DEBUG), pytest.raises(ProviderError):
            await OpenRouterProvider().generate(prompt="hello", model_id="m")
        auth_level = caplog.records[-1].levelno

        FakeChatOpenAI.next_error = FakeAPIError(status_code=429)
        caplog.clear()
        with caplog.at_level(logging.DEBUG), pytest.raises(ProviderError):
            await OpenRouterProvider().generate(prompt="hello", model_id="m")
        throttle_level = caplog.records[-1].levelno

        # A rejected credential is a configuration fault demanding action; a throttle is
        # worth knowing about and nothing more.
        assert auth_level == logging.ERROR
        assert throttle_level == logging.WARNING
