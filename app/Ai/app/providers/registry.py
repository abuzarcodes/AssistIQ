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

from app.providers.base import LLMProvider, ProviderError, ProviderErrorKind

#: Modules imported on first lookup, for their `register(...)` side effect. Order is
#: irrelevant — registration is keyed by slug, and a duplicate slug raises rather than
#: silently resolving to whichever imported last.
_BUILTIN_MODULES: Tuple[str, ...] = ("app.providers.openrouter",)

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
    """Import the built-in adapters once, for their registration side effect."""
    global _builtins_loaded
    if _builtins_loaded:
        return
    # Set before importing so a partially-initialised module cannot re-enter this.
    _builtins_loaded = True
    for module_name in _BUILTIN_MODULES:
        import_module(module_name)


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
