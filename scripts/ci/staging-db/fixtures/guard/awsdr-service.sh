#!/usr/bin/env bash
# guard fixture: a staging script that updates a production ECS service
aws ecs update-service --cluster Vitana-ECS-Cluster --service vitana-gateway-awsdr --force-new-deployment
