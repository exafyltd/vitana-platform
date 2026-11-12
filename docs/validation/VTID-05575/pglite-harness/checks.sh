#!/bin/bash
exec node "$(cd "$(dirname "$0")" && pwd)/checks.mjs"
