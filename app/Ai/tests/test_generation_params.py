"""Generation-parameter passthrough and per-adapter capability filtering (plan §11.4).

Two independent gates decide what a provider call actually contains: Node filters by the
capability it stores on the model, and each adapter filters by what its own SDK accepts. This
module tests the second gate, because it is the one that lives in this service and the one
that cannot be wrong about a vendor SDK.

The rule under test is uniform and is asserted per adapter rather than argued once: a
parameter is sent when it was requested *and* the adapter declares it supports it, and
otherwise it is dropped. Nothing is coerced, substituted, or forwarded "just in case" — a
provider that receives a parameter it does not understand may reject the entire request, so a
dropped parameter is the only safe outcome.
"""

import logging
import sys
import types
from typing import Any, ClassVar, Dict, List, Optional

import pytest

from app.core.config import settings
from app.providers.base import GenerationParams, resolve_temperature
from app.providers.gemini import GEMINI_SUPPORTED_PARAMS, GeminiProvider
from app.providers.groq import GroqProvider
from app.providers.openai import OpenAIProvider
from app.providers.openai_compatible import OpenAICompatibleProvider
from app.providers.openai_wire import OPENAI_WIRE_PARAMS, build_client_kwargs
from app.providers.openrouter import OpenRouterProvider

FAKE_KEY = "test-provider-credential"

#: Every parameter name the layer knows how to send. Used to slice the "generation settings"
#: out of a recorded client's keyword arguments, which also contain the base URL, the model
#: and the credential.
PARAM_NAMES = frozenset({"temperature", "top_p", "frequency_penalty", "presence_penalty", "max_tokens", "max_output_tokens"})

#: The full set a caller may ask for, so every adapter is probed with the same request and
#: the differences between them are the adapters' and not the tests'.
ALL_PARAMS = GenerationParams(
    temperature=0.7,
    top_p=0.9,
    frequency_penalty=0.5,
    presence_penalty=-0.5,
    max_tokens=512,
)


class RecordingChat:
    """Stands in for whichever vendor chat class the adapter under test constructs.

    Patched into `sys.modules`, not onto the real class, so a wrong keyword argument cannot
    reach the network and cannot depend on which SDK version is installed.
    """

    instances: ClassVar[List["RecordingChat"]] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        RecordingChat.instances.append(self)

    async def ainvoke(self, messages):
        return types.SimpleNamespace(content="a completion")


@pytest.fixture
def fake_sdks(monkeypatch):
    """Replace every vendor SDK the adapters import, and reset recorded state."""
    RecordingChat.instances = []

    module = types.ModuleType("langchain_openai")
    module.ChatOpenAI = RecordingChat
    monkeypatch.setitem(sys.modules, "langchain_openai", module)

    groq = types.ModuleType("langchain_groq")
    groq.ChatGroq = RecordingChat
    monkeypatch.setitem(sys.modules, "langchain_groq", groq)

    genai = types.ModuleType("langchain_google_genai")
    genai.ChatGoogleGenerativeAI = RecordingChat
    monkeypatch.setitem(sys.modules, "langchain_google_genai", genai)


