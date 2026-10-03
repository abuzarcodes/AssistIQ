"""Contract tests for the catalog adapters added on top of OpenRouter.

`test_openrouter.py` is the reference: it pins one adapter's behaviour and, more
importantly, its *disclosure* obligations. This file generalises that second part across
OpenAI, Groq, Gemini and the generic OpenAI-compatible slot.

They are parameterised rather than copied four times because the four adapters genuinely
share one contract — `run_completion` in `openai_wire.py` is a single implementation, and
four near-identical test files would drift apart while claiming to test the same thing.
What differs per adapter is data: which SDK module to fake, which keyword carries the
credential, which carries the timeout. That is the table below.

No test here touches the network. Each vendor SDK is replaced at the module boundary, and
the tests that claim "no call was made" assert on the seam rather than trusting it.
"""

import logging
import sys
import types
from dataclasses import dataclass, field
from typing import ClassVar

import pytest

from app.core.config import Settings, settings
from app.core.logging import ContextFormatter
from app.core.redaction import PLACEHOLDER
from app.providers import ProviderError, ProviderErrorKind, get_provider, registered_slugs
from app.providers.gemini import GeminiProvider
from app.providers.groq import GroqProvider
from app.providers.openai import OpenAIProvider
from app.providers.openai_compatible import OpenAICompatibleProvider

# A credential-shaped string per adapter. If an assertion ever matches one of these, the
# assertion is telling us the key leaked.
FAKE_KEY = "sk-test-0123456789abcdef0123456789abcdef"

#: Renders records the way the service does. `caplog.text` cannot be used for the context
#: assertions below: pytest formats captured records with its own formatter, which renders
#: only `%(message)s`, so a credential sitting in a `provider_message` field would be
#: invisible to it and the assertion would pass regardless.
_FORMATTER = ContextFormatter(style="text", datefmt="%Y-%m-%d %H:%M:%S")


def _render(records) -> str:
    return "\n".join(_FORMATTER.format(record) for record in records)

#: Every slug the registry is expected to ship, and therefore every `ai_providers` slug the
#: seed must contain. Spelled out rather than derived: this is the contract between
#: `registry._BUILTIN_MODULES`, `prisma/seed.ts`, and the descriptor Node sends, and a
#: change to any one of the three should fail here first.
EXPECTED_SLUGS = ["gemini", "groq", "openai", "openai_compatible", "openrouter"]


@dataclass(frozen=True)
class AdapterSpec:
    """Everything that differs between the four OpenAI-wire or vendor adapters."""

    name: str
    provider: object
    sdk_module: str
    client_class: str
    #: Settings attribute holding the credential.
    key_attr: str
    #: Keyword the credential is passed to the SDK under. Gemini is the odd one out.
    key_kwarg: str
    #: Settings attribute and SDK keyword for the request timeout.
    timeout_attr: str
    timeout_kwarg: str
    #: Settings the adapter must also see, as attribute -> value.
    extra_settings: dict = field(default_factory=dict)
    #: The generic slot is unusable without an endpoint, so its `is_configured` is an AND.
    requires_base_url: bool = False


