# User Migration Lambda trigger. Fires on two Cognito trigger sources:
#   - UserMigration_Authentication: a user just attempted USER_PASSWORD_AUTH
#     with an email Cognito doesn't have yet. This is the main path.
#   - UserMigration_ForgotPassword: a user asked for a password reset for an
#     email Cognito doesn't have yet.
# Implementation: lambda/index.js. Deliberately verifies the Authentication
# case by calling Supabase GoTrue's own password-grant endpoint (the same
# one services/gateway/src/routes/auth.ts already proxies to) rather than
# re-implementing bcrypt comparison against auth.users.encrypted_password —
# that defers entirely to GoTrue's own hashing/verification logic instead of
# duplicating it, and means this Lambda never needs a direct Postgres
# credential at all, only the same anon key the frontend already ships.

data "archive_file" "user_migration" {
  type        = "zip"
  source_dir  = "${path.module}/lambda"
  output_path = "${path.module}/build/user-migration.zip"
  excludes    = ["package-lock.json", "README.md"]
}

resource "aws_iam_role" "user_migration_exec" {
  name = "${var.name_prefix}-user-migration-lambda-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "user_migration_basic_exec" {
  role       = aws_iam_role.user_migration_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Scoped to exactly one secret — never a wildcard. This is the same secret
# named in var.supabase_service_role_secret_arn; the ForgotPassword branch
# is the only code path that ever reads it.
resource "aws_iam_role_policy" "user_migration_read_service_role_secret" {
  name = "${var.name_prefix}-user-migration-secrets-read"
  role = aws_iam_role.user_migration_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [var.supabase_service_role_secret_arn]
    }]
  })
}

resource "aws_lambda_function" "user_migration" {
  function_name = "${var.name_prefix}-cognito-user-migration"
  description   = "Cognito User Migration Lambda trigger — lazily migrates users off Supabase Auth (GoTrue) on first Cognito sign-in/forgot-password (VTID-03827)"

  filename         = data.archive_file.user_migration.output_path
  source_code_hash = data.archive_file.user_migration.output_base64sha256

  runtime = "nodejs20.x" # matches the vitana-push-dispatch Lambda convention (scripts/aws/setup-eventbridge-push-dispatch.sh)
  handler = "index.handler"
  role    = aws_iam_role.user_migration_exec.arn
  timeout = 15 # Cognito enforces its own ~5s trigger timeout on top of this; kept well under it deliberately

  environment {
    variables = {
      SUPABASE_URL                     = var.supabase_url
      SUPABASE_ANON_KEY                = var.supabase_anon_key
      SUPABASE_SERVICE_ROLE_SECRET_ARN = var.supabase_service_role_secret_arn
    }
  }

  tags = var.tags
}

resource "aws_lambda_permission" "allow_cognito_invoke" {
  statement_id  = "AllowCognitoInvokeUserMigration"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.user_migration.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.vitana.arn
}
