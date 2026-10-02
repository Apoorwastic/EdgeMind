"""The vault: Private notes, end-to-end encrypted, synced between one person's own devices.

Three levels of note, and where each one lives:

  device     "This device only" — the Qdrant Edge shard on this device's disk. Never sent anywhere.
  private    "Private" — the shard on each of the account's devices, plus an encrypted copy in the
             account's vault collection on the Qdrant Server (`<prefix>_vault_<account>`).
  shareable  "Team" — every device in that team, through the team's collection.

What the server holds for a Private note: its id, revision, timestamps, which device wrote it, and
an AES-256-GCM ciphertext of the text. No text, no vectors (embeddings leak meaning) — each device
decrypts and embeds the note itself. The key is derived from the account password with scrypt when
you sign in on a device, kept in that device's data folder (vault.key), and never sent: the server
can't read the notes, and neither can another account.
"""
import base64
import hashlib
import json
import os
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# The only fields a vault point carries in the clear. Everything else is inside the ciphertext.
SEALED_FIELDS = ("mem_id", "rev", "updated_ts", "updated_by", "from", "deleted", "nonce", "ct", "sealed")
VAULT_TEAM = "__vault__"  # marks vault retractions in the shared retraction queue


def derive_key(password: str, account_id: str) -> bytes:
    """Same password + same account → same key on every device; nothing about it is stored on a server."""
    return hashlib.scrypt(password.encode(), salt=f"edgemind-vault:{account_id}".encode(), n=2 ** 14, r=8, p=1, dklen=32)


class Vault:
    def __init__(self, account_id: str | None, data_dir: Path, prefix: str, suffix: str = ""):
        self.account = account_id
        self.collection = f"{prefix}_vault_{account_id}{suffix}" if account_id else None
        self.key_path = data_dir / "vault.key"
        self.key = base64.b64decode(self.key_path.read_text()) if self.key_path.exists() else None

    @property
    def enabled(self) -> bool:
        """This device belongs to an account (only then is there anywhere for Private notes to sync)."""
        return self.account is not None

    @property
    def unlocked(self) -> bool:
        return self.key is not None

    def unlock(self, password: str) -> None:
        """Called at sign-in, where the password is at hand. The key stays on this device."""
        key = derive_key(password, self.account)
        if key != self.key:
            self.key = key
            self.key_path.write_text(base64.b64encode(key).decode())

    def seal(self, rec: dict) -> dict:
        """The only way a Private note becomes a server payload: encrypted, allow-listed."""
        if rec.get("sensitivity") != "private":
            raise ValueError(f"refusing to seal a {rec.get('sensitivity')} record {rec.get('mem_id')}")
        body = {k: rec.get(k) for k in ("text", "ts", "supersedes", "superseded_by")}
        nonce = os.urandom(12)
        ct = AESGCM(self.key).encrypt(nonce, json.dumps(body).encode(), rec["mem_id"].encode())
        return {"mem_id": rec["mem_id"], "rev": rec.get("rev"), "updated_ts": rec.get("updated_ts"),
                "updated_by": rec.get("updated_by"), "from": rec.get("origin"), "sealed": True,
                "nonce": base64.b64encode(nonce).decode(), "ct": base64.b64encode(ct).decode()}

    def open(self, payload: dict) -> dict | None:
        """Decrypt a vault point; None if it isn't ours (wrong key) or was tampered with."""
        try:
            raw = AESGCM(self.key).decrypt(base64.b64decode(payload["nonce"]), base64.b64decode(payload["ct"]),
                                           payload["mem_id"].encode())
        except (InvalidTag, KeyError, ValueError):
            return None
        return json.loads(raw)