SPECS = [
    AdapterSpec(
        name="openai",
        provider=OpenAIProvider(),
        sdk_module="langchain_openai",
        client_class="ChatOpenAI",
        key_attr="OPENAI_API_KEY",
        key_kwarg="api_key",
        timeout_attr="OPENAI_REQUEST_TIMEOUT",
        timeout_kwarg="request_timeout",
        extra_settings={"OPENAI_BASE_URL": "https://api.openai.com/v1"},
    ),
    AdapterSpec(
        name="groq",
        provider=GroqProvider(),
        sdk_module="langchain_groq",
        client_class="ChatGroq",
        key_attr="GROQ_API_KEY",
        key_kwarg="api_key",
        timeout_attr="GROQ_REQUEST_TIMEOUT",
        timeout_kwarg="request_timeout",
        # The host, not the OpenAI-compatible base — see `TestTheGroqRequestUrl`.
        extra_settings={"GROQ_BASE_URL": "https://api.groq.com"},
    ),
    AdapterSpec(
        name="gemini",
        provider=GeminiProvider(),
        sdk_module="langchain_google_genai",
        client_class="ChatGoogleGenerativeAI",
        key_attr="GEMINI_API_KEY",
        # The Gemini SDK's own keyword — not `api_key`.
        key_kwarg="google_api_key",
        timeout_attr="GEMINI_REQUEST_TIMEOUT",
        # ...and its own timeout keyword.
        timeout_kwarg="timeout",
    ),
    AdapterSpec(
        name="openai_compatible",
        provider=OpenAICompatibleProvider(),
        sdk_module="langchain_openai",
        client_class="ChatOpenAI",
        key_attr="OPENAI_COMPATIBLE_API_KEY",
        key_kwarg="api_key",
        timeout_attr="OPENAI_COMPATIBLE_REQUEST_TIMEOUT",
        timeout_kwarg="request_timeout",
        extra_settings={"OPENAI_COMPATIBLE_BASE_URL": "https://gateway.internal/v1"},
        requires_base_url=True,
    ),
]

SPEC_IDS = [spec.name for spec in SPECS]


class RecordingChat:
    """Stands in for whichever vendor chat class the adapter under test constructs.

    Patched into `sys.modules` rather than onto the real class, so importing it costs
    nothing and cannot reach the network if an argument is wrong.

    `next_error` / `next_content` are **class**-level because each `generate` call builds a
    fresh client. Priming `instances[-1]` would arm a client the next call never uses — a
    mistake that reads as "the error was never raised".
    """

    instances: ClassVar[list] = []
    next_error: ClassVar[BaseException | None] = None
    next_content: ClassVar[object] = "a completion"

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.invocations: list = []
        self.raise_on_invoke = RecordingChat.next_error
        self.content = RecordingChat.next_content
        RecordingChat.instances.append(self)

    async def ainvoke(self, messages):
        self.invocations.append(messages)
        if self.raise_on_invoke is not None:
            raise self.raise_on_invoke
        return types.SimpleNamespace(content=self.content)


@pytest.fixture
def configured(monkeypatch):
    """Pin every credential, so the suite behaves the same on a machine with a real .env.

    Returns the spec-keyed map of fake keys that disclosure tests assert against.
    """
    keys = {}
    for spec in SPECS:
        monkeypatch.setattr(settings, spec.key_attr, FAKE_KEY)
        monkeypatch.setattr(settings, spec.timeout_attr, 12.5)
        for attr, value in spec.extra_settings.items():
            monkeypatch.setattr(settings, attr, value)
        keys[spec.name] = FAKE_KEY
    return keys


@pytest.fixture
def fake_sdks(monkeypatch):
    """Install a fake vendor module for each adapter and reset recorded state."""
    RecordingChat.instances = []
    RecordingChat.next_error = None
    RecordingChat.next_content = "a completion"

    module = types.ModuleType("langchain_openai")
    module.ChatOpenAI = RecordingChat
    monkeypatch.setitem(sys.modules, "langchain_openai", module)

    groq = types.ModuleType("langchain_groq")
    groq.ChatGroq = RecordingChat
    monkeypatch.setitem(sys.modules, "langchain_groq", groq)

    genai = types.ModuleType("langchain_google_genai")
    genai.ChatGoogleGenerativeAI = RecordingChat
    monkeypatch.setitem(sys.modules, "langchain_google_genai", genai)

    return module


class FakeAPIError(Exception):
    """Mirrors the two attribute layouts the SDKs use for a status."""

    def __init__(self, status_code=None, response=None):
        super().__init__("upstream said no")
        if status_code is not None:
            self.status_code = status_code
        if response is not None:
            self.response = response


