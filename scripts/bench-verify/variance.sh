#!/bin/bash
# A second pass over the cells that have too few runs to trust.
#
# The 27B has seventeen runs and sits at 1% faulted; every other model has
# between two and seven, and a mixed gemma result came back that variance
# explains as easily as the fix does. This turns "maybe" cells into facts.
#
# Usage: bash scripts/bench-verify/variance.sh <log-file>
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${1:-variance.log}"
cd "C:/Users/Owner/Desktop/Anodex4" || exit 1
say() { echo "" | tee -a "$LOG"; echo "===== $* =====" | tee -a "$LOG"; }

for MODEL in gemma Muse DeepSeek-R1 Devstral; do
  say "$MODEL - second pass"
  bash "$HERE/run-suite.sh" "$MODEL" bench-1-single-file bench-3-fix-existing bench-4-large-multi-file bench-5-rust 2>&1 | tee -a "$LOG"
done

say "VARIANCE PASS COMPLETE"
