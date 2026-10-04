"""Deterministic detection of an explicit request for a human (plan §14.4).

One question, answered by phrase matching: *did the customer ask to speak to a person?*
Detection lives here because it is language work; what to **do** about it lives in Node,
which owns `humanRequestBehavior`. This module returns a boolean and nothing else — no
message, no status, no policy.

Not the escalation model
------------------------
`app/ml/escalation/model.py` also mentions escalation, and it answers a **different
question**: "should this turn be escalated?", from retrieval confidence. Using it here would
be a category error — a customer asking for a person and a customer whose answer was not
grounded are two unrelated events, and a model trained on the second cannot recognise the
first. This module is a small, readable phrase list on purpose: it is auditable, it is
testable case by case, and an owner can be told exactly what triggers it.

English only, and disabled rather than guessed
----------------------------------------------
A false negative is an ordinary conversation — the customer asks again, or the bot's own
fallback escalates them for another reason. A false positive escalates someone who did not
ask, which is visible, disruptive, and erodes trust in the escalation entirely. Given that
asymmetry, a bot configured to answer in a language this list does not cover gets **no
detection at all** rather than a guess: matching English phrases against, say, German text
would be theatre. `AUTO` and an absent language are not "a non-English language" — they mean
the bot mirrors the customer, so detection stays on.
"""

from typing import Optional, Tuple

#: The English phrases that constitute an explicit request for a human. Matched as
#: substrings of a whitespace-normalised, lower-cased message, so punctuation and casing are
#: free and "Talk to a human!" matches.
#:
#: Kept deliberately specific. Bare "human" or "agent" is not here — "is this a human or a
#: bot?" and "I spoke to an agent yesterday" are not requests, and a list that fires on them
#: would escalate conversations that are going perfectly well.
_HUMAN_REQUEST_PATTERNS: Tuple[str, ...] = (
    "talk to a human",
    "talk to human",
    "talk with a human",
    "speak to a human",
    "speak to human",
    "speak with a human",
    "chat to a human",
    "chat with a human",
    "connect me to a human",
    "connect me with a human",
    "connect me to a person",
    "connect me with a person",
    "talk to a person",
    "talk to real person",
    "talk to a real person",
    "speak to a person",
    "speak to a real person",
    "real person",
    "real human",
    "human agent",
    "human support",
    "human representative",
    "live agent",
    "live human",
    "customer service rep",
    "customer service representative",
    "customer support rep",
    "customer support representative",
    "speak to an agent",
    "speak with an agent",
    "talk to an agent",
    "talk with an agent",
    "speak to someone",
    "talk to someone",
    "speak with someone",
    "talk with someone",
)

#: Language tags that leave detection **enabled**: English itself, and the unset/AUTO states
#: in which the bot mirrors whatever language the customer writes in. Compared on the base
#: tag, so `en`, `EN`, `en-US` and `en_GB` all count.
_DETECTION_ENABLED_LANGUAGE_TAGS = frozenset({"", "auto", "en"})


def _is_english_or_unspecified(language: Optional[str]) -> bool:
    """Whether detection is allowed for `language`.

    Unknown tags are treated as non-English: Node validates `responseLanguage` against an
    allow-list this service does not share, so a tag arriving here that is not in the table
    above is one this code cannot vouch for, and the conservative answer for an unvouchable
    language is "do not guess".
    """
    if language is None:
        return True
    base_tag = language.strip().lower().replace("_", "-").split("-")[0]
    return base_tag in _DETECTION_ENABLED_LANGUAGE_TAGS


def detect_human_request(message: str, language: Optional[str] = None) -> bool:
    """Whether `message` explicitly asks to be put in touch with a person.

    `language` is the bot's configured `responseLanguage`. When it names a language other
    than English the detector is disabled, for the reason given in the module docstring.

    The message is lower-cased and whitespace-collapsed before matching, so line breaks,
    double spaces and shouting all normalise away. Nothing else is stripped: the match is a
    plain substring test, and a caller who writes "talk-to-a-human" writes something the
    list does not claim to cover.
    """
    if not _is_english_or_unspecified(language):
        return False

    normalised = " ".join(message.lower().split())
    return any(pattern in normalised for pattern in _HUMAN_REQUEST_PATTERNS)
