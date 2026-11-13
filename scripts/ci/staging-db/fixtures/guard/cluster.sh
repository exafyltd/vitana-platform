#!/usr/bin/env bash
# guard fixture: a staging script that names the production cluster
aws rds describe-db-clusters --db-cluster-identifier vitana-aurora-prod