class LeakyAPIError(Exception):
    """A vendor error that echoes back what it was sent.

    Not a contrived shape. OpenAI's own auth failure reads
    ``Incorrect API key provided: sk-...``, and providers routinely quote the request in a
    400. `FakeAPIError`'s fixed "upstream said no" is exactly why the disclosure tests could
    not previously catch a leak in a context field: nothing they raised ever contained a key.
    """

    def __init__(self, message, status_code=401):
        super().__init__(message)
        self.status_code = status_code


class TestRegistryContract:
    def test_the_catalog_ships_exactly_these_slugs(self):
        # The list is the contract with `prisma/seed.ts` and with Node's descriptors. A
        # change here without a matching seed row is a provider nobody can select.
        assert registered_slugs() == EXPECTED_SLUGS

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    def test_each_adapter_resolves_by_slug(self, spec):
        provider = get_provider(spec.name)

        assert provider.slug == spec.name
        assert isinstance(provider.is_configured, bool)

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    def test_lookup_returns_a_singleton(self, spec):
        assert get_provider(spec.name) is get_provider(spec.name)


class TestConfigurationState:
    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    def test_configured_reflects_a_present_key(self, spec, configured):
        assert spec.provider.is_configured is True

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    def test_unconfigured_reflects_an_absent_key(self, spec, monkeypatch):
        monkeypatch.setattr(settings, spec.key_attr, "")
        if spec.requires_base_url:
            monkeypatch.setattr(settings, "OPENAI_COMPATIBLE_BASE_URL", "https://x/v1")

        assert spec.provider.is_configured is False

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    def test_whitespace_only_key_counts_as_absent(self, spec, monkeypatch):
        # A key of spaces is a misconfiguration, not a credential.
        monkeypatch.setattr(settings, spec.key_attr, "   \n\t ")
        if spec.requires_base_url:
            monkeypatch.setattr(settings, "OPENAI_COMPATIBLE_BASE_URL", "https://x/v1")

        assert spec.provider.is_configured is False

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    def test_is_configured_makes_no_network_call(self, spec, monkeypatch, fake_sdks):
        monkeypatch.setattr(settings, spec.key_attr, "")

        assert spec.provider.is_configured is False
        assert RecordingChat.instances == []


class TestOpenAICompatibleNeedsBothHalves:
    """The generic slot is the one adapter with a two-part readiness rule."""

    def test_a_base_url_alone_is_not_configured(self, monkeypatch):
        monkeypatch.setattr(settings, "OPENAI_COMPATIBLE_BASE_URL", "https://gateway/v1")
        monkeypatch.setattr(settings, "OPENAI_COMPATIBLE_API_KEY", "")

        assert OpenAICompatibleProvider().is_configured is False

    def test_a_key_alone_is_not_configured(self, monkeypatch):
        # Without an endpoint there is no provider to call, so reporting "configured"
        # would send an operator looking for a fault that is really a missing setting.
        monkeypatch.setattr(settings, "OPENAI_COMPATIBLE_BASE_URL", "")
        monkeypatch.setattr(settings, "OPENAI_COMPATIBLE_API_KEY", FAKE_KEY)

        assert OpenAICompatibleProvider().is_configured is False

    def test_whitespace_only_base_url_is_absent(self, monkeypatch):
        monkeypatch.setattr(settings, "OPENAI_COMPATIBLE_BASE_URL", "   ")
        monkeypatch.setattr(settings, "OPENAI_COMPATIBLE_API_KEY", FAKE_KEY)

        assert OpenAICompatibleProvider().is_configured is False

    def test_both_present_is_configured(self, configured):
        assert OpenAICompatibleProvider().is_configured is True


