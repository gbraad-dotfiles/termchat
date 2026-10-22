#!/usr/bin/env python3
"""Pack an unpacked extension into a signed CRX3 file.

CRX3 layout:
    "Cr24" | uint32le(3) | uint32le(header_len) | CrxFileHeader | zip

CrxFileHeader (protobuf) carries an RSA-SHA256 proof over

    "CRX3 SignedData\0" | uint32le(len(signed_data)) | signed_data | zip

where signed_data is SignedData{crx_id = sha256(public_key)[:16]}.

The signing key is kept outside dist/ so rebuilds keep the same extension ID:

    $XDG_CONFIG_HOME/terminal-chat/crx-key.pem   (default ~/.config/...)
"""

from __future__ import annotations

import hashlib
import os
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

SIGNATURE_CONTEXT = b"CRX3 SignedData\x00"


def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def field_bytes(number: int, payload: bytes) -> bytes:
    return varint((number << 3) | 2) + varint(len(payload)) + payload


def make_zip(src: Path) -> bytes:
    """Build a deterministic zip: sorted paths, fixed timestamps."""
    entries = sorted(
        p for p in src.rglob("*") if p.is_file() and not p.name.startswith(".")
    )
    buffer = tempfile.SpooledTemporaryFile()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in entries:
            info = zipfile.ZipInfo(path.relative_to(src).as_posix(), (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, path.read_bytes())
    buffer.seek(0)
    return buffer.read()


def run(cmd: list[str]) -> bytes:
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr.decode("utf-8", "replace"))
        raise SystemExit(f"command failed: {' '.join(cmd)}")
    return result.stdout


def extension_id(public_key: bytes) -> str:
    digest = hashlib.sha256(public_key).digest()[:16]
    return "".join(chr(ord("a") + (byte >> 4)) + chr(ord("a") + (byte & 0x0F)) for byte in digest)


def ensure_key(key_path: Path) -> None:
    if key_path.exists():
        return
    key_path.parent.mkdir(parents=True, exist_ok=True)
    run(["openssl", "genrsa", "-out", str(key_path), "2048"])
    key_path.chmod(0o600)
    print(f"generated signing key: {key_path}")


def main(argv: list[str]) -> int:
    if len(argv) not in (3, 4):
        print(f"usage: {argv[0]} EXTENSION_DIR OUTPUT.crx [KEY.pem]", file=sys.stderr)
        return 2

    src = Path(argv[1])
    output = Path(argv[2])
    if not (src / "manifest.json").is_file():
        print(f"{src}/manifest.json not found", file=sys.stderr)
        return 2

    config_home = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    key_path = Path(argv[3]) if len(argv) == 4 else config_home / "terminal-chat" / "crx-key.pem"
    ensure_key(key_path)

    public_key = run(["openssl", "pkey", "-in", str(key_path), "-pubout", "-outform", "DER"])
    crx_id = hashlib.sha256(public_key).digest()[:16]
    signed_data = field_bytes(1, crx_id)

    archive = make_zip(src)
    payload = (
        SIGNATURE_CONTEXT
        + struct.pack("<I", len(signed_data))
        + signed_data
        + archive
    )

    with tempfile.TemporaryDirectory() as tmp:
        payload_path = Path(tmp) / "payload"
        signature_path = Path(tmp) / "signature"
        payload_path.write_bytes(payload)
        run(
            [
                "openssl", "dgst", "-sha256", "-sign", str(key_path),
                "-out", str(signature_path), str(payload_path),
            ]
        )
        signature = signature_path.read_bytes()

    proof = field_bytes(1, public_key) + field_bytes(2, signature)
    header = field_bytes(2, proof) + field_bytes(10000, signed_data)

    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        handle.write(b"Cr24")
        handle.write(struct.pack("<I", 3))
        handle.write(struct.pack("<I", len(header)))
        handle.write(header)
        handle.write(archive)

    print(f"crx:          {output}")
    print(f"extension id: {extension_id(public_key)}")
    print(f"signing key:  {key_path}")
    print(f"size:         {output.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
