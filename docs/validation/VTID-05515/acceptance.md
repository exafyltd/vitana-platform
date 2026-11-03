# VTID-05515 acceptance (eng-platform-p01/aws-inventory)
Change types: Infrastructure/CI, Tooling/docs.
AC-1 The script runs in strict mode and refuses any account other than 472838866351 before any other AWS call (exit 4).
TEST: jest eng-platform-inventory-readonly ("refuses to run against any account but 472838866351"); real run without credentials, exit 4.
AC-2 Every AWS call goes through run() with a describe-/list-/get- verb; aws is called directly only for get-caller-identity.
TEST: jest ("only calls describe-*, list-* and get-* APIs through run()", "calls aws directly only ...").
AC-3 No secret value, decrypted parameter, upload or mutating verb.
TEST: jest ("never reads secret values, decrypts parameters, uploads or mutates").
AC-4 IAM users are listed with access keys, groups, group policies and boundary (sparring R1-F2 of session 8cc4dc48).
TEST: jest ("lists IAM users with their groups, group policies and permissions boundary").
Staging proof: not verified on staging: a local script the owner runs, deploys nothing; covered by the Jest file and the real runs.
