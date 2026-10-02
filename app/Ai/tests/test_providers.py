"""Tests for the provider layer: the registry, the error type, and the model seam.

What this file is really pinning is a **negative**: that adding a model descriptor
changed nothing for callers that do not supply one. The last class proves the seam is
taken when a model *is* named, and the rest proves the registry's failure modes are
typed rather than incidental.
"""

import logging
from dataclasses import FrozenInstanceError

import pytest

from app.providers import (
    LLMProvider,
    ProviderError,
    ProviderErrorKind,
    ProviderModelRef,
    get_provider,
    is_supported,
    register,
    registered_providers,
    registered_slugs,
    registry,
)
from app.schemas.chat import ChatRequest
from app.services.llm_service import LLMService


class StubProvider:
    """A minimal adapter that records what it was asked to do."""

    slug = "stub"

    def __init__(self, configured: bool = True, result: str = "stub answer"):
        self._configured = configured
        self._result = result
        self.calls: list[dict] = []

    @property
    def is_configured(self) -> bool:
        return self._configured

    async def generate(self, prompt, model_id, system_message=None, temperature=0.0) -> str:
        self.calls.append(
            {
                "prompt": prompt,
                "model_id": model_id,
                "system_message": system_message,
                "temperature": temperature,
            }
        )
        return self._result


@pytest.fixture
def clean_registry():
    """Register stubs without leaking them into other tests.

    Forces the built-ins to load *before* snapshotting, because the registry has an
    invariant that only holds together: once `_builtins_loaded` is true, the built-in
    slugs must be present in `_PROVIDERS`. An empty snapshot taken before the first
    lookup would restore a registry that claims to be loaded but holds nothing — and
    since `import_module` does not re-execute an already-imported module, the built-ins
    could never come back. That state is unreachable in production, so the fixture must
    not manufacture it.

    Reaches into the module-private dict because the registry deliberately has no public
    "unregister" — production never needs one, and adding a method to production code
    purely for a test is the worse trade.
    """
    registered_slugs()
    saved = dict(registry._PROVIDERS)
    yield
    registry._PROVIDERS.clear()
    registry._PROVIDERS.update(saved)


class TestRegistry:
    def test_the_builtin_adapter_is_registered_on_first_lookup(self, clean_registry):
        # OpenRouter ships as a built-in from Checkpoint 5. An empty registry would now be
        # a bug, not the honest empty state it was in Checkpoint 4.
        assert "openrouter" in registered_slugs()
        assert [p.slug for p in registered_providers()] == registered_slugs()

    def test_register_then_resolve_returns_the_same_instance(self, clean_registry):
        provider = StubProvider()
        register(provider)

        assert get_provider("stub") is provider
        assert is_supported("stub") is True
        assert "stub" in registered_slugs()

    def test_registered_slugs_are_sorted_and_complete(self, clean_registry):
        register(StubProvider())
        other = StubProvider()
        other.slug = "aaa"
        register(other)

        slugs = registered_slugs()

        assert slugs == sorted(slugs)
        assert {"aaa", "stub"} <= set(slugs)

    def test_a_stub_cannot_shadow_a_builtin(self, clean_registry):
        # `register` loads the built-ins first precisely so this raises here, at the point
        # of the mistake, rather than at some later lookup.
        impostor = StubProvider()
        impostor.slug = "openrouter"

        with pytest.raises(ValueError, match="Duplicate provider slug"):
            register(impostor)

        assert get_provider("openrouter").__class__.__name__ == "OpenRouterProvider"

    def test_unknown_slug_is_rejected_with_a_typed_error(self, clean_registry):
        with pytest.raises(ProviderError) as excinfo:
            get_provider("nonexistent")

        assert excinfo.value.kind is ProviderErrorKind.UNKNOWN_PROVIDER
        assert is_supported("nonexistent") is False

    def test_unknown_slug_message_lists_what_is_registered(self, clean_registry):
        register(StubProvider())

        with pytest.raises(ProviderError) as excinfo:
            get_provider("nonexistent")

        # For an operator reading a log, "registered: [...]" is the whole diagnosis.
        assert "nonexistent" in excinfo.value.message
        assert "stub" in excinfo.value.message

    def test_is_supported_does_not_raise_for_an_unknown_slug(self, clean_registry):
        assert is_supported("nonexistent") is False

    def test_registering_a_duplicate_slug_with_a_different_adapter_raises(self, clean_registry):
        register(StubProvider())
        impostor = StubProvider()

        with pytest.raises(ValueError, match="Duplicate provider slug"):
            register(impostor)

        # The first registration survives — import order never decides behaviour.
        assert get_provider("stub").slug == "stub"

    def test_re_registering_the_same_instance_is_idempotent(self, clean_registry):
        # A module re-imported by the lazy loader must not blow up on its own second pass.
        provider = StubProvider()
        register(provider)
        register(provider)

        assert registered_slugs().count("stub") == 1

    def test_get_provider_is_cheap_and_makes_no_network_call(self, clean_registry):
        # The registry must never contact a provider. `is_configured` reads settings only,
        # and the status endpoint that consumes it is polled by the dashboard.
        provider = StubProvider(configured=False)
        register(provider)

        resolved = get_provider("stub")

        assert resolved.is_configured is False
        assert resolved.calls == []


