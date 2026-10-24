#!/bin/bash
set -e

NAME="termchat"
OUTPUT="${1:-termchat-arm64}"

echo "Building ARM64 binary (raspi/ampere)..."
GOOS=linux GOARCH=arm64 go build -o "${OUTPUT}" .
echo "Built: ${OUTPUT}"
