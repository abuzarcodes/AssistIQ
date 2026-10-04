"""Checkpoint 4 — model failover: who is retried, exactly once, and within what budget.

The plan's constraints (plan §13.3, §13.4, §13.5) are four separate claims, and each is tested
as its own claim rather than as one happy path with variations:

* **Eligibility** is a table. `failover_eligible` is tested row by row at the function level,
  including the two rows whose answer depends on the *fallback's* provider slug rather than on
  the failure kind — `AUTH` and `NOT_CONFIGURED`, where retrying the same provider is
  guaranteed to fail identically. A table tested only through a passing example is a table
  whose bottom half nobody has read.
* **Exactly one retry** is tested by making the fallback fail too and counting the calls. A
  loop would show three; an `if` shows two.
* **The budget** is tested by pinning the clock and reading the timeout the fallback attempt
  was given, so the arithmetic is asserted rather than described. The skip case is tested the
  same way, from the other side: below the floor, no attempt is made at all.
* **Step isolation** — classification and retrieval are not repeated — is tested by counting
  the classifier's and the retriever's calls, because "the generation step only" is a claim
  about what did *not* happen.

`asyncio.wait_for` is spied rather than replaced: the real one still runs, so a successful
failover in a test is a real await, and only the timeout argument is observed.
"""

import asyncio
from typing import Any, Dict, List, Optional

import pytest

import app.services.chat_service as chat_module
from app.core.constants import (
    FALLBACK_REASON_MODEL_ERROR,
    FALLBACK_REASON_MODEL_RATE_LIMITED,
    FALLBACK_REASON_MODEL_UNAVAILABLE,
)
from app.providers import ProviderError, ProviderErrorKind, ProviderModelRef
from app.services.chat_service import (
    _describe_model,
    _most_severe_failure,
    failover_eligible,
    get_chat_service,
)

BOT_ID = "bot_failover_1"
MESSAGE = "How long do refunds take?"

PRIMARY = ProviderModelRef(provider="openrouter", model_id="openai/gpt-4o-mini")
SAME_PROVIDER_FALLBACK = ProviderModelRef(provider="openrouter", model_id="meta-llama/llama-3.3-70b")
FALLBACK = ProviderModelRef(provider="groq", model_id="llama-3.3-70b-versatile")


def request_model(ref: ProviderModelRef) -> Dict[str, str]:
    return {"provider": ref.provider, "model_id": ref.model_id}


def chunk() -> Dict[str, Any]:
    return {
        "id": "chunk_1",
        "bot_id": BOT_ID,
        "topic": "REFUND",
        "content": "Refunds take five business days.",
        "source_id": "src_1",
        "metadata": {"source_id": "src_1", "page_number": 1},
        "score": 0.91,
    }


class CountingClassifier:
    def __init__(self) -> None:
        self.calls = 0

    def classify(self, text: str) -> Dict[str, Any]:
        self.calls += 1
        return {"intent": "faq_match", "confidence": 0.95, "is_confident": True}


class CountingRag:
    def __init__(self) -> None:
        self.calls = 0

    async def search(self, query, bot_id, top_k=3, topic_filter=None) -> Dict[str, Any]:
        self.calls += 1
        return {
            "query": query,
            "results": [chunk()],
            "top_score": 0.91,
            "is_confident": True,
            "threshold": 0.65,
            "used_topic_filter": topic_filter is not None,
        }


class ScriptedLLM:
    """Fails or succeeds per attempt, exactly as scripted.

    `script[i]` is the outcome of the i-th call: a `ProviderErrorKind` to raise, or `None` to
    answer. Calls past the end of the script succeed, so an accidental third attempt is
    reported by `calls` rather than by an IndexError that would look like a different bug.
    """

    def __init__(self, script: Optional[List[Optional[ProviderErrorKind]]] = None) -> None:
        self.script = script or []
        self.calls: List[Dict[str, Any]] = []

    async def generate(
        self,
        prompt: str,
        system_message: Optional[str] = None,
        temperature: float = 0.0,
        model: Optional[ProviderModelRef] = None,
        params: Optional[Any] = None,
    ) -> str:
        index = len(self.calls)
        self.calls.append(
            {
                "prompt": prompt,
                "system_message": system_message,
                "temperature": temperature,
                "model": model,
                "params": params,
            }
        )
        kind = self.script[index] if index < len(self.script) else None
        if kind is not None:
            raise ProviderError(
                kind,
                provider=model.provider if model else "env",
                model_id=model.model_id if model else "env-model",
            )
        return f"answer from {_describe_model(model)}"

    @property
    def call_count(self) -> int:
        return len(self.calls)

    def reset(self) -> None:
        """Forget the previous turn, so a test can drive two requests from one script.

        `calls` is also the script's index, so clearing it rewinds the script as well — which
        is what makes two identical turns through the same stub comparable.
        """
        self.calls.clear()