class TestProviderError:
    def test_each_kind_carries_a_fixed_non_echoing_message(self):
        for kind in ProviderErrorKind:
            err = ProviderError(kind)
            assert err.message  # never empty
            assert err.kind is kind

    def test_default_messages_do_not_interpolate_input(self):
        # The message must not be built from the underlying exception's text: that text can
        # contain the request URL, headers, or fragments of the prompt.
        err = ProviderError(ProviderErrorKind.UPSTREAM)
        assert "http" not in err.message.lower()
        assert "{" not in err.message

    def test_carries_provider_model_and_status_for_logs(self):
        err = ProviderError(
            ProviderErrorKind.RATE_LIMIT,
            provider="openrouter",
            model_id="openai/gpt-4o-mini",
            status_code=429,
        )

        assert err.provider == "openrouter"
        assert err.model_id == "openai/gpt-4o-mini"
        assert err.provider_status == 429
        assert err.details["kind"] == "RATE_LIMIT"

    def test_details_never_contain_a_credential_shaped_value(self):
        # `details` is serialised into the error envelope. Provenance is identifiers only.
        err = ProviderError(ProviderErrorKind.AUTH, provider="openrouter", model_id="m")
        serialised = repr(err.details)

        assert "sk-" not in serialised
        assert "key" not in serialised.lower()

    def test_kind_compares_equal_to_its_name(self):
        # `str` inheritance means a kind can be matched without unwrapping `.value`.
        assert ProviderErrorKind.NOT_CONFIGURED == "NOT_CONFIGURED"

    def test_an_unmapped_provider_error_is_a_502_not_a_500(self):
        # A provider fault is an upstream failure. Subclassing AssistIQAIException means
        # even a ProviderError nothing catches leaves the service as a 502 with the
        # standard envelope, rather than an unhandled 500.
        err = ProviderError(ProviderErrorKind.UNKNOWN)

        assert err.status_code == 502
        assert err.error_code == "PROVIDER_ERROR"


class TestProviderModelRef:
    def test_is_a_frozen_value(self):
        ref = ProviderModelRef(provider="openrouter", model_id="openai/gpt-4o-mini")

        with pytest.raises(FrozenInstanceError):
            ref.model_id = "something/else"  # type: ignore[misc]

    def test_equality_is_by_value(self):
        assert ProviderModelRef("a", "b") == ProviderModelRef("a", "b")
        assert ProviderModelRef("a", "b") != ProviderModelRef("a", "c")


