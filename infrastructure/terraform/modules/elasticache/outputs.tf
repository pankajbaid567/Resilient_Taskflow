output "primary_endpoint_address" {
  description = "Primary endpoint address"
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "reader_endpoint_address" {
  description = "Reader endpoint address"
  value       = aws_elasticache_replication_group.main.reader_endpoint_address
}

output "security_group_id" {
  description = "Security group ID"
  value       = aws_security_group.redis.id
}

output "auth_token_secret_arn" {
  description = "ARN of secret containing auth token"
  value       = aws_secretsmanager_secret.auth_token.arn
}

output "port" {
  description = "Redis port"
  value       = 6379
}
