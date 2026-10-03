"""Adapter registry: the one place a provider slug becomes an adapter.

The registry is a plain dictionary populated by import side effect. Built-in adapters
are imported lazily, on first lookup, for two reasons:

1. Importing an adapter pulls in its vendor SDK (`langchain-openai` and its HTTP
   stack). Code paths that never name a model — the classifier, retrieval, the
   embedding service — should not pay for that.
2. An adapter module that cannot import because an optional SDK is missing should
   break *that adapter*, not the whole service.

Nothing here contacts a provider. `is_configured` reads settings; lookup reads a dict.
"""

from importlib import import_module
from typing import Dict, List, Tuple

from app.core.logging import format_log_context, logger
from app.providers.base import LLMProvider, ProviderError, ProviderErrorKind

#: Modules imported on first lookup, for their `register(...)` side effect. Order is
#: irrelevant — registration is keyed by slug, and a duplicate slug raises rather than
#: silently resolving to whichever imported last.
#:
#: Each entry here must have a matching `ai_providers` row (see `prisma/seed.ts`) whose
#: `slug` is spelled identically: the slug is the whole contract between the catalog, the
#: descriptor Node sends, and the adapter. A slug present here with no row is an adapter
#: nobody can select; a row with no adapter here reports `adapterAvailable: false` on the
#: platform dashboard, which is the intended, actionable way to say "deploy the adapter".
#:
#: A module listed here whose vendor SDK is missing breaks *that adapter only* — the
#: import failure is contained by the lazy load, and the other providers keep working.
_BUILTIN_MODULES: Tuple[str, ...] = (
    "app.providers.openrouter",
    "app.providers.openai",
    "app.providers.groq",
    "app.providers.gemini",
    "app.providers.openai_compatible",
)

_PROVIDERS: Dict[str, LLMProvider] = {}

_builtins_loaded = False


def register(provider: LLMProvider) -> None:
    """Register an adapter under its own `slug`.

    Built-ins are loaded first, so a late registration can never shadow one and the
    precedence between a built-in and anything registered later is fixed rather than
    dependent on which happened to run first. That is also why the duplicate check below
    can be unconditional.

    Registering the same slug twice raises: two adapters claiming one slug is a bug that
    would otherwise resolve silently to whichever registered last, making the behaviour of
    a request depend on import order.

    Re-registering the *same instance* is allowed — the lazy loader may import a module
    more than once across a test run, and that must be a no-op rather than a crash.
    """
    _load_builtins()

    existing = _PROVIDERS.get(provider.slug)
    if existing is not None and existing is not provider:
        raise ValueError(f"Duplicate provider slug: {provider.slug!r}")

    _PROVIDERS[provider.slug] = provider


def _load_builtins() -> None:
    """Import the built-in adapters once, for their registration side effect.

    A module that fails to import is **skipped, not propagated**. Letting it escape would
    turn one adapter's import fault — a dependency it imports at module scope, a broken
    edit — into an outage of `GET /ai/status` and of every *other* provider's lookup, which
    is the opposite of what the lazy load is for. (Our adapters import their vendor SDK
    inside the call rather than at module scope, so a merely absent SDK does not trip this;
    the guard is what makes the containment true for any adapter that does import at module
    scope, including one added later.)

    Skipped means the slug never registers, which the platform dashboard already reports
    as `adapterAvailable: false` — the intended, actionable signal for "deploy the
    adapter". It is deliberately not swallowed silently: the warning names the module and
    the import error, neither of which can carry a credential.
    """
    global _builtins_loaded
    if _builtins_loaded:
        return
    # Set before importing so a partially-initialised module cannot re-enter this.
    _builtins_loaded = True
    for module_name in _BUILTIN_MODULES:
        try:
            import_module(module_name)
        except ImportError as err:
            logger.warning(
                "Provider adapter %s failed to import and is unavailable: %s",
                module_name,
                err,
                extra=format_log_context(
                    operation="provider_registry_load",
                    provider=module_name,
                    error_type=err.__class__.__name__,
                ),
            )


def registered_slugs() -> List[str]:
    """Every slug with an adapter, sorted. This is readiness *axis 1*: the adapter
    exists because it is in this list."""
    _load_builtins()
    return sorted(_PROVIDERS)


def is_supported(slug: str) -> bool:
    """Whether an adapter is registered for `slug`. Cheap; used to validate a
    descriptor without catching an exception."""
    _load_builtins()
    return slug in _PROVIDERS


def get_provider(slug: str) -> LLMProvider:
    """Return the adapter for `slug`, or raise `ProviderError(UNKNOWN_PROVIDER)`.

    Raising rather than returning `None` keeps the caller honest: every call site wants
    an adapter, and a `None` return would push an `if adapter is None` branch into each
    of them, one of which would eventually forget.
    """
    _load_builtins()

    provider = _PROVIDERS.get(slug)
    if provider is None:
        raise ProviderError(
            ProviderErrorKind.UNKNOWN_PROVIDER,
            message=(
                f"No adapter is registered for provider {slug!r}. "
                f"Registered: {registered_slugs() or 'none'}."
            ),
            provider=slug,
        )

    return provider


def registered_providers() -> List[LLMProvider]:
    """Every registered adapter, ordered by slug. Backs `GET /ai/status`, which reports
    each adapter's configuration state."""
    _load_builtins()
    return [_PROVIDERS[slug] for slug in sorted(_PROVIDERS)]
