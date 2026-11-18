#!/usr/bin/env bash
# guard fixture: staging only
aws rds describe-db-clusters --db-cluster-identifier vitana-aurora-staging