@pytest.fixture
def pipeline(monkeypatch):
    service = get_chat_service()
    classifier = CountingClassifier()
    rag = CountingRag()
    llm = ScriptedLLM()
    monkeypatch.setattr(service, "classifier", classifier)
    monkeypatch.setattr(service, "rag", rag)
    monkeypatch.setattr(service, "llm", llm)
    return service, classifier, rag, llm


@pytest.fixture
def budget(monkeypatch):
    """Pin the budget and read back the timeout each fallback attempt was given."""
    monkeypatch.setattr(chat_module.settings, "GENERATION_BUDGET_SECONDS", 20.0)
    monkeypatch.setattr(chat_module.settings, "FAILOVER_MIN_REMAINING_SECONDS", 3.0)
    timeouts: List[Optional[float]] = []
    real_wait_for = asyncio.wait_for

    async def spy(awaitable, timeout=None):
        timeouts.append(timeout)
        return await real_wait_for(awaitable, timeout=timeout)

    monkeypatch.setattr(chat_module.asyncio, "wait_for", spy)
    return timeouts


@pytest.fixture
def clock(monkeypatch):
    """A controllable `_monotonic`; values are consumed in order and then held."""

    class Clock:
        def __init__(self) -> None:
            self.values: List[float] = []
            self.calls = 0

        def __call__(self) -> float:
            if not self.values:
                return 0.0
            index = min(self.calls, len(self.values) - 1)
            self.calls += 1
            return self.values[index]

    c = Clock()
    monkeypatch.setattr(chat_module, "_monotonic", c)
    return c


def post_chat(client, **overrides):
    payload: Dict[str, Any] = {"bot_id": BOT_ID, "message": MESSAGE}
    payload.update(overrides)
    return client.post("/api/v1/chat", json=payload)


def with_models(primary: ProviderModelRef = PRIMARY, fallback: ProviderModelRef = FALLBACK):
    return {"model": request_model(primary), "fallback_model": request_model(fallback)}


# --------------------------------------------------------------------------------------
# The eligibility table, row by row
# --------------------------------------------------------------------------------------


