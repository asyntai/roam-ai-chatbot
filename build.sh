#!/bin/bash
# Roam Depot runs this before it looks for extension.js.
set -e
npm ci --no-audit --no-fund
npm run build
