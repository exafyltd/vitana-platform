# VTID-04328 — monthly AWS cost budgets (Orchestrator plan §8.6)

Owner decision, 2026-09-23: set a moderate monthly budget for AWS, including
Claude. It should not exceed 6,000 USD for now and may grow over time to at
most 10,000 USD.

Claude runs on Bedrock (CLAUDE.md ALWAYS 10a), so it is billed on the AWS
invoice. DeepSeek is billed outside AWS, so these budgets do not cover it.

AC-1: A dry run (the default) prints the three budgets it would create and
changes nothing:
- operating: 6,000 USD, alerts at 50%, 80% and 100% actual, and at 100% forecast;
- ceiling: 10,000 USD, alerts at 90% and 100% actual, and at 100% forecast;
- Bedrock slice: 2,500 USD, alerts at 80% and 100% actual.
TEST: docs/validation/VTID-04328/outputs/dry-run.txt

AC-2: The script refuses the following, each with a non-zero exit:
- an operating limit above the 10,000 USD ceiling;
- a Bedrock limit above the operating limit;
- a missing alert email.
TEST: docs/validation/VTID-04328/outputs/dry-run.txt

AC-3: The Bedrock budget's service filter can be configured. The reason:
Anthropic models on Bedrock can appear in Cost Explorer as their own
Marketplace service lines rather than under "Amazon Bedrock". The operating
and ceiling budgets have no filter, so they cover Claude spend either way.
TEST: docs/validation/VTID-04328/outputs/dry-run.txt

## Not done here
`--apply` must be run by the owner. The session identity
`claude-code-aws-agent` is explicitly denied `budgets:*` and `ce:*` by its
permissions boundary. Because of that same denial, the exact Cost Explorer
service names for Claude on Bedrock could not be read from this session.
