# Design — i18n-audit-nightly-off
Pure removal plus one default change; see `plan.md` §Changes. `audit-single` keeps its `if:
github.event_name == 'workflow_dispatch'` guard, the `concurrency` group and the `permissions` block as they are.