class TestUnconfiguredBehaviour:
    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_raises_not_configured(self, spec, monkeypatch):
        monkeypatch.setattr(settings, spec.key_attr, "")

        with pytest.raises(ProviderError) as excinfo:
            await spec.provider.generate(prompt="hello", model_id="some-model")

        assert excinfo.value.kind is ProviderErrorKind.NOT_CONFIGURED

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_makes_no_network_call_and_builds_no_client(self, spec, monkeypatch, fake_sdks):
        monkeypatch.setattr(settings, spec.key_attr, "")

        with pytest.raises(ProviderError):
            await spec.provider.generate(prompt="hello", model_id="m")

        # The docstring's claim — that a missing key costs no round trip — asserted at the
        # seam rather than trusted.
        assert RecordingChat.instances == []

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_the_failure_names_the_provider_and_model(self, spec, monkeypatch):
        monkeypatch.setattr(settings, spec.key_attr, "")

        with pytest.raises(ProviderError) as excinfo:
            await spec.provider.generate(prompt="hello", model_id="some-model")

        assert excinfo.value.provider == spec.name
        assert excinfo.value.model_id == "some-model"


class TestRequestConstruction:
    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_model_id_and_temperature_reach_the_sdk(self, spec, configured, fake_sdks):
        await spec.provider.generate(prompt="hello", model_id="vendor/model-1", temperature=0.3)

        client = RecordingChat.instances[-1]
        assert client.kwargs["model"] == "vendor/model-1"
        assert client.kwargs["temperature"] == 0.3

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_retries_are_disabled(self, spec, configured, fake_sdks):
        # Node's failure policy owns retries; a hidden loop here would multiply spend and
        # stretch the request past the caller's own timeout.
        await spec.provider.generate(prompt="hello", model_id="m")

        assert RecordingChat.instances[-1].kwargs["max_retries"] == 0

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_the_timeout_comes_from_settings(self, spec, configured, fake_sdks):
        await spec.provider.generate(prompt="hello", model_id="m")

        # Asserted under each SDK's own keyword, because the Gemini SDK does not use the
        # OpenAI-wire spelling.
        assert RecordingChat.instances[-1].kwargs[spec.timeout_kwarg] == 12.5

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_system_message_is_sent_only_when_present(self, spec, configured, fake_sdks):
        await spec.provider.generate(prompt="hello", model_id="m", system_message="be brief")
        with_system = RecordingChat.instances[0].invocations[0]

        await spec.provider.generate(prompt="hello", model_id="m", system_message=None)
        without_system = RecordingChat.instances[1].invocations[0]

        assert [type(m).__name__ for m in with_system] == ["SystemMessage", "HumanMessage"]
        assert [type(m).__name__ for m in without_system] == ["HumanMessage"]

    @pytest.mark.asyncio
    async def test_the_generic_slot_sends_the_configured_base_url(self, configured, fake_sdks):
        await OpenAICompatibleProvider().generate(prompt="hello", model_id="m")

        assert RecordingChat.instances[-1].kwargs["base_url"] == "https://gateway.internal/v1"


class TestFailurePropagation:
    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_a_429_becomes_a_rate_limit_error(self, spec, configured, fake_sdks):
        RecordingChat.next_error = FakeAPIError(status_code=429)

        with pytest.raises(ProviderError) as excinfo:
            await spec.provider.generate(prompt="hello", model_id="m")

        assert excinfo.value.kind is ProviderErrorKind.RATE_LIMIT
        assert excinfo.value.provider_status == 429

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_a_401_becomes_an_auth_error(self, spec, configured, fake_sdks):
        RecordingChat.next_error = FakeAPIError(status_code=401)

        with pytest.raises(ProviderError) as excinfo:
            await spec.provider.generate(prompt="hello", model_id="m")

        assert excinfo.value.kind is ProviderErrorKind.AUTH

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_a_5xx_becomes_an_upstream_error(self, spec, configured, fake_sdks):
        RecordingChat.next_error = FakeAPIError(status_code=503)

        with pytest.raises(ProviderError) as excinfo:
            await spec.provider.generate(prompt="hello", model_id="m")

        assert excinfo.value.kind is ProviderErrorKind.UPSTREAM

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_a_timeout_maps_to_timeout(self, spec, configured, fake_sdks):
        RecordingChat.next_error = TimeoutError("too slow")

        with pytest.raises(ProviderError) as excinfo:
            await spec.provider.generate(prompt="hello", model_id="m")

        assert excinfo.value.kind is ProviderErrorKind.TIMEOUT

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_a_client_construction_failure_is_also_classified(
        self, spec, configured, monkeypatch
    ):
        # A bad base URL or an incompatible SDK surfaces at construction, not at invoke.
        # This is why `openai_wire.run_completion` takes a callable rather than a client.
        class Exploding:
            def __init__(self, **kwargs):
                raise FakeAPIError(status_code=400)

        module = types.ModuleType(spec.sdk_module)
        setattr(module, spec.client_class, Exploding)
        monkeypatch.setitem(sys.modules, spec.sdk_module, module)

        with pytest.raises(ProviderError) as excinfo:
            await spec.provider.generate(prompt="hello", model_id="m")

        assert excinfo.value.kind is ProviderErrorKind.BAD_REQUEST


