"""Text helpers that make note search forgiving and fast, on top of Qdrant's dense + BM25 search.

* Typo correction: a question word that appears in no note ("plumbre") is replaced by the closest word
  that does ("plumber") when it is 1-2 edits away — unless it is a real English word ("full", "theory"),
  checked against the search model's own vocabulary. BM25 needs exact words, and a misspelling also drags
  the question's meaning vector away from the note.
* Word coverage: whether a note contains most of the question's meaningful words (used when a note's
  vector can't be compared, and to back up a "clear winner" match), with letter-trigram matching so a
  near-miss spelling still counts.
* Keyword fast path: when exactly one note contains every meaningful word of the question, it is the
  answer — no need to wait for the embedding model.

Notes are few per device (tens to a few thousand), so all of this is plain Python over a cached vocabulary.
"""
import json
import os
import re
from collections import Counter
from pathlib import Path

STOP = set("""a an the is are was were be been am i me my mine you your we our it its of to in on at for by with and
or but not no do does did what whats when where who whom which why how can could should would will shall may might
this that these those there here from about as into than then so if any some all tell give please thanks much many
get got have has had s t""".split())
PRONOUNS = set("he she him her his hers they them their theirs".split())


_POINTS_BACK = re.compile(r"\b(he|she|him|her|his|hers|it|its|they|them|their|theirs)\b", re.I)
_REFERS_BACK = re.compile(r"\b(that|this|those|these|there|same|one)\b", re.I)
_CONTINUES = re.compile(r"^\s*(and|also|what about|how about|what else|then|so|but)\b", re.I)


def followup_kind(question: str) -> str | None:
    """How strongly a question leans on the previous one.

    "pronoun": he/she/his/it/they… point back ("What's his number?" after "Who is the plumber?") — always
    search together with the previous question, even if the question alone matches something else strongly
    (alone, "his number" finds Dad's emergency number).
    "hint": "And the Wi-Fi password?", "that one", a one-word question — only used when the question alone
    finds no strong match, so a new question that merely looks like a follow-up stays on its own.
    """
    if _POINTS_BACK.search(question):
        return "pronoun"
    meaningful = [w for w in words(question) if w not in STOP]
    if _REFERS_BACK.search(question) or _CONTINUES.search(question) or len(meaningful) <= 1:
        return "hint"
    return None


def is_personal(question: str) -> bool:
    """Asks about the user's own things ("my", "our"): only their notes can answer, never general knowledge.
    "I"/"me" don't count: "How do I change a tyre?" is a general question."""
    return re.search(r"\b(my|our|mine|ours)\b", question, re.I) is not None


def words(text: str) -> list[str]:
    """Lower-case words; "Wi-Fi" → "wifi", "Grandma's" → "grandma"."""
    return re.findall(r"[a-z0-9]+", text.lower().replace("-", "").replace("'s", "").replace("’s", ""))


def stem(w: str) -> str:
    return re.sub(r"(ing|ed|es|s)$", "", w) if len(w) > 4 else w


def terms(text: str) -> set[str]:
    return {stem(w) for w in words(text) if w not in STOP}


def edit_distance(a: str, b: str, cap: int) -> int:
    """Damerau-Levenshtein (adjacent swaps count as one edit: "plumbre" → "plumber" is 1). Stops past `cap`."""
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev2, prev = None, list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cost = a[i - 1] != b[j - 1]
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                cur[j] = min(cur[j], prev2[j - 2] + 1)
        if min(cur) > cap:
            return cap + 1
        prev2, prev = prev, cur
    return prev[-1]


def trigrams(w: str) -> set[str]:
    w = f"  {w} "
    return {w[i:i + 3] for i in range(len(w) - 2)}


_REAL: set[str] | None = None


def real_words() -> set[str]:
    """English words, from the search model's own vocabulary (bge-small's WordPiece list, ~20k whole words).
    A question word found here is a real word, not a typo: "full" must not become the notes' "fully", nor
    "theory" become "they". Empty (no check) if the model files aren't on this machine."""
    global _REAL
    if _REAL is None:
        _REAL = set()
        roots = [os.getenv("FASTEMBED_CACHE_PATH"), Path(__file__).resolve().parent.parent / "data" / "models", "/opt/fastembed"]
        for root in filter(None, roots):
            for p in Path(root).glob("**/tokenizer.json"):
                if "bge" in str(p).lower():
                    try:
                        vocab = json.loads(p.read_text(encoding="utf-8"))["model"]["vocab"]
                    except (OSError, ValueError, KeyError):
                        continue
                    _REAL = {w for w in vocab if w.isalpha() and len(w) >= 3}  # whole words, not "##" pieces
                    return _REAL
    return _REAL