class TestTheEligibilityTable:
    @pytest.mark.parametrize(
        "kind",
        [
            ProviderErrorKind.RATE_LIMIT,
            ProviderErrorKind.UPSTREAM,
            ProviderErrorKind.TIMEOUT,
            ProviderErrorKind.UNKNOWN,
        ],
    )
    def test_transient_kinds_always_earn_a_retry(self, kind):
        assert failover_eligible(kind, PRIMARY, FALLBACK) is True

    @pytest.mark.parametrize(
        "kind",
        [
            ProviderErrorKind.BAD_REQUEST,
            ProviderErrorKind.UNKNOWN_PROVIDER,
        ],
    )
    def test_the_two_kinds_that_never_fail_over(self, kind):
        """A 400 is "that model id does not exist"; a missing adapter is a deployment fault.

        Neither is a retry, and neither is helped by a different model — the first is a guess
        and the second is an action item.
        """
        assert failover_eligible(kind, PRIMARY, FALLBACK) is False

    @pytest.mark.parametrize(
        "kind", [ProviderErrorKind.AUTH, ProviderErrorKind.NOT_CONFIGURED]
    )
    def test_configuration_faults_fail_over_only_across_providers(self, kind):
        assert failover_eligible(kind, PRIMARY, FALLBACK) is True

    @pytest.mark.parametrize(
        "kind", [ProviderErrorKind.AUTH, ProviderErrorKind.NOT_CONFIGURED]
    )
    def test_configuration_faults_do_not_fail_over_within_one_provider(self, kind):
        """Same provider, same credential store: the second attempt cannot differ."""
        assert failover_eligible(kind, PRIMARY, SAME_PROVIDER_FALLBACK) is False

    @pytest.mark.parametrize(
        "kind", [ProviderErrorKind.AUTH, ProviderErrorKind.NOT_CONFIGURED]
    )
    def test_configuration_faults_do_not_fail_over_without_a_known_primary_provider(self, kind):
        """With no catalog model the primary's slug is unknowable, so difference is unprovable."""
        assert failover_eligible(kind, None, FALLBACK) is False

    @pytest.mark.parametrize("kind", list(ProviderErrorKind))
    def test_no_fallback_configured_makes_every_kind_ineligible(self, kind):
        """The default state of every bot that has not been given a second model."""
        assert failover_eligible(kind, PRIMARY, None) is False

    def test_a_transient_kind_still_fails_over_on_the_same_provider(self):
        """The same-slug rule is about *credentials*, not about providers generally."""
        assert failover_eligible(ProviderErrorKind.RATE_LIMIT, PRIMARY, SAME_PROVIDER_FALLBACK)


class TestWhichFailureIsReported:
    def error(self, kind: ProviderErrorKind) -> ProviderError:
        return ProviderError(kind, provider="p", model_id="m")

    def test_a_configuration_fault_on_the_primary_is_not_masked_by_a_transient_fallback(self):
        """The severity of an actionable fault must survive the second attempt."""
        reported = _most_severe_failure(
            self.error(ProviderErrorKind.AUTH), self.error(ProviderErrorKind.RATE_LIMIT)
        )

        assert reported.kind is ProviderErrorKind.AUTH

    def test_a_configuration_fault_on_the_fallback_is_not_masked_by_a_transient_primary(self):
        reported = _most_severe_failure(
            self.error(ProviderErrorKind.RATE_LIMIT), self.error(ProviderErrorKind.AUTH)
        )

        assert reported.kind is ProviderErrorKind.AUTH

    def test_two_transient_failures_report_the_fallback(self):
        """Equally actionable, so the attempt the turn ended on describes the current state."""
        reported = _most_severe_failure(
            self.error(ProviderErrorKind.RATE_LIMIT), self.error(ProviderErrorKind.TIMEOUT)
        )

        assert reported.kind is ProviderErrorKind.TIMEOUT

    def test_two_configuration_faults_report_the_fallback(self):
        reported = _most_severe_failure(
            self.error(ProviderErrorKind.AUTH), self.error(ProviderErrorKind.NOT_CONFIGURED)
        )

        assert reported.kind is ProviderErrorKind.NOT_CONFIGURED


# --------------------------------------------------------------------------------------
# Through the pipeline
# --------------------------------------------------------------------------------------


class TestASuccessfulFailover:
    @pytest.mark.asyncio
    async def test_the_fallback_answers_and_the_customer_sees_a_normal_response(
        self, async_client, pipeline, budget
    ):
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT]

        body = (await post_chat(async_client, **with_models())).json()

        assert body["fallback_required"] is False
        assert body["reason"] is None
        assert body["response"] == "answer from groq:llama-3.3-70b-versatile"

    @pytest.mark.asyncio
    async def test_failover_never_changes_fallback_required(self, async_client, pipeline, budget):
        """§13.4.6 — a successful failover is a normal answer, not an escalation."""
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.UPSTREAM]

        body = (await post_chat(async_client, **with_models())).json()

        assert body["fallback_required"] is False

    @pytest.mark.asyncio
    async def test_the_response_reports_the_model_that_actually_answered(
        self, async_client, pipeline, budget
    ):
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.TIMEOUT]

        body = (await post_chat(async_client, **with_models())).json()

        assert body["model_used"] == "groq:llama-3.3-70b-versatile"
        assert body["failover_used"] is True

    @pytest.mark.asyncio
    async def test_the_primary_is_reported_when_no_failover_was_needed(
        self, async_client, pipeline, budget
    ):
        body = (await post_chat(async_client, **with_models())).json()

        assert body["model_used"] == "openrouter:openai/gpt-4o-mini"
        assert body["failover_used"] is False

    @pytest.mark.asyncio
    async def test_no_catalog_model_is_reported_as_no_model(self, async_client, pipeline, budget):
        """The environment default is not a catalog assignment, so nothing is named."""
        body = (await post_chat(async_client)).json()

        assert body["model_used"] is None

    @pytest.mark.asyncio
    async def test_the_successful_failover_is_logged_at_warning(self, async_client, pipeline, budget, caplog):
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT]

        with caplog.at_level("WARNING", logger="assistiq_ai"):
            await post_chat(async_client, **with_models())

        records = [r for r in caplog.records if getattr(r, "operation", None) == "chat_failover"]
        assert len(records) == 1
        assert records[0].outcome == "succeeded"
        assert records[0].primary_kind == ProviderErrorKind.RATE_LIMIT.value
        assert records[0].fallback_provider == "groq"
        assert records[0].primary_fault == "provider"