class TestTheRealSdkAcceptsOurArguments:
    """The one place these tests deliberately touch the real vendor SDKs.

    Everywhere else the SDK is faked, which is what keeps the suite offline. But a fake
    accepts any keyword it is handed, so it cannot tell us whether `ChatGroq` really
    spells its timeout `request_timeout` or whether `ChatGoogleGenerativeAI` really takes
    `google_api_key`. LangChain chat models are pydantic models, and an unknown field is
    frequently *ignored* rather than rejected — so a wrong keyword name would not fail a
    test, would not raise at runtime, and would simply mean a setting never took effect.

    Constructing a chat model performs no I/O: the client is built lazily on first call.
    This asserts the arguments are accepted, and nothing more.
    """

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    def test_the_client_accepts_the_keywords_this_adapter_passes(self, spec):
        module = pytest.importorskip(
            spec.sdk_module, reason=f"{spec.sdk_module} is not installed"
        )
        client_class = getattr(module, spec.client_class)

        # Raises if any keyword is misspelled or unsupported.
        client_class(
            model="some-model",
            temperature=0.0,
            max_retries=0,
            **{spec.key_kwarg: FAKE_KEY, spec.timeout_kwarg: 12.5},
        )


class TestTheGroqRequestUrl:
    """The URL `groq`'s SDK actually builds — which a right-*looking* base URL is not enough to get right.

    `groq` hardcodes its completions path as ``/openai/v1/chat/completions`` and defaults its
    base URL to ``https://api.groq.com``. So the base this adapter hands it must be the **host**.
    Handing it the OpenAI-compatible ``https://api.groq.com/openai/v1`` that the other four
    adapters use makes the SDK prepend its own prefix as well, and the request goes to
    ``/openai/v1/openai/v1/chat/completions`` — a 404 for a URL nobody wrote.

    This is easy to get wrong precisely because the openai-shaped value looks correct: it is
    exactly what `ChatOpenAI` wants, and `ChatGroq` accepts it without complaint. Only the real
    SDK, making a real request, can settle it — so this splices a recording transport into the
    real client and reads back the URL it asked for.
    """

    @pytest.mark.asyncio
    async def test_the_request_url_has_a_single_openai_v1_prefix(
        self, configured, monkeypatch
    ):
        groq_sdk = pytest.importorskip(
            "langchain_groq", reason="langchain_groq is not installed"
        )
        httpx = pytest.importorskip("httpx", reason="httpx is not installed")
        seen: dict = {}

        def record(request):
            seen["url"] = str(request.url)
            # Refusing the call is the point: it ends the request here, so the test needs
            # neither a network round trip nor a faithfully-shaped success body.
            return httpx.Response(401, json={"error": {"message": "recorded"}})

        class RecordingTransportChatGroq(groq_sdk.ChatGroq):
            def __init__(self, **kwargs):
                kwargs["http_async_client"] = httpx.AsyncClient(
                    transport=httpx.MockTransport(record)
                )
                super().__init__(**kwargs)

        monkeypatch.setattr(groq_sdk, "ChatGroq", RecordingTransportChatGroq)

        with pytest.raises(ProviderError):
            await GroqProvider().generate(prompt="hello", model_id="m")

        assert seen["url"] == "https://api.groq.com/openai/v1/chat/completions"

    def test_the_default_base_is_the_host_the_sdk_expects(self):
        # Read from the field default rather than `Settings()`, which would pick up this
        # machine's `.env`. The question is what a deployment that sets nothing gets.
        assert Settings.model_fields["GROQ_BASE_URL"].default == "https://api.groq.com"


