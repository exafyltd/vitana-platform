# VTID-03894 — Acceptance (Maxina supplier self-service, gateway + schema)

Scope of THIS PR: `services/gateway/src/**`, `services/gateway/test/**` and the
four `supabase/migrations/**` files. The frontend half — registration, the
manual product form, the sales-model card — ships in `exafyltd/vitana-v1#1084`.

Verification tokens: `TEST` = a jest suite in `services/gateway/test/`,
`CURL` / `CURL_PROOF` = an HTTP contract.

**On the runtime CURLs.** These routes are deployed nowhere yet: merging reaches
staging, and this repo forbids probing production. So the CURLs below are the
commands to run against `preview-aws-gateway.vitanaland.com` once this merges
and `AWS-STAGE-DEPLOY-GATEWAY.yml` completes — not captured responses. This
follows `docs/validation/VTID-03237/`, whose own header records the same
sequencing ("the runtime CURLs are gated on the data PR being merged first").
Writing an invented response here to turn a gate green would be the exact
failure VTID-03696 exists to prevent.

**On local test runs.** The npm registry is blocked in this environment (403),
so neither repo has `node_modules` and neither jest nor vitest can run here. The
assertions in each suite below were additionally executed in plain Node against
the real source files — see `outputs/guard-assertions.txt`. CI runs the suites;
this repo's CI is the authority, not this document.

---

AC-1 — A self-registered supplier's products can never settle from a member's wallet
  TEST: services/gateway/test/routes/supplier-source-network.test.ts
        asserts !FIRST_PARTY_SOURCE_NETWORKS.has(SUPPLIER_SOURCE_NETWORK),
        that the value is not the old 'manual', that 'manual' really IS
        first-party, and pins the first-party set to exactly {manual, partner}
        so widening it later fails loudly instead of silently moving money.
  TEST: outputs/pg16-harness.txt — a merchant and product written through the
        route's exact insert shapes report checkout_routing = "affiliate
        (clicks out to their own shop)", not first-party.

AC-2 — A supplier may only claim an affiliate network that can actually attribute a sale
  TEST: services/gateway/test/routes/supplier-attributing-networks.test.ts
        pins ATTRIBUTING_NETWORKS to exactly {awin, admitad} by equality (not
        containment), rejects cj/rakuten/impact/partnerize/tradedoubler/amazon,
        and asserts each claimed path still exists in source — admitad's
        postback route and awin's creditAwinConversions.

AC-3 — Naming a network without an advertiser id is refused
  TEST: MerchantSchema's refine in src/routes/vcaop-portal-my-products.ts
        requires affiliate_advertiser_id whenever affiliate_network is not
        'other'. Without it a pulled Awin conversion cannot resolve to this
        merchant, so the supplier would see a connection that attributes nothing.
  CURL: POST {gateway}/api/v1/vcaop/portal/my/merchants
        -d '{"name":"X","vertical_key":"wine_spirits","affiliate_network":"awin"}'
        -> 400 (advertiser id required)

AC-4 — Every endpoint is authenticated and scoped to the calling supplier
  TEST: router.use(requireAuth) at src/routes/vcaop-portal-my-products.ts:35;
        every read and write resolves the merchant by owner_user_id from the
        JWT (findOwnMerchant), never from a client-supplied id.
  CURL: GET {gateway}/api/v1/vcaop/portal/my/products with no Bearer -> 401 JSON
  CURL: GET {gateway}/api/v1/vcaop/portal/my/products as a second user
        -> 200 with that user's own (empty) list, never the first user's rows

AC-5 — Nothing a supplier types reaches Discover on their own say-so
  TEST: outputs/pg16-harness.txt — the inserted product is is_active=false and
        its merchant is onboarding_status='draft'. Discover filters on
        is_active=true (routes/discover-feed.ts:151, discover-search.ts:216),
        so a draft product is unreachable until an admin flips it.

AC-6 — The form's questions come from the database, not from hardcoded verticals
  TEST: outputs/pg16-harness.txt — 10 verticals, 37 fields, with 'other'
        deliberately carrying none (a catch-all that asks questions is a
        catch-all nobody picks).
  CURL: GET {gateway}/api/v1/vcaop/portal/my/verticals
        -> 200 { ok:true, verticals:[...] } each with its fields and vocabulary

AC-7 — A vertical field that offers choices must say where the choices come from
  TEST: outputs/pg16-harness.txt — the CHECK rejects an enum field with a null
        vocabulary, AND accepts a text field with one, so the constraint is
        demonstrated to discriminate rather than to reject everything. (An
        earlier run of this check gave a false "accepted" because the UPDATE
        touched zero rows on an empty table; this version inserts first.)

AC-8b — A product must ship somewhere, on PATCH as well as on POST
  TEST: services/gateway/test/routes/supplier-ships-somewhere.test.ts
        POST enforces this through a zod refine. PATCH could not: .refine()
        returns a ZodEffects and ZodEffects has no .partial(), so the patch
        body is built from the plain object and the refine does not come with
        it. (That was a real compile error — `npm run build` caught it where
        the jest suite did not, because ts-jest transpiles without
        typechecking.) The check is also not decidable from a patch alone:
        clearing ships_to_countries is valid when the row already ships to a
        region. So the handler merges the patch over the stored row, scoped by
        merchant_id, and this pins the predicate that decision rests on.

AC-8 — The migrations apply cleanly from scratch, are additive, and are RLS-protected
  TEST: outputs/pg16-harness.txt — all four applied with ON_ERROR_STOP=1
        against real production table definitions for merchants, products and
        catalog_vocabulary. No existing row is rewritten and nothing is dropped.
        Existing health columns were deliberately NOT moved into the new
        attributes JSONB: user_limitations hard-filters on contains_allergens
        and contraindicated_with_*, and a JSONB round trip there would change
        who is shown what.
  TEST: outputs/pg16-harness.txt, "FOLLOW-UP: RLS" — the two new tables carry
        the same policy shape as catalog_vocabulary (authenticated SELECT on
        active rows, service_role ALL). They shipped without it; the Supabase
        security advisor caught it, and 20260915132000 closes it.

# ---------------------------------------------------------------------------
# Route Mount Evidence
# ---------------------------------------------------------------------------

ROUTE_MOUNT: services/gateway/src/routes/vcaop-portal-my-products.ts →
  router.get('/verticals'), router.post('/merchants'), router.get('/products'),
  router.post('/products'), router.patch('/products/:id');
  required at src/index.ts:329 and mounted at src/index.ts:747 via
  mountRouterSync(app, '/api/v1/vcaop/portal/my', …, { owner: 'vcaop-portal-my-products' })

FINAL_URL: GET  {gateway}/api/v1/vcaop/portal/my/verticals
           POST {gateway}/api/v1/vcaop/portal/my/merchants
           GET  {gateway}/api/v1/vcaop/portal/my/products
           POST {gateway}/api/v1/vcaop/portal/my/products
           PATCH {gateway}/api/v1/vcaop/portal/my/products/:id

CURL_PROOF: curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' \
  "https://preview-aws-gateway.vitanaland.com/api/v1/vcaop/portal/my/verticals"
  Expected: "401 application/json…" — auth required, but a JSON body proves the
  route exists. An HTML 404 would mean the route is not on the deployed code
  (§15's diagnostic). NOT YET RUN: the route is undeployed, and this proof runs
  against staging after merge, never against production.