class TestExactlyOneRetry:
    @pytest.mark.asyncio
    async def test_a_failing_fallback_is_not_retried_again(self, async_client, pipeline, budget):
        """Two calls, never three: the retry is an `if`, and there is no counter to get wrong."""
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT, ProviderErrorKind.RATE_LIMIT, ProviderErrorKind.RATE_LIMIT]

        await post_chat(async_client, **with_models())

        assert llm.call_count == 2

    @pytest.mark.asyncio
    async def test_an_ineligible_failure_never_reaches_the_fallback_at_all(
        self, async_client, pipeline, budget
    ):
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.BAD_REQUEST]

        await post_chat(async_client, **with_models())

        assert llm.call_count == 1

    @pytest.mark.asyncio
    async def test_a_same_provider_auth_failure_does_not_retry(
        self, async_client, pipeline, budget
    ):
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.AUTH]

        body = (
            await post_chat(async_client, **with_models(fallback=SAME_PROVIDER_FALLBACK))
        ).json()

        assert llm.call_count == 1
        assert body["reason"] == FALLBACK_REASON_MODEL_UNAVAILABLE

    @pytest.mark.asyncio
    async def test_a_cross_provider_auth_failure_does_retry(self, async_client, pipeline, budget):
        """The fallback may hold a credential the primary's provider never saw."""
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.AUTH]

        body = (await post_chat(async_client, **with_models())).json()

        assert llm.call_count == 2
        assert body["failover_used"] is True

    @pytest.mark.asyncio
    async def test_no_fallback_model_leaves_the_path_inert(self, async_client, pipeline, budget):
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT]

        body = (
            await post_chat(async_client, model=request_model(PRIMARY))
        ).json()

        assert llm.call_count == 1
        assert body["reason"] == FALLBACK_REASON_MODEL_RATE_LIMITED

    @pytest.mark.asyncio
    async def test_classification_and_retrieval_are_not_repeated(
        self, async_client, pipeline, budget
    ):
        """§13.4.2 — only the generation step is retried; re-embedding would double the cost."""
        _, classifier, rag, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT]

        await post_chat(async_client, **with_models())

        assert classifier.calls == 1
        assert rag.calls == 1
        assert llm.call_count == 2

    @pytest.mark.asyncio
    async def test_the_fallback_receives_the_same_generation_parameters(
        self, async_client, pipeline, budget
    ):
        """§13.4.3 — the same `GenerationParams`; the adapter filters by its own capability set."""
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT]

        await post_chat(
            async_client,
            **with_models(),
            config={"params": {"temperature": 0.3, "top_p": 0.9, "frequency_penalty": 0.5}},
        )

        assert llm.calls[1]["params"] is llm.calls[0]["params"]
        assert llm.calls[1]["params"].frequency_penalty == 0.5
        assert llm.calls[1]["model"] == FALLBACK