@pytest.fixture
def configured(monkeypatch):
    """Pin every credential, so the suite behaves the same on a machine with a real .env."""
    for attr in ("OPENAI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.setattr(settings, attr, FAKE_KEY)
    monkeypatch.setattr(settings, "OPENAI_COMPATIBLE_API_KEY", FAKE_KEY)
    monkeypatch.setattr(settings, "OPENAI_COMPATIBLE_BASE_URL", "https://gateway.internal/v1")


def sent_params(client: RecordingChat) -> Dict[str, Any]:
    """The generation settings that actually reached the client constructor."""
    return {name: value for name, value in client.kwargs.items() if name in PARAM_NAMES}


# ---------------------------------------------------------------------------------------
# The intersection itself
# ---------------------------------------------------------------------------------------


class TestBuildClientKwargs:
    def test_no_params_object_means_no_kwargs(self):
        """`None` is "nothing was configured", not "send the defaults".

        This is the branch the entire unconfigured path relies on, so it is pinned first.
        """
        assert build_client_kwargs(OPENAI_WIRE_PARAMS, None) == {}

    def test_an_all_none_params_object_also_yields_nothing(self):
        """The distinction `None` versus "unset fields" must not matter downstream.

        A configuration exists but specifies no sampling settings — a real and common case,
        since every field defaults to unset. The result has to be the same empty kwargs as
        above, or the two ways of saying "send nothing" would make different requests.
        """
        assert build_client_kwargs(OPENAI_WIRE_PARAMS, GenerationParams()) == {}

    def test_every_supported_parameter_is_passed_through(self):
        """`temperature` is absent here on purpose — it is not part of this intersection.

        It predates the parameter object, so `base.resolve_temperature` owns it and the
        adapters set it explicitly. Asserting its absence pins that ownership: if someone
        later adds it back to `_PARAM_NAMES`, one value would have two writers again.
        """
        kwargs = build_client_kwargs(OPENAI_WIRE_PARAMS, ALL_PARAMS)

        assert kwargs == {
            "top_p": 0.9,
            "frequency_penalty": 0.5,
            "presence_penalty": -0.5,
            "max_tokens": 512,
        }

    def test_an_unsupported_parameter_is_dropped_and_not_substituted(self):
        """Dropped means absent. A provider given a parameter it cannot honour may reject the
        whole request, and inventing a replacement is a decision this layer cannot make."""
        kwargs = build_client_kwargs(GEMINI_SUPPORTED_PARAMS, ALL_PARAMS)

        assert set(kwargs) == {"top_p", "max_tokens"}
        assert "frequency_penalty" not in kwargs
        assert "presence_penalty" not in kwargs

    def test_a_zero_value_is_sent_rather_than_treated_as_absent(self):
        """`0`, `0.0` and `False` are values, not omissions.

        Truthiness is the obvious way to write this filter and it is wrong: `presence_penalty=0`
        is a real setting that means "no penalty". Only `None` means "do not send".
        """
        params = GenerationParams(temperature=0.0, top_p=1.0, frequency_penalty=0.0, presence_penalty=0.0)

        kwargs = build_client_kwargs(OPENAI_WIRE_PARAMS, params)

        assert kwargs == {
            "top_p": 1.0,
            "frequency_penalty": 0.0,
            "presence_penalty": 0.0,
        }

    def test_the_drop_is_logged_at_debug_with_the_field_names(self, caplog):
        with caplog.at_level(logging.DEBUG, logger="assistiq_ai"):
            build_client_kwargs(GEMINI_SUPPORTED_PARAMS, ALL_PARAMS)

        records = [r for r in caplog.records if r.operation == "provider_param_filter"]
        assert len(records) == 1
        assert records[0].levelno == logging.DEBUG
        assert set(records[0].unsupported_params.split(",")) == {"frequency_penalty", "presence_penalty"}

    def test_the_drop_is_not_logged_at_warning_or_above(self, caplog):
        """A capability mismatch is the normal consequence of a model swap.

        Logging it at warning level is how a log stops being read: an operator moving a bot
        from an OpenAI model to a Gemini one would produce a warning per request for a
        configuration that is entirely correct.
        """
        with caplog.at_level(logging.WARNING, logger="assistiq_ai"):
            build_client_kwargs(GEMINI_SUPPORTED_PARAMS, ALL_PARAMS)

        assert [r for r in caplog.records if r.operation == "provider_param_filter"] == []

    def test_a_supported_intersection_logs_nothing_at_all(self, caplog):
        with caplog.at_level(logging.DEBUG, logger="assistiq_ai"):
            build_client_kwargs(OPENAI_WIRE_PARAMS, ALL_PARAMS)

        assert [r for r in caplog.records if r.operation == "provider_param_filter"] == []


# ---------------------------------------------------------------------------------------
# What each adapter actually constructs
# ---------------------------------------------------------------------------------------


WIRE_ADAPTERS = [
    ("openai", OpenAIProvider()),
    ("groq", GroqProvider()),
    ("openrouter", OpenRouterProvider()),
    ("openai_compatible", OpenAICompatibleProvider()),
]
WIRE_IDS = [name for name, _ in WIRE_ADAPTERS]


class TestEachAdapterSendsOnlyWhatItSupports:
    @pytest.mark.parametrize(("name", "provider"), WIRE_ADAPTERS, ids=WIRE_IDS)
    @pytest.mark.asyncio
    async def test_an_openai_wire_adapter_sends_every_parameter(
        self, name, provider, configured, fake_sdks
    ):
        await provider.generate(prompt="hello", model_id="m", params=ALL_PARAMS)

        assert sent_params(RecordingChat.instances[-1]) == {
            "temperature": 0.7,
            "top_p": 0.9,
            "frequency_penalty": 0.5,
            "presence_penalty": -0.5,
            "max_tokens": 512,
        }

    @pytest.mark.parametrize(("name", "provider"), WIRE_ADAPTERS, ids=WIRE_IDS)
    @pytest.mark.asyncio
    async def test_an_openai_wire_adapter_declares_exactly_the_protocol_set(self, name, provider):
        assert provider.supported_params == OPENAI_WIRE_PARAMS

    @pytest.mark.parametrize(("name", "provider"), WIRE_ADAPTERS, ids=WIRE_IDS)
    @pytest.mark.asyncio
    async def test_no_params_means_only_the_temperature_the_protocol_always_sent(
        self, name, provider, configured, fake_sdks
    ):
        """The unconfigured call must be the pre-feature call, for every adapter.

        `temperature` is asserted present rather than absent: it is the one sampling
        parameter this layer sent before this feature, it travels in its own argument, and
        removing it here would change every existing request.
        """
        await provider.generate(prompt="hello", model_id="m")

        assert sent_params(RecordingChat.instances[-1]) == {"temperature": 0.0}

    @pytest.mark.parametrize(("name", "provider"), WIRE_ADAPTERS, ids=WIRE_IDS)
    @pytest.mark.asyncio
    async def test_the_configured_temperature_reaches_the_client(
        self, name, provider, configured, fake_sdks
    ):
        """One value, one wire argument.

        `params.temperature` and the `temperature` argument are both set here to different
        numbers, which is a state the pipeline never produces — it derives both from one
        configuration field. The assertion is that the adapter resolves the ambiguity
        deterministically rather than depending on which line ran last.
        """
        await provider.generate(prompt="hello", model_id="m", temperature=0.25, params=ALL_PARAMS)

        assert sent_params(RecordingChat.instances[-1])["temperature"] == 0.7

    @pytest.mark.parametrize(("name", "provider"), WIRE_ADAPTERS, ids=WIRE_IDS)
    @pytest.mark.asyncio
    async def test_a_params_object_without_a_temperature_falls_back_to_the_argument(
        self, name, provider, configured, fake_sdks
    ):
        """The common configured case: the owner set other parameters but not temperature.

        The structured value is absent, so the legacy argument is what the request carries —
        and it is still sent, because `temperature` has always been sent.
        """
        await provider.generate(
            prompt="hello", model_id="m", temperature=0.25, params=GenerationParams(top_p=0.9)
        )

        assert sent_params(RecordingChat.instances[-1])["temperature"] == 0.25


class TestResolveTemperature:
    """The precedence rule, tested on its own rather than only through five adapters."""

    def test_the_structured_parameter_wins_when_present(self):
        assert resolve_temperature(GenerationParams(temperature=0.7), 0.0) == 0.7

    def test_the_argument_is_used_when_the_object_carries_none(self):
        assert resolve_temperature(GenerationParams(top_p=0.9), 0.4) == 0.4

    def test_the_argument_stands_alone_with_no_object_at_all(self):
        """The no-configuration path — the one that must behave as it did before."""
        assert resolve_temperature(None, 0.0) == 0.0

    def test_an_explicit_zero_survives_rather_than_yielding_the_fallback(self):
        """`0.0` is a value. `or`-style truthiness here would silently replace the platform's
        own default with whatever the caller passed as a fallback, and the two would agree
        only until the fallback stopped being `0.0`."""
        assert resolve_temperature(GenerationParams(temperature=0.0), 0.9) == 0.0

    def test_a_fallback_of_zero_is_still_returned_when_it_is_the_only_source(self):
        assert resolve_temperature(None, 0.0) == 0.0


class TestGemini:
    @pytest.mark.asyncio
    async def test_it_declares_only_the_three_parameters_the_google_sdk_takes(self):
        """Verified against the installed `langchain-google-genai` (4.4.0) rather than
        assumed: `top_p` is spelled `top_p` there, and the token cap is `max_output_tokens`.

        The penalties are declared as fields by that SDK version but are *not* the OpenAI
        penalties semantic-for-semantic, so this layer does not send them — Node's capability
        table for `gemini` independently says the same (§12.2).
        """
        assert GeminiProvider().supported_params == frozenset({"temperature", "top_p", "max_tokens"})

    @pytest.mark.asyncio
    async def test_max_tokens_is_renamed_to_max_output_tokens(self, configured, fake_sdks):
        await GeminiProvider().generate(prompt="hello", model_id="m", params=ALL_PARAMS)

        kwargs = RecordingChat.instances[-1].kwargs
        assert kwargs["max_output_tokens"] == 512
        # Popped, not copied: the canonical name must not reach the SDK alongside the SDK's
        # own spelling, or the same cap would be expressed twice in one request.
        assert "max_tokens" not in kwargs

    @pytest.mark.asyncio
    async def test_it_drops_both_penalties(self, configured, fake_sdks):
        await GeminiProvider().generate(prompt="hello", model_id="m", params=ALL_PARAMS)

        kwargs = RecordingChat.instances[-1].kwargs
        assert "frequency_penalty" not in kwargs
        assert "presence_penalty" not in kwargs

    @pytest.mark.asyncio
    async def test_it_still_sends_temperature_and_top_p(self, configured, fake_sdks):
        await GeminiProvider().generate(prompt="hello", model_id="m", params=ALL_PARAMS)

        assert sent_params(RecordingChat.instances[-1]) == {
            "temperature": 0.7,
            "top_p": 0.9,
            "max_output_tokens": 512,
        }

    @pytest.mark.asyncio
    async def test_a_params_object_without_a_token_cap_does_not_gain_one(
        self, configured, fake_sdks
    ):
        """The rename must not synthesise a cap. An absent `max_tokens` means "let the
        provider decide", and turning that into a number here would silently truncate
        answers."""
        await GeminiProvider().generate(
            prompt="hello", model_id="m", params=GenerationParams(top_p=1.0)
        )

        kwargs = RecordingChat.instances[-1].kwargs
        assert "max_output_tokens" not in kwargs
        assert "max_tokens" not in kwargs


# ---------------------------------------------------------------------------------------
# The service layer's forwarding
# ---------------------------------------------------------------------------------------


class ParamsRecordingProvider:
    """A stub adapter that accepts the post-checkpoint signature and records what it got.

    Registered at a slug no built-in uses, so a test that accidentally reaches a real adapter
    fails loudly instead of silently making a network call.
    """

    slug = "params-stub"

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []

    @property
    def is_configured(self) -> bool:
        return True

    async def generate(self, prompt, model_id, system_message=None, temperature=0.0, params=None):
        self.calls.append({"temperature": temperature, "params": params})
        return "Stub answer."


class LegacySignatureProvider:
    """A stub written against the pre-checkpoint protocol — no `params` parameter.

    It exists to prove the forwarding is conditional. The protocol's new argument is
    optional precisely so an adapter written before it keeps working, and the surest way to
    test that is to hand the service one that would raise a `TypeError` if it were ever
    passed.
    """

    slug = "legacy-signature-stub"

    @property
    def is_configured(self) -> bool:
        return True

    async def generate(self, prompt, model_id, system_message=None, temperature=0.0):
        return "Legacy answer."


@pytest.fixture
def stubs(monkeypatch):
    from app.providers import registry, registered_slugs

    registered_slugs()
    saved = dict(registry._PROVIDERS)
    modern, legacy = ParamsRecordingProvider(), LegacySignatureProvider()
    registry.register(modern)
    registry.register(legacy)
    yield modern, legacy
    registry._PROVIDERS.clear()
    registry._PROVIDERS.update(saved)


class TestLLMServiceForwardsParamsOnlyWhenThereAreSome:
    @pytest.mark.asyncio
    async def test_params_reach_the_adapter_when_supplied(self, stubs):
        from app.providers import ProviderModelRef
        from app.services.llm_service import get_llm_service

        modern, _ = stubs
        params = GenerationParams(top_p=0.42)

        await get_llm_service().generate(
            prompt="hello",
            model=ProviderModelRef(provider="params-stub", model_id="m"),
            temperature=0.3,
            params=params,
        )

        assert modern.calls == [{"temperature": 0.3, "params": params}]

    @pytest.mark.asyncio
    async def test_no_params_object_keeps_an_adapter_written_before_it_working(self, stubs):
        """The compatibility the optional argument exists for.

        `LegacySignatureProvider.generate` has no `params` parameter. If the service offered
        one anyway — even as `None` — this call would raise, which is exactly the failure an
        adapter added before the feature would have seen in production.
        """
        from app.providers import ProviderModelRef
        from app.services.llm_service import get_llm_service

        _, legacy = stubs

        result = await get_llm_service().generate(
            prompt="hello",
            model=ProviderModelRef(provider="legacy-signature-stub", model_id="m"),
        )

        assert result == "Legacy answer."

    @pytest.mark.asyncio
    async def test_the_model_id_still_travels_beside_the_params(self, stubs):
        """Params must not have displaced the descriptor — a regression that would send the
        platform's configured parameters to whichever model happened to be first."""
        from app.providers import ProviderModelRef
        from app.services.llm_service import get_llm_service

        modern, _ = stubs
        recorded: List[str] = []

        async def spy(prompt, model_id, system_message=None, temperature=0.0, params=None):
            recorded.append(model_id)
            return "ok"

        modern.generate = spy

        await get_llm_service().generate(
            prompt="hello",
            model=ProviderModelRef(provider="params-stub", model_id="vendor/model-x"),
            params=GenerationParams(max_tokens=64),
        )

        assert recorded == ["vendor/model-x"]


class TestThePipelineBuildsOneCoherentParameterObject:
    """`_resolve_generation_params` is where a configuration becomes a provider call.

    Tested through the service rather than by importing the helper, because the property
    that matters is about the pair it returns: `params.temperature` and the `temperature`
    argument must be the same value, or the two routes into the request would disagree and
    the adapter's precedence rule would decide the answer instead of the configuration.
    """

    def test_a_configured_temperature_appears_in_both_channels(self):
        from app.schemas.chat import BotConfig
        from app.services.chat_service import _resolve_generation_params

        params, temperature = _resolve_generation_params(BotConfig(params={"temperature": 0.8}))

        assert params is not None
        assert params.temperature == 0.8
        assert temperature == 0.8

    def test_an_unset_temperature_leaves_both_channels_at_the_legacy_default(self):
        from app.schemas.chat import BotConfig
        from app.services.chat_service import _resolve_generation_params

        params, temperature = _resolve_generation_params(BotConfig())

        assert params is not None
        assert params.temperature is None
        assert temperature == 0.0

    def test_no_configuration_produces_no_object_at_all(self):
        from app.services.chat_service import _resolve_generation_params

        params, temperature = _resolve_generation_params(None)

        assert params is None
        assert temperature == 0.0

    def test_the_structured_parameters_travel_alongside_it(self):
        """The wire keys are the schema's own field names (plan §11.1), snake_case included.

        Pinned here because this is the one place the request body's spelling and the
        provider layer's spelling are both visible: Node must send `top_p`, not `topP`, or
        pydantic drops the field as unknown and the owner's setting silently becomes "not
        configured" — a failure with no error anywhere.
        """
        from app.schemas.chat import BotConfig
        from app.services.chat_service import _resolve_generation_params

        params, _ = _resolve_generation_params(
            BotConfig(params={"top_p": 0.3, "max_tokens": 128, "frequency_penalty": 0.5})
        )

        assert params is not None
        assert (params.top_p, params.max_tokens, params.frequency_penalty) == (0.3, 128, 0.5)
