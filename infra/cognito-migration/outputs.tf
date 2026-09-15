output "user_pool_id" {
  description = "Cognito User Pool ID — the gateway and frontend need this to verify/issue tokens against the right pool."
  value       = aws_cognito_user_pool.vitana.id
}

output "user_pool_arn" {
  value = aws_cognito_user_pool.vitana.arn
}

output "user_pool_endpoint" {
  description = "Issuer host for JWT `iss` claim validation (https://<this>/<user_pool_id>)."
  value       = aws_cognito_user_pool.vitana.endpoint
}

output "user_pool_client_id" {
  description = "App client ID the frontend and gateway use for USER_PASSWORD_AUTH / token refresh."
  value       = aws_cognito_user_pool_client.vitana.id
}

output "user_migration_lambda_arn" {
  value = aws_lambda_function.user_migration.arn
}

output "user_migration_lambda_name" {
  value = aws_lambda_function.user_migration.function_name
}