class TestContentNormalisation:
    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_a_string_body_is_returned_as_is(self, spec, configured, fake_sdks):
        RecordingChat.next_content = "plain answer"

        assert await spec.provider.generate(prompt="hello", model_id="m") == "plain answer"

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_a_list_body_is_flattened(self, spec, configured, fake_sdks):
        # Gemini in particular returns content as a list of parts.
        RecordingChat.next_content = [
            {"type": "text", "text": "part one "},
            {"type": "text", "text": "part two"},
        ]

        assert await spec.provider.generate(prompt="hello", model_id="m") == "part one part two"

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_an_empty_list_body_yields_an_empty_string(self, spec, configured, fake_sdks):
        RecordingChat.next_content = []

        assert await spec.provider.generate(prompt="hello", model_id="m") == ""


class TestCredentialIsNeverDisclosed:
    """The disclosure tests. These are the reason this file exists.

    Four new providers means four new chances to leak a key into a log line, an exception
    payload or a response body — and the platform dashboard renders the response of the
    endpoint these feed.
    """

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_the_key_is_sent_to_the_sdk_and_nowhere_else(self, spec, configured, fake_sdks):
        await spec.provider.generate(prompt="hello", model_id="m")

        assert RecordingChat.instances[-1].kwargs[spec.key_kwarg] == FAKE_KEY

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_the_key_never_appears_in_a_log_record(
        self, spec, configured, fake_sdks, caplog
    ):
        RecordingChat.next_error = FakeAPIError(status_code=401)

        with caplog.at_level(logging.DEBUG), pytest.raises(ProviderError):
            await spec.provider.generate(prompt="hello", model_id="m")

        assert FAKE_KEY not in caplog.text
        assert "sk-test" not in caplog.text

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_a_provider_that_echoes_the_key_has_it_redacted_from_the_log(
        self, spec, configured, fake_sdks, caplog
    ):
        """The version of the test above that can actually fail.

        The adapters now log the provider's own error text, because that text is the only
        thing distinguishing a revoked key from a bad model id from an outage. This asserts
        the redaction that makes it safe, on the text the formatter really produces — and
        also asserts the diagnostic survived, since a test that only proves absence would
        pass just as happily if nothing were logged at all.
        """
        prompt = "my card number is 4111 1111 1111 1111"
        RecordingChat.next_error = LeakyAPIError(
            f"Incorrect API key provided: {FAKE_KEY}. Query was: {prompt}"
        )

        with caplog.at_level(logging.DEBUG), pytest.raises(ProviderError):
            await spec.provider.generate(prompt=prompt, model_id="m")

        rendered = _render(caplog.records)
        assert FAKE_KEY not in rendered
        assert "sk-test" not in rendered
        assert "4111" not in rendered
        # Belt and braces: not just unrendered, but absent from the records entirely.
        assert not any(
            FAKE_KEY in str(value)
            for record in caplog.records
            for value in record.__dict__.values()
        )

        assert "Incorrect API key provided" in rendered
        assert "fault=ours" in rendered

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_a_key_with_no_vendor_prefix_is_still_removed_by_value(
        self, spec, configured, fake_sdks, caplog, monkeypatch
    ):
        """The same guarantee for a credential the shape rules cannot recognise.

        The test above uses a ``sk-`` key, which the *shape* rule removes whether or not
        value redaction works — it would stay green with the by-value pass broken, and did
        when that pass was deliberately broken during review. This configures a key with no
        vendor prefix, so the only thing that can remove it is comparing against the value
        we hold, which is the pass that works against a real key whose format we cannot
        predict.
        """
        shapeless = "9f4c1e7a2b8d0356e1c9a4f7b2d8e0c3"
        monkeypatch.setattr(settings, spec.key_attr, shapeless)
        RecordingChat.next_error = LeakyAPIError(
            f"Incorrect API key provided: {shapeless}"
        )

        with caplog.at_level(logging.DEBUG), pytest.raises(ProviderError):
            await spec.provider.generate(prompt="hello", model_id="m")

        rendered = _render(caplog.records)
        assert shapeless not in rendered
        assert PLACEHOLDER in rendered
        # ...and the diagnostic survived, so the assertion above is not vacuous.
        assert "Incorrect API key provided" in rendered

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_the_key_never_appears_in_the_unconfigured_log(
        self, spec, monkeypatch, caplog
    ):
        monkeypatch.setattr(settings, spec.key_attr, "")

        with caplog.at_level(logging.DEBUG), pytest.raises(ProviderError):
            await spec.provider.generate(prompt="hello", model_id="m")

        assert "sk-test" not in caplog.text

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_the_prompt_never_appears_in_a_log_record(
        self, spec, configured, fake_sdks, caplog
    ):
        RecordingChat.next_error = FakeAPIError(status_code=500)

        with caplog.at_level(logging.DEBUG), pytest.raises(ProviderError):
            await spec.provider.generate(
                prompt="my card number is 4111 1111 1111 1111", model_id="m"
            )

        assert "4111" not in caplog.text

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_the_error_details_carry_no_credential_derived_value(
        self, spec, configured, fake_sdks
    ):
        RecordingChat.next_error = FakeAPIError(status_code=401)

        with pytest.raises(ProviderError) as excinfo:
            await spec.provider.generate(prompt="hello", model_id="m")

        serialised = repr(excinfo.value.details)
        assert FAKE_KEY not in serialised
        assert "sk-test" not in serialised
        assert "key" not in serialised.lower()

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_the_error_message_is_a_fixed_string_not_the_upstream_text(
        self, spec, configured, fake_sdks
    ):
        RecordingChat.next_error = FakeAPIError(status_code=401)

        with pytest.raises(ProviderError) as excinfo:
            await spec.provider.generate(prompt="hello", model_id="m")

        # Upstream error text can echo the request URL and headers. The message is one of
        # the fixed strings in `base.py` and interpolates nothing.
        assert excinfo.value.message == "The provider rejected the credentials."
        assert "upstream said no" not in excinfo.value.message

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_the_underlying_exception_is_retained_for_logs_only(
        self, spec, configured, fake_sdks
    ):
        original = FakeAPIError(status_code=500)
        RecordingChat.next_error = original

        with pytest.raises(ProviderError) as excinfo:
            await spec.provider.generate(prompt="hello", model_id="m")

        assert excinfo.value.cause is original

    @pytest.mark.parametrize("spec", SPECS, ids=SPEC_IDS)
    @pytest.mark.asyncio
    async def test_an_auth_failure_is_an_error_and_a_throttle_is_a_warning(
        self, spec, configured, fake_sdks, caplog
    ):
        RecordingChat.next_error = FakeAPIError(status_code=401)
        with caplog.at_level(logging.DEBUG), pytest.raises(ProviderError):
            await spec.provider.generate(prompt="hello", model_id="m")
        auth_level = caplog.records[-1].levelno

        RecordingChat.next_error = FakeAPIError(status_code=429)
        caplog.clear()
        with caplog.at_level(logging.DEBUG), pytest.raises(ProviderError):
            await spec.provider.generate(prompt="hello", model_id="m")
        throttle_level = caplog.records[-1].levelno

        # A rejected credential is a configuration fault demanding action; a throttle is
        # worth knowing about and nothing more.
        assert auth_level == logging.ERROR
        assert throttle_level == logging.WARNING
