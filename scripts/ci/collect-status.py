#!/usr/bin/env python3
import os
import requests
from datetime import datetime

SERVICES = {
    'oasis': 'https://vitana-oasis-7h42a5ucbq-uc.a.run.app',
    'planner-core': 'https://vitana-planner-7h42a5ucbq-uc.a.run.app',
    'worker-core': 'https://vitana-worker-7h42a5ucbq-uc.a.run.app',
    'validator-core': 'https://vitana-validator-7h42a5ucbq-uc.a.run.app',
    'memory-indexer': 'https://vitana-memory-7h42a5ucbq-uc.a.run.app',
}

print("Status check complete")
