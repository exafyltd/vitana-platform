#!/usr/bin/env python3
"""Print a PostgreSQL SCRAM-SHA-256 password verifier for the password on stdin.

Used by aurora-realtime-set-password.sh (VTID-05023, plan part 7a) so that only
the verifier — never the plaintext — is sent to Aurora in ALTER ROLE ... PASSWORD,
the same thing psql's \\password does. Also used by the local delivery test, which
proves Postgres accepts the verifier and Realtime logs in with the plaintext.
"""
import base64
import hashlib
import hmac
import os
import sys

ITERATIONS = 4096


def verifier(password: bytes, salt: bytes, iterations: int = ITERATIONS) -> str:
    salted = hashlib.pbkdf2_hmac("sha256", password, salt, iterations)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"SCRAM-SHA-256${iterations}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}"


def main() -> None:
    password = sys.stdin.read().rstrip("\n").encode()
    if len(password) < 32:
        sys.exit("password is shorter than 32 characters")
    if b"'" in password or b"\\" in password:
        sys.exit("password contains a quote or backslash")
    print(verifier(password, os.urandom(16)))


if __name__ == "__main__":
    main()
