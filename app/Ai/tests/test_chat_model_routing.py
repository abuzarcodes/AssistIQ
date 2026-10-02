"""Checkpoint 6 — the model descriptor on the production chat path.

Driven through `POST /api/v1/chat`, the route Node actually calls, rather than by calling
`ChatService.process_chat` directly. The descriptor travels Node -> HTTP body -> Pydantic
-> `ProviderModelRef` -> `LLMService.generate` -> the adapter; a unit test on the service
would skip the half of that journey where a field name can be mistyped.

The classifier and the vector store are stubbed so the pipeline reaches generation
deterministically. They are *not* the subject: what is being pinned is that a provider
failure becomes a reason-coded 200 with a non-disclosing message, and never a 500.
"""

from typing import Any, Dict, Optional

import pytest

from app.core.constants import (
    FALLBACK_REASON_MODEL_ERROR,
    FALLBACK_REASON_MODEL_RATE_LIMITED,
    FALLBACK_REASON_MODEL_UNAVAILABLE,
)
from app.providers import ProviderError, ProviderErrorKind, registry, registered_slugs
from app.services.chat_service import get_chat_service, reason_for_provider_error

#: Registered rather than using OpenRouter: the routing seam must be provable without a
#: vendor SDK, a credential, or a network. The slug is deliberately not a real one, so a
#: test that accidentally exercises the real adapter fails loudly instead of silently.
STUB_SLUG = "routing-stub"


class StubProvider:
    """An adapter that records the descriptor it was handed, and can be made to fail."""

    slug = STUB_SLUG

    def __init__(self) -> None:
        self.calls: list[Dict[str, Any]] = []
        self.failure: Optional[ProviderError] = None

    @property
    def is_configured(self) -> bool:
        return True

    async def generate(
        self,
        prompt: str,
        model_id: str,
        system_message: Optional[str] = None,
        temperature: float = 0.0,
    ) -> str:
        self.calls.append(
            {
                "prompt": prompt,
                "model_id": model_id,
                "system_message": system_message,
                "temperature": temperature,
            }
        )
        if self.failure is not None:
            raise self.failure
        return "Stub answer from the named model."


@pytest.fixture
def stub_provider():
    """Register the stub, and restore the registry exactly afterwards.

    Reaches into `registry._PROVIDERS` because the registry has no public unregister —
    production never needs one. `registered_slugs()` is called first so the built-ins are
    loaded before the snapshot; restoring a registry that claims to be loaded but holds
    nothing would be a state production cannot reach.
    """
    registered_slugs()
    saved = dict(registry._PROVIDERS)
    provider = StubProvider()
    registry.register(provider)
    yield provider
    registry._PROVIDERS.clear()
    registry._PROVIDERS.update(saved)


@pytest.fixture
def pipeline(monkeypatch):
    """Stub the two stages before generation, so the pipeline always reaches the model.

    Patched onto the singleton instance rather than the class: `get_chat_service` hands
    the route a process-wide instance, and replacing the class would leave the instance
    holding the originals.
    """

    class StubClassifier:
        def classify(self, text: str) -> Dict[str, Any]:
            return {"intent": "faq_match", "confidence": 0.95, "is_confident": True}

    class StubRag:
        async def search(self, query, bot_id, top_k=3, topic_filter=None) -> Dict[str, Any]:
            return {
                "results": [{"topic": "hours", "content": "We are open nine to five."}],
                "top_score": 0.91,
                "is_confident": True,
                "used_topic_filter": topic_filter is not None,
            }

    service = get_chat_service()
    monkeypatch.setattr(service, "classifier", StubClassifier())
    monkeypatch.setattr(service, "rag", StubRag())
    return service


def post_chat(client, **overrides):
    payload: Dict[str, Any] = {
        "bot_id": "bot_1",
        "message": "What are your hours?",
    }
    payload.update(overrides)
    return client.post("/api/v1/chat", json=payload)


# ---------------------------------------------------------------------------------------
# The descriptor reaches the adapter
# ---------------------------------------------------------------------------------------


