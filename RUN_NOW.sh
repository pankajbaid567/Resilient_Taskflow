#!/bin/bash

echo "════════════════════════════════════════════════════════════════"
echo "              TaskFlow - Quick Start Script                      "
echo "════════════════════════════════════════════════════════════════"
echo ""

# Navigate to project
cd /Users/pankajbaid/projects/Resilient_TaskFlow

echo "Step 1: Building workspace packages..."
echo "───────────────────────────────────────────────────────────────"
cd packages/config && pnpm build
cd ../types && pnpm build
cd ../logger && pnpm build
cd ../..
echo "✅ Packages built"
echo ""

echo "Step 2: Checking infrastructure..."
echo "───────────────────────────────────────────────────────────────"
docker ps | grep taskflow
echo ""

echo "✅ Infrastructure ready!"
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "Now open 4 SEPARATE terminal windows and run:"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Terminal 2:"
echo "  cd /Users/pankajbaid/projects/Resilient_TaskFlow && pnpm dev:api"
echo ""
echo "Terminal 3:"
echo "  cd /Users/pankajbaid/projects/Resilient_TaskFlow && pnpm dev:worker"
echo ""
echo "Terminal 4:"
echo "  cd /Users/pankajbaid/projects/Resilient_TaskFlow && pnpm dev:dashboard"
echo ""
echo "Terminal 5:"
echo "  cd /Users/pankajbaid/projects/Resilient_TaskFlow && pnpm demo"
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "Then open: http://localhost:5173 (Dashboard)"
echo "════════════════════════════════════════════════════════════════"