class TestLLMServiceModelSeam:
    """The seam itself: `model=None` is the old path, `model` set is the new one."""

    @staticmethod
    def _unconfigured_service() -> LLMService:
        """An `LLMService` pinned to the no-credentials branch.

        The suite must not touch a real provider. A developer's `.env` may well hold a
        working key, which would turn these assertions into slow, flaky, billed network
        calls — so the credential state is forced rather than inherited.
        """
        service = LLMService()
        service._is_configured = False
        service.provider = "unconfigured-test-provider"
        return service

    @pytest.mark.asyncio
    async def test_a_supplied_model_is_delegated_to_the_registered_adapter(self, clean_registry):
        provider = StubProvider(result="from the adapter")
        register(provider)
        service = self._unconfigured_service()

        answer = await service.generate(
            prompt="how do refunds work?",
            system_message="be brief",
            temperature=0.0,
            model=ProviderModelRef(provider="stub", model_id="some/model"),
        )

        assert answer == "from the adapter"
        assert provider.calls == [
            {
                "prompt": "how do refunds work?",
                "model_id": "some/model",
                "system_message": "be brief",
                "temperature": 0.0,
            }
        ]

    @pytest.mark.asyncio
    async def test_a_supplied_model_is_used_even_when_the_environment_is_unconfigured(
        self, clean_registry
    ):
        # The environment default being unusable must not stop a named model from running:
        # the two paths are independent, which is what lets a bot keep working while the
        # service-wide key is absent.
        provider = StubProvider(result="from the adapter")
        register(provider)
        service = self._unconfigured_service()

        answer = await service.generate(
            prompt="hello",
            model=ProviderModelRef(provider="stub", model_id="some/model"),
        )

        assert answer == "from the adapter"
        assert "Placeholder AI Response" not in answer

    @pytest.mark.asyncio
    async def test_no_model_never_touches_the_provider_layer(self, clean_registry):
        provider = StubProvider()
        register(provider)
        service = self._unconfigured_service()

        # Unconfigured environment => the pre-existing placeholder response. The point is
        # not the text but that the adapter was bypassed entirely.
        answer = await service.generate(prompt="hello", model=None)

        assert provider.calls == []
        assert "Placeholder AI Response" in answer

    @pytest.mark.asyncio
    async def test_existing_signature_still_works_positionally(self, clean_registry):
        # `process_chat(bot_id, message)` and `generate(prompt)` must remain callable with
        # exactly the arguments they took before this checkpoint.
        service = self._unconfigured_service()

        answer = await service.generate("hello")

        assert isinstance(answer, str)
        assert "Placeholder AI Response" in answer

    @pytest.mark.asyncio
    async def test_a_provider_error_propagates_rather_than_becoming_a_fallback_string(
        self, clean_registry
    ):
        register(StubProvider())

        service = self._unconfigured_service()

        with pytest.raises(ProviderError) as excinfo:
            await service.generate(
                prompt="hello",
                model=ProviderModelRef(provider="unregistered", model_id="m"),
            )

        # Falling into the legacy `except Exception` would have returned
        # "[Fallback Response] ... Query was: 'hello'" — a failure wearing the costume of
        # an answer. Node's failure policy branches on the kind, so it must escape typed.
        assert excinfo.value.kind is ProviderErrorKind.UNKNOWN_PROVIDER
        assert "Fallback Response" not in excinfo.value.message

    @pytest.mark.asyncio
    async def test_an_adapter_error_is_not_swallowed_either(self, clean_registry):
        class FailingProvider(StubProvider):
            slug = "failing"

            async def generate(self, prompt, model_id, system_message=None, temperature=0.0):
                raise ProviderError(ProviderErrorKind.RATE_LIMIT, provider=self.slug)

        register(FailingProvider())
        service = self._unconfigured_service()

        with pytest.raises(ProviderError) as excinfo:
            await service.generate(
                prompt="hello",
                model=ProviderModelRef(provider="failing", model_id="m"),
            )

        assert excinfo.value.kind is ProviderErrorKind.RATE_LIMIT


class TestLoggingHygiene:
    def test_provider_error_logging_never_includes_the_prompt_or_a_key(self, caplog):
        with caplog.at_level(logging.DEBUG):
            err = ProviderError(ProviderErrorKind.AUTH, provider="openrouter")

        assert "sk-" not in caplog.text
        assert err.message == "The provider rejected the credentials."


class TestProtocolConformance:
    def test_a_stub_satisfies_the_declared_interface(self):
        # Structural typing: nothing enforces `LLMProvider` at runtime, so pin the shape
        # the registry will assume of every adapter.
        provider: LLMProvider = StubProvider()

        assert isinstance(provider.slug, str)
        assert isinstance(provider.is_configured, bool)
        assert callable(provider.generate)


class TestChatRequestCompatibility:
    """The new field must be invisible to every caller that does not send it.

    Asserted at the schema and at the HTTP boundary rather than through the pipeline:
    the pipeline needs pgvector and a classifier, and what is being pinned here is
    *request parsing*, which must not depend on either.
    """

    def test_model_defaults_to_none(self):
        request = ChatRequest(bot_id="bot-1", message="hello")

        assert request.model is None

    def test_a_request_with_no_model_parses_exactly_as_before(self):
        # The pre-checkpoint payload, field for field.
        request = ChatRequest.model_validate({"bot_id": "bot-1", "message": "hello"})

        assert request.bot_id == "bot-1"
        assert request.message == "hello"
        assert request.model is None

    def test_a_model_descriptor_is_accepted(self):
        request = ChatRequest.model_validate(
            {
                "bot_id": "bot-1",
                "message": "hello",
                "model": {"provider": "openrouter", "model_id": "openai/gpt-4o-mini"},
            }
        )

        assert request.model is not None
        assert request.model.provider == "openrouter"
        assert request.model.model_id == "openai/gpt-4o-mini"

    @pytest.mark.asyncio
    async def test_an_out_of_bounds_model_id_is_rejected_at_the_boundary(self, async_client):
        # An unbounded string would otherwise reach a vendor SDK. 422 is FastAPI's
        # validation status; the pipeline is never entered.
        response = await async_client.post(
            "/api/v1/chat",
            json={
                "bot_id": "bot-1",
                "message": "hello",
                "model": {"provider": "openrouter", "model_id": "x" * 5000},
            },
        )

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_an_empty_provider_slug_is_rejected_at_the_boundary(self, async_client):
        response = await async_client.post(
            "/api/v1/chat",
            json={
                "bot_id": "bot-1",
                "message": "hello",
                "model": {"provider": "", "model_id": "openai/gpt-4o-mini"},
            },
        )

        assert response.status_code == 422