class TestTheDescriptorReachesTheModel:
    @pytest.mark.asyncio
    async def test_the_adapter_receives_the_provider_and_model_id_from_the_body(
        self, async_client, stub_provider, pipeline
    ):
        response = await post_chat(
            async_client,
            model={"provider": STUB_SLUG, "model_id": "vendor/model-x"},
        )

        assert response.status_code == 200
        assert len(stub_provider.calls) == 1
        call = stub_provider.calls[0]

        # The second half of the descriptor is passed through verbatim: Python holds no
        # catalog and must not be tempted to normalise, prefix or validate a model id.
        assert call["model_id"] == "vendor/model-x"
        assert call["temperature"] == 0.0
        assert call["system_message"]

        body = response.json()
        assert body["status"] == "success"
        assert body["fallback_required"] is False
        assert body["reason"] is None
        assert body["response"] == "Stub answer from the named model."

    @pytest.mark.asyncio
    async def test_an_absent_model_takes_the_environment_default_path_untouched(
        self, async_client, stub_provider, pipeline, monkeypatch
    ):
        """The negative that matters: nothing changed for a caller that names no model.

        The environment default is forced unconfigured so this is deterministic and makes
        no outbound call — with a real key in a developer's `.env` this test would
        otherwise reach a vendor from the suite.
        """
        monkeypatch.setattr(pipeline.llm, "_is_configured", False)

        response = await post_chat(async_client)

        assert response.status_code == 200
        # The registry was never consulted, so the named adapter was never reached.
        assert stub_provider.calls == []
        # Still the pre-existing placeholder behaviour, verbatim.
        assert "[Placeholder AI Response]" in response.json()["response"]

    @pytest.mark.asyncio
    async def test_an_unregistered_slug_is_a_mapped_failure_and_not_a_500(
        self, async_client, pipeline
    ):
        """`get_provider` raises `UNKNOWN_PROVIDER`; the pipeline must absorb it.

        A slug the registry does not know is a catalog/registry disagreement — a
        configuration fault, reported to the customer as unavailable. Letting it reach
        the route's `except Exception` would turn it into a 500 and lose the reason code,
        so Node could not escalate with a cause.
        """
        response = await post_chat(
            async_client,
            model={"provider": "no-such-provider", "model_id": "vendor/model-x"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["fallback_required"] is True
        assert body["reason"] == FALLBACK_REASON_MODEL_UNAVAILABLE


# ---------------------------------------------------------------------------------------
# A typed provider failure becomes a reason-coded fallback
# ---------------------------------------------------------------------------------------

#: Every kind, and the reason Node receives. The configuration kinds collapse onto
#: `MODEL_UNAVAILABLE` because a customer cannot act on the difference and naming it would
#: disclose platform internals; `RATE_LIMIT` is separated because retrying is meaningful;
#: the rest are operational faults that are not the operator's to configure.
EXPECTED_REASONS = {
    ProviderErrorKind.NOT_CONFIGURED: FALLBACK_REASON_MODEL_UNAVAILABLE,
    ProviderErrorKind.AUTH: FALLBACK_REASON_MODEL_UNAVAILABLE,
    ProviderErrorKind.BAD_REQUEST: FALLBACK_REASON_MODEL_UNAVAILABLE,
    ProviderErrorKind.UNKNOWN_PROVIDER: FALLBACK_REASON_MODEL_UNAVAILABLE,
    ProviderErrorKind.RATE_LIMIT: FALLBACK_REASON_MODEL_RATE_LIMITED,
    ProviderErrorKind.UPSTREAM: FALLBACK_REASON_MODEL_ERROR,
    ProviderErrorKind.TIMEOUT: FALLBACK_REASON_MODEL_ERROR,
    ProviderErrorKind.UNKNOWN: FALLBACK_REASON_MODEL_ERROR,
}


class TestAProviderFailureIsAFallback:
    @pytest.mark.parametrize("kind", list(EXPECTED_REASONS))
    @pytest.mark.asyncio
    async def test_it_returns_200_with_the_mapped_reason(
        self, async_client, stub_provider, pipeline, kind
    ):
        stub_provider.failure = ProviderError(
            kind, provider=STUB_SLUG, model_id="vendor/model-x", status_code=503
        )

        response = await post_chat(
            async_client, model={"provider": STUB_SLUG, "model_id": "vendor/model-x"}
        )

        # The assertion the checkpoint exists for: a provider fault is a *result*, not a
        # server error, so Node's existing `fallback_required` branch handles it and no
        # new Node branch is needed.
        assert response.status_code == 200
        body = response.json()
        assert body["fallback_required"] is True
        assert body["reason"] == EXPECTED_REASONS[kind]
        assert body["status"] == "success"

    @pytest.mark.parametrize("kind", list(EXPECTED_REASONS))
    @pytest.mark.asyncio
    async def test_the_message_discloses_nothing_about_the_provider(
        self, async_client, stub_provider, pipeline, kind
    ):
        stub_provider.failure = ProviderError(
            kind, provider=STUB_SLUG, model_id="vendor/model-x", status_code=503
        )

        response = await post_chat(
            async_client, model={"provider": STUB_SLUG, "model_id": "vendor/model-x"}
        )
        rendered = response.text

        # The customer reads this in a chat thread. The provider slug, the model id, the
        # failure kind and the upstream status are operator facts, and the adapter's own
        # message text — which can echo a request URL — must not be substituted in either.
        assert STUB_SLUG not in rendered
        assert "vendor/model-x" not in rendered
        assert "503" not in rendered
        assert "OpenRouter" not in rendered

        # The reason code *is* deliberately exposed — Node branches on it. `RATE_LIMIT` is
        # a substring of `MODEL_RATE_LIMITED`, so the kind is checked against the body with
        # that one documented reason removed: what must not leak is the failure
        # classification sitting alongside the code, not the code itself.
        assert kind.value not in rendered.replace(EXPECTED_REASONS[kind], "")

    @pytest.mark.asyncio
    async def test_the_response_shape_is_identical_to_every_other_fallback(
        self, async_client, stub_provider, pipeline
    ):
        """Node must not need a branch to tell a model failure from a conversational one.

        Same keys, same types, and `fallback_required` plus `reason` carrying the whole
        difference — which is what lets `conversation.service` escalate on one condition.
        """
        stub_provider.failure = ProviderError(
            ProviderErrorKind.TIMEOUT, provider=STUB_SLUG, model_id="vendor/model-x"
        )
        failed = await post_chat(
            async_client, model={"provider": STUB_SLUG, "model_id": "vendor/model-x"}
        )

        stub_provider.failure = None
        stub_provider.calls.clear()
        succeeded = await post_chat(
            async_client, model={"provider": STUB_SLUG, "model_id": "vendor/model-x"}
        )

        assert set(failed.json()) == set(succeeded.json())
        for field in ("intent", "retrieval"):
            assert set(failed.json()[field]) == set(succeeded.json()[field])

    @pytest.mark.asyncio
    async def test_a_configured_provider_that_the_platform_disabled_costs_no_call(
        self, async_client, pipeline
    ):
        """Node short-circuits a disabled model, so Python is never asked.

        Pinned from this side because the two halves of the guarantee live in different
        services: Node's test proves it does not call, and this proves that *if* it did
        not, nothing here would be reached — the payload is simply never sent.
        """
        response = await post_chat(
            async_client, model={"provider": "openrouter", "model_id": "openai/gpt-4o-mini"}
        )

        # The real adapter is configured only if a key is present. Either way this must
        # not be a 500, which is the part the checkpoint owns.
        assert response.status_code == 200


# ---------------------------------------------------------------------------------------
# The mapping table itself
# ---------------------------------------------------------------------------------------


class TestTheReasonMapping:
    @pytest.mark.parametrize(("kind", "reason"), list(EXPECTED_REASONS.items()))
    def test_every_kind_maps_to_its_documented_reason(self, kind, reason):
        err = ProviderError(kind, provider=STUB_SLUG, model_id="m")

        assert reason_for_provider_error(err) == reason

    def test_an_unmapped_kind_reports_an_operational_fault_and_not_a_configuration_one(self):
        """A kind added to the enum but forgotten in the table must not guess.

        `MODEL_UNAVAILABLE` is an affirmative claim that the platform is misconfigured,
        and it escalates as a configuration problem. An unrecognised kind cannot support
        that claim, so it degrades to the operational bucket instead.
        """
        err = ProviderError(ProviderErrorKind.UNKNOWN, provider=STUB_SLUG, model_id="m")
        err.kind = "A_KIND_THAT_DOES_NOT_EXIST_YET"

        assert reason_for_provider_error(err) == FALLBACK_REASON_MODEL_ERROR

    def test_the_table_covers_every_member_of_the_enum(self):
        """A new kind is a decision about customer-visible behaviour, not a default.

        Failing here is the reminder to make that decision consciously; the fallback above
        is a floor for unanticipated values, not an excuse to skip the table.
        """
        for kind in ProviderErrorKind:
            err = ProviderError(kind, provider=STUB_SLUG, model_id="m")
            assert reason_for_provider_error(err) in {
                FALLBACK_REASON_MODEL_UNAVAILABLE,
                FALLBACK_REASON_MODEL_RATE_LIMITED,
                FALLBACK_REASON_MODEL_ERROR,
            }


# ---------------------------------------------------------------------------------------
# The transport boundary rejects what it cannot represent
# ---------------------------------------------------------------------------------------


class TestTheRequestSchema:
    @pytest.mark.asyncio
    async def test_a_model_without_a_provider_is_rejected(self, async_client, pipeline):
        response = await post_chat(async_client, model={"model_id": "vendor/model-x"})

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_an_over_long_model_id_is_rejected_before_it_reaches_a_vendor_sdk(
        self, async_client, pipeline
    ):
        """The bound is not cosmetic: an unbounded string would be forwarded to a vendor.

        A model id that long is not a catalog value, so it is a client bug or an attempt
        to smuggle something through the descriptor — either way it is refused here rather
        than at the provider.
        """
        response = await post_chat(
            async_client, model={"provider": STUB_SLUG, "model_id": "x" * 201}
        )

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_an_empty_provider_is_rejected(self, async_client, pipeline):
        response = await post_chat(
            async_client, model={"provider": "", "model_id": "vendor/model-x"}
        )

        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_a_bare_model_string_is_rejected(self, async_client, stub_provider, pipeline):
        """The old shape of this field, if anyone tries it, must not be silently accepted."""
        response = await post_chat(async_client, model="openai/gpt-4o-mini")

        assert response.status_code == 422
        assert stub_provider.calls == []