class TestDoubleFailure:
    @pytest.mark.asyncio
    async def test_the_normal_reason_coded_response_is_returned(self, async_client, pipeline, budget):
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT, ProviderErrorKind.TIMEOUT]

        body = (await post_chat(async_client, **with_models())).json()

        assert body["fallback_required"] is True
        assert body["reason"] == FALLBACK_REASON_MODEL_ERROR
        assert body["response"]
        assert body["sources"] is None

    @pytest.mark.asyncio
    async def test_nothing_generated_so_no_model_is_reported_as_used(
        self, async_client, pipeline, budget
    ):
        """`failover_used` must not claim a fallback served a turn that produced an error."""
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT, ProviderErrorKind.RATE_LIMIT]

        body = (await post_chat(async_client, **with_models())).json()

        assert body["model_used"] is None
        assert body["failover_used"] is False

    @pytest.mark.asyncio
    async def test_the_double_failure_is_logged_with_both_kinds(
        self, async_client, pipeline, budget, caplog
    ):
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT, ProviderErrorKind.TIMEOUT]

        with caplog.at_level("WARNING", logger="assistiq_ai"):
            await post_chat(async_client, **with_models())

        records = [r for r in caplog.records if getattr(r, "operation", None) == "chat_failover"]
        assert len(records) == 1
        assert records[0].outcome == "failed"
        assert records[0].primary_kind == ProviderErrorKind.RATE_LIMIT.value
        assert records[0].fallback_kind == ProviderErrorKind.TIMEOUT.value
        assert records[0].reported_kind == ProviderErrorKind.TIMEOUT.value

    @pytest.mark.asyncio
    async def test_a_configuration_fault_on_the_primary_survives_the_second_failure(
        self, async_client, pipeline, budget
    ):
        """A rejected credential on the primary is reported even though the fallback timed out."""
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.AUTH, ProviderErrorKind.TIMEOUT]

        body = (await post_chat(async_client, **with_models())).json()

        assert body["reason"] == FALLBACK_REASON_MODEL_UNAVAILABLE

    @pytest.mark.asyncio
    async def test_the_attempt_is_recorded_for_the_operator_but_not_for_the_client(
        self, async_client, pipeline, budget
    ):
        """Node must not learn that a failover was attempted, only that none served the turn."""
        service, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT, ProviderErrorKind.TIMEOUT]

        result = await service.process_chat(
            bot_id=BOT_ID,
            message=MESSAGE,
            model=PRIMARY,
            fallback_model=FALLBACK,
        )
        llm.reset()
        response = await post_chat(async_client, **with_models())

        assert result["debug"]["failover"]["attempted"] is True
        assert result["debug"]["failover"]["primary_kind"] == "RATE_LIMIT"
        # The debug block is what carries the attempt, and the route strips it wholesale.
        assert '"debug"' not in response.text
        assert "chat_failover" not in response.text
        assert "RATE_LIMIT" not in response.text

    @pytest.mark.asyncio
    async def test_the_debug_block_records_which_generation_was_raw(
        self, async_client, pipeline, budget
    ):
        """Diagnosis needs the sequence of decisions, not only the final reason."""
        service, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.BAD_REQUEST]

        result = await service.process_chat(
            bot_id=BOT_ID, message=MESSAGE, model=PRIMARY, fallback_model=FALLBACK
        )

        assert result["debug"]["failover"] == {
            "attempted": False,
            "skipped": "INELIGIBLE",
            "primary_kind": "BAD_REQUEST",
        }


# --------------------------------------------------------------------------------------
# The generation budget
# --------------------------------------------------------------------------------------


