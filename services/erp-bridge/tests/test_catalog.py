import json
import os
import re

import pytest

from app import catalog as C


def test_never_exposed_actions_are_absent():
    assert not (set(C.CATALOG) & C.NEVER_EXPOSED)
    for a in ("post-gl-entries", "reverse-gl-entries", "install-module", "migrate", "set-credential", "initialize-database"):
        assert a not in C.CATALOG


def test_every_catalog_action_exists_in_the_pinned_tree():
    m = C.MANIFEST
    for spec in C.CATALOG.values():
        if spec.domain in ("module-manager",):
            continue
        if spec.module == C.FOUNDATION:
            assert m["foundation"]["router"].get(spec.name) == spec.domain, spec.name
            assert spec.name in m["foundation"]["domains"][spec.domain]["actions"], spec.name
        else:
            assert spec.module == C.GROWTH
            assert m["modules"][spec.module]["router"].get(spec.name) == spec.domain, spec.name
            assert spec.name in m["modules"][spec.module]["domains"][spec.domain]["actions"], spec.name


def test_only_the_crm_domain_of_growth_is_allowlisted():
    for spec in C.CATALOG.values():
        if spec.module == C.GROWTH:
            assert spec.domain == "erpclaw-crm", spec.name


def test_explicit_params_map_to_declared_flags():
    for spec in C.CATALOG.values():
        for p in C.admitted_params(spec):
            flag, _ = C.admitted_flag(spec, p)
            assert flag.startswith("--")


def test_deny_flags_are_never_admitted():
    spec = C.CATALOG["list-accounts"]
    for p in ("db_path", "company_id", "user_confirmed", "force", "csv_path", "action"):
        with pytest.raises(C.CatalogError):
            C.admitted_flag(spec, p)


def test_tier_and_gating_are_consistent_with_the_design_gate():
    assert C.CATALOG["submit-journal-entry"].dangerous and C.CATALOG["submit-journal-entry"].tier == "commit"
    assert C.CATALOG["cancel-sales-invoice"].tier == "high" and C.CATALOG["cancel-sales-invoice"].dangerous
    assert C.CATALOG["cancel-payment"].tier == "high"
    assert C.CATALOG["setup-company"].tier == "high" and not C.CATALOG["setup-company"].company_scoped
    assert C.CATALOG["add-lead"].tier == "draft" and not C.CATALOG["add-lead"].dangerous
    assert C.CATALOG["fetch-exchange-rates"].tier == "commit" and "frankfurter" in C.CATALOG["fetch-exchange-rates"].note
    for spec in C.CATALOG.values():
        # every ERPClaw-gated action must sit at Commit or High-risk — never Read/Draft
        if spec.dangerous:
            assert spec.tier in ("commit", "high"), spec.name


def test_dangerous_set_matches_the_vendored_router_when_available():
    root = os.environ.get("ERPCLAW_ROOT")
    if not root:
        pytest.skip("ERPCLAW_ROOT not set")
    src = open(os.path.join(root, "scripts", "db_query.py"), encoding="utf-8").read()
    m = re.search(r"DANGEROUS_ACTIONS\s*=\s*frozenset\(\{(.*?)\}\)", src, re.S)
    pinned = set(re.findall(r'"([a-z0-9\-]+)"', m.group(1)))
    assert pinned == set(C.DANGEROUS_ACTIONS)


def test_public_catalog_has_no_secrets_and_is_json():
    body = json.dumps(C.public_catalog())
    assert "postgresql://" not in body
    assert len(C.public_catalog()) == len(C.CATALOG) > 100
