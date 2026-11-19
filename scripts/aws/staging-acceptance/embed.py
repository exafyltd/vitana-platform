#!/usr/bin/env python3
"""VTID-05803: embed scripts/aws/staging-acceptance/k5.py into the acceptance job file as xz+base64 with its sha256.

  python3 scripts/aws/staging-acceptance/embed.py            rewrite K5_PY / K5_PY_SHA256 in the job file
  python3 scripts/aws/staging-acceptance/embed.py --check    write nothing; exit 3 when the embedded runner differs from
                                                             k5.py, or the ECS override would exceed 8192 bytes
The ECS RunTask override (command + environment) is limited to 8192 bytes; the job refuses larger ones at run time too.
Standard library only.
"""
import base64, hashlib, json, lzma, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SRC = os.path.join(ROOT, "scripts/aws/staging-acceptance/k5.py")
JOB = os.path.join(ROOT, "infra/gitlab-engineering/ci/vtid-05803-acceptance.gitlab-ci.yml")
LIMIT = 8192


def payload(data):
    return base64.b64encode(lzma.compress(data, preset=9 | lzma.PRESET_EXTREME)).decode()


def override_bytes(text, b64, sha):
    cmd = re.search(r"^      CMD='(.*)'$", text, re.M)
    if not cmd:
        raise SystemExit("embed: CMD line not found in the job file")
    run = "20991231T235959Z-k5-acceptance-schema-only"
    env = [("K5_PY", b64), ("K5_PY_SHA256", sha), ("K5_RUN", run),
           ("K5_OUT", "s3://vitana-code-index/vtid-05803/staging/runs/" + run), ("K5_DATA", "schema-only")]
    ov = {"containerOverrides": [{"name": "migrate", "command": json.loads(cmd.group(1)),
                                  "environment": [{"name": k, "value": v} for k, v in env]}]}
    return len(json.dumps(ov, separators=(",", ":")).encode())


def main(argv):
    check = "--check" in argv
    data = open(SRC, "rb").read()
    sha = hashlib.sha256(data).hexdigest()
    text = open(JOB, encoding="utf-8").read()
    m_py = re.search(r'^    K5_PY: "([A-Za-z0-9+/=]+)"$', text, re.M)
    m_sha = re.search(r'^    K5_PY_SHA256: "([0-9a-f]{64})"$', text, re.M)
    if not m_py or not m_sha:
        print("embed: K5_PY / K5_PY_SHA256 not found in the job file"); return 2
    embedded = lzma.decompress(base64.b64decode(m_py.group(1)))
    current = embedded == data and m_sha.group(1) == sha
    if check:
        size = override_bytes(text, m_py.group(1), m_sha.group(1))
        ok = current and size < LIMIT
        print(f"{'ok' if current else 'drift'}   embedded runner {'equals' if current else 'differs from'} k5.py "
              f"(sha256 {sha[:12]}, embedded {hashlib.sha256(embedded).hexdigest()[:12]}); ECS override {size} bytes (limit {LIMIT})")
        return 0 if ok else 3
    b64 = payload(data)
    size = override_bytes(text, b64, sha)
    if size >= LIMIT:
        print(f"embed: ECS override would be {size} bytes (limit {LIMIT}); shrink k5.py"); return 3
    text = text[:m_py.start(1)] + b64 + text[m_py.end(1):]
    text = re.sub(r'^(    K5_PY_SHA256: ")[0-9a-f]{64}(")$', lambda m: m.group(1) + sha + m.group(2), text, flags=re.M)
    open(JOB, "w", encoding="utf-8").write(text)
    print(f"written {os.path.relpath(JOB, ROOT)}: runner sha256 {sha[:12]}, ECS override {size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