class Vocabulary:
    """Words used in this device's notes, rebuilt only when the notes change."""

    def __init__(self):
        self.version = None
        self.counts: Counter = Counter()
        self.stems: set[str] = set()
        self.note_terms: dict[str, set[str]] = {}

    def refresh(self, version: int, records: list[dict]) -> None:
        if version == self.version:
            return
        self.counts = Counter(w for r in records for w in words(r["text"]) if len(w) >= 3)
        self.stems = {stem(w) for w in self.counts}
        self.note_terms = {r["mem_id"]: terms(r["text"]) for r in records}
        self.version = version

    def correct(self, question: str) -> tuple[str, dict[str, str]]:
        """The question with unknown words replaced by the closest note word. Returns (question, {typo: fix})."""
        fixes = {}
        for w in set(words(question)):
            if len(w) < 4 or w in STOP or w.isdigit() or w in self.counts or stem(w) in self.stems or w in real_words():
                continue  # short, filler, a number, a word the notes use, or a real word (not a typo)
            cap = 1 if len(w) <= 5 else 2
            best = None
            for cand, n in self.counts.items():
                # Typos rarely change the first letter; requiring it keeps general questions from being "corrected"
                # into note words.
                if cand[0] != w[0] or abs(len(cand) - len(w)) > cap or cand in STOP or cand in PRONOUNS:
                    continue  # never "correct" into a filler word: "theory" is not a typo of "they"
                d = edit_distance(w, cand, cap)
                if d == 2 and len(cand) <= 4:
                    continue  # two edits from a short word reach far too many real words
                # Two edits can turn many words into others ("tallest" → "tablet"); then also ask that most of
                # the word's letter-trigrams survive (typos keep them: "granmas"/"grandma" 0.33, that pair 0.15).
                if d == 2 and len(trigrams(w) & trigrams(cand)) / len(trigrams(w) | trigrams(cand)) < 0.3:
                    continue
                if d <= cap and (best is None or (d, -n) < (best[0], -best[1])):
                    best = (d, n, cand)
            if best:
                fixes[w] = best[2]
        if not fixes:
            return question, {}
        fixed = re.sub(r"[A-Za-z0-9'’-]+", lambda m: fixes.get(words(m.group())[0] if words(m.group()) else "", m.group()), question)
        return fixed, fixes

    def expand(self, question: str) -> list[str]:
        """Note words to search for alongside a real word that's a longer or shorter form of them: "project"
        also searches "projector" (the user meant the projector note). Never replaces the word, so "full
        form" stays "full form" in what the model reads; it only widens the search."""
        extra = set()
        real = real_words()
        for w in set(words(question)):
            if len(w) < 4 or w in STOP or w in self.counts or stem(w) in self.stems or w not in real:
                continue
            for cand in self.counts:
                if (cand not in STOP and cand not in PRONOUNS and 0 < abs(len(cand) - len(w)) <= 3
                        and (cand.startswith(w) or w.startswith(cand)) and min(len(w), len(cand)) >= 4):
                    extra.add(cand)
        return sorted(extra)

    def covers(self, question: str, mem_id: str, share: float = 0.6) -> bool:
        """Does the note contain at least `share` of the question's meaningful words (trigram near-misses count)?"""
        want = terms(question)
        have = self.note_terms.get(mem_id, set())
        if not want or not have:
            return False
        hit = 0
        for w in want:
            if w in have or any(len(trigrams(w) & trigrams(h)) / len(trigrams(w) | trigrams(h)) >= 0.5 for h in have):
                hit += 1
        return hit >= max(1, -(-len(want) * round(share * 10) // 10))  # share of the words, rounded up

    def only_note_with_all(self, question: str) -> str | None:
        """mem_id of the single note that contains every meaningful word of a 2+ word question, else None."""
        want = terms(question)
        if len(want) < 2:
            return None
        found = [m for m, have in self.note_terms.items() if want <= have]
        return found[0] if len(found) == 1 else None
