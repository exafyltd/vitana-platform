# VTID-05516 acceptance (eng-platform-p01/oidc-roles)
Change types: Infrastructure/CI, Tooling/docs.
AC-1 Four trust files trust exactly the plan §3 subjects with StringEquals only, aud sts.amazonaws.com, no wildcard.
TEST: jest eng-platform-oidc-roles ("... trusts exactly the plan §3 subjects with StringEquals").
AC-2 Preview and drift permission files have no wildcard action or resource; the drift role reads only the claude-readonly secret.
TEST: jest ("has no wildcard action or resource", "the drift role can read only the claude-readonly secret ...").
AC-3 The script defaults to dry-run; every IAM write is behind --apply; it copies user, group and boundary policies; never creates/deletes keys or users.
TEST: jest ("reaches every IAM write only behind --apply", "copies group-inherited policies ...", "never creates access keys ...").
Staging proof: not verified on staging: the roles are created by the owner (plan §8 step 2).
