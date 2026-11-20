Change types: Infrastructure/CI.

# Acceptance — VTID-05774 (agentic-delivery-scope / lane `bedrock-invoke-policy`)

Outcome: the owner can give a Kiro session role the Bedrock rights of the delivery model chains with two commands:
M1 sparring and M4 review (Opus 5.5, Sonnet 5.5, Opus 4.6, Sonnet 4.6) and M5 vision (Opus 4.6), through the EU geo
inference profiles, plus DeepSeek V3.2 in `eu-north-1` (option A; the config default stays off). The policy file is
`scripts/aws/iam/delivery-bedrock-invoke-policy.json`. Nothing in this lane changes IAM. Today the session role
`kiro-agent-role` has only `BedrockInvokeAnthropicEU` v1 (Sonnet 4.6 and Opus 4.5), so every other chain model is
AccessDenied.

AC-1: Red on base. `scripts/aws/test/test_delivery_bedrock_policy.py` fails on `origin/main`, where the policy file does
not exist: 8 tests, 8 failures.
TEST: `python3 -m unittest discover -s scripts/aws/test -p 'test_delivery_bedrock_policy.py' -v` without the policy file (exit 1; `outputs/red.txt`)

AC-2: Green with the policy, 8 of 8: Allow only; actions exactly `bedrock:InvokeModel` and
`bedrock:InvokeModelWithResponseStream`; no wildcard; every resource in one of the six EU destination Regions that
`aws bedrock get-inference-profile` lists for the four profiles (eu-central-1, eu-north-1, eu-south-1, eu-south-2,
eu-west-1, eu-west-3); the four chain profiles in eu-central-1 of 472838866351; each chain model in all six Regions;
DeepSeek V3.2 only in eu-north-1; nothing else.
TEST: `python3 -m unittest discover -s scripts/aws/test -p 'test_delivery_bedrock_policy.py' -v` on this branch (exit 0; `outputs/green.txt`)

AC-3: The other tests of the folder still pass (85 tests, the discovery `AURORA-PRIVILEGE-PARITY-UNIT.yml` runs).
TEST: `python3 -m unittest discover -s scripts/aws/test -p 'test_*.py'` (exit 0; `outputs/all-aws-tests.txt`)

AC-4: IAM's own evaluator agrees: all 58 action and resource pairs of the policy are allowed; Opus 5.5 in us-east-1 and
eu-west-2 (London), the global Opus 5.5 profile and DeepSeek V3.2 in us-east-1 are implicit denies; non-invoke actions
are implicit denies.
TEST: `aws iam simulate-custom-policy --policy-input-list "$(cat scripts/aws/iam/delivery-bedrock-invoke-policy.json)" …` (read-only; `outputs/simulate.txt`)

States / Surfaces / Locales / Accessibility: n/a, no UI. Contract: an IAM identity policy (version 2012-10-17),
created as the customer-managed policy `vitana-delivery-bedrock-invoke`. Staging proof: not verified on staging; the
change deploys nothing and applies nothing. The owner's apply, check and rollback commands are in the PR body.