class TestTheGenerationBudget:
    @pytest.mark.asyncio
    async def test_the_fallback_is_capped_by_what_remains_of_the_budget(
        self, async_client, pipeline, budget, clock
    ):
        """10 s spent, 20 s budget: the fallback gets the remaining 10, not its adapter's 30."""
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT]
        clock.values = [100.0, 110.0]

        await post_chat(async_client, **with_models())

        assert budget == [10.0]

    @pytest.mark.asyncio
    async def test_an_immediate_primary_failure_leaves_the_whole_budget(
        self, async_client, pipeline, budget, clock
    ):
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT]
        clock.values = [100.0, 100.0]

        await post_chat(async_client, **with_models())

        assert budget == [20.0]

    @pytest.mark.asyncio
    async def test_below_the_floor_the_attempt_is_skipped_entirely(
        self, async_client, pipeline, budget, clock
    ):
        """18.5 s spent leaves 1.5 s: a call that would be killed mid-flight and still paid for."""
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT]
        clock.values = [100.0, 118.5]

        await post_chat(async_client, **with_models())

        assert budget == []
        assert llm.call_count == 1

    @pytest.mark.asyncio
    async def test_a_skipped_attempt_reports_the_primary_failure_immediately(
        self, async_client, pipeline, budget, clock
    ):
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT]
        clock.values = [100.0, 118.5]

        body = (await post_chat(async_client, **with_models())).json()

        assert body["reason"] == FALLBACK_REASON_MODEL_RATE_LIMITED
        assert body["failover_used"] is False

    @pytest.mark.asyncio
    async def test_a_skipped_attempt_is_logged_with_its_arithmetic(
        self, async_client, pipeline, budget, clock, caplog
    ):
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT]
        clock.values = [100.0, 118.5]

        with caplog.at_level("WARNING", logger="assistiq_ai"):
            await post_chat(async_client, **with_models())

        records = [
            r for r in caplog.records if getattr(r, "operation", None) == "chat_failover_skipped"
        ]
        assert len(records) == 1
        assert records[0].reason == "BUDGET_EXHAUSTED"
        assert records[0].remaining_seconds == 1.5

    @pytest.mark.asyncio
    async def test_exactly_the_floor_is_enough_to_attempt(
        self, async_client, pipeline, budget, clock
    ):
        """The floor is a minimum, not an exclusive bound: 17 s spent leaves exactly 3 s."""
        _, _, _, llm = pipeline
        llm.script = [ProviderErrorKind.RATE_LIMIT]
        clock.values = [100.0, 117.0]

        await post_chat(async_client, **with_models())

        assert budget == [3.0]
        assert llm.call_count == 2

    @pytest.mark.asyncio
    async def test_a_budget_cut_short_attempt_is_reported_as_a_timeout(
        self, async_client, pipeline, monkeypatch, clock
    ):
        """When the wait itself trips, the attempt failed as a TIMEOUT — because it did.

        The adapter never raises here: the call was still in flight when the budget ran out, so
        nothing inside the SDK knows it was abandoned. Reporting it as anything else would put
        the attempt outside the vocabulary the adapters' own timeouts use.

        The primary fails fast and the fallback never answers, because only the *fallback* is
        wrapped in the budget — a primary that hung would simply be the adapter's own timeout
        doing its job, which is a different test.
        """
        _, _, _, llm = pipeline
        clock.values = [100.0, 105.0]
        monkeypatch.setattr(chat_module.settings, "GENERATION_BUDGET_SECONDS", 20.0)
        monkeypatch.setattr(chat_module.settings, "FAILOVER_MIN_REMAINING_SECONDS", 3.0)

        attempts = {"n": 0}

        async def fail_then_hang(**kwargs):
            llm.calls.append(kwargs)
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise ProviderError(
                    ProviderErrorKind.RATE_LIMIT,
                    provider=PRIMARY.provider,
                    model_id=PRIMARY.model_id,
                )
            await asyncio.sleep(3600)

        monkeypatch.setattr(llm, "generate", fail_then_hang)

        # A tiny real wait, so the test does not depend on the budget being whole seconds.
        real_wait_for = asyncio.wait_for

        async def short_wait(awaitable, timeout=None):
            return await real_wait_for(awaitable, timeout=0.05)

        monkeypatch.setattr(chat_module.asyncio, "wait_for", short_wait)

        body = (await post_chat(async_client, **with_models())).json()

        assert attempts["n"] == 2
        assert body["reason"] == FALLBACK_REASON_MODEL_ERROR
        assert body["failover_used"] is False

    def test_the_floor_is_below_the_budget(self):
        """A floor at or above the budget would make every failover skippable."""
        from app.core.config import settings as real_settings

        assert 0 < real_settings.FAILOVER_MIN_REMAINING_SECONDS < real_settings.GENERATION_BUDGET_SECONDS
