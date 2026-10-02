"""The provider layer: adapters, their contract, and the registry that resolves them.

Import from here rather than from the submodules, so the public surface of the layer
is one place:

    from app.providers import LLMProvider, ProviderModelRef, ProviderError, get_provider

Adapter classes are deliberately **not** re-exported. They are loaded by the registry,
on first slug lookup, which is what keeps a vendor SDK out of every code path that never
names a model. Reach for a concrete adapter directly when you need one
(`from app.providers.openrouter import OpenRouterProvider`) — the registry is the normal
route.
"""

from app.providers.base import (
    LLMProvider,
    ProviderError,
    ProviderErrorKind,
    ProviderModelRef,
)
from app.providers.registry import (
    get_provider,
    is_supported,
    register,
    registered_providers,
    registered_slugs,
)

__all__ = [
    "LLMProvider",
    "ProviderError",
    "ProviderErrorKind",
    "ProviderModelRef",
    "get_provider",
    "is_supported",
    "register",
    "registered_providers",
    "registered_slugs",
]
