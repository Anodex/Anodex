#!/bin/bash
# Run a long sequence of benchmark suites without supervision.
#
# One suite at a time hands control back after every model, which turns a
# multi-hour matrix into a stop-start conversation. This chains the whole
# remaining plan into a single unattended pass and appends every result to one
# log, so the work continues whether or not anyone is watching it.
#
# Usage: bash scripts/bench-verify/overnight.sh <log-file>
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${1:-overnight.log}"
cd "C:/Users/Owner/Desktop/Anodex4" || exit 1

say() { echo "" | tee -a "$LOG"; echo "===== $* =====" | tee -a "$LOG"; }

setctx() {
  python - "$1" "$2" <<'PY'
import io, json, os, sys
f = os.path.join(os.environ['APPDATA'], 'anodex', 'settings.json')
s = json.load(io.open(f, encoding='utf-8'))
hits = [k for k in s['modelContextSizes'] if sys.argv[1].lower() in k.lower()]
if hits:
    s['modelContextSizes'][hits[0]] = int(sys.argv[2])
    io.open(f, 'w', encoding='utf-8').write(json.dumps(s, indent=2))
    print('context for', os.path.basename(hits[0]), '->', sys.argv[2])
PY
}

# 1. A mid-size window, which nothing has tested. The matrix jumps from 8,192
#    to 65,536 with nothing between, and 16,384 is what a lot of real hardware
#    runs.
say "Qwen3-4B at 16,384 - the untested middle"
setctx Qwen3-4B 16384 | tee -a "$LOG"
bash "$HERE/run-suite.sh" Qwen3-4B bench-1-single-file bench-4-large-multi-file 2>&1 | tee -a "$LOG"

# 2. The same middle on a capable model, to separate "small window" from
#    "small model" once more.
say "Qwen3.8-27B at 16,384"
setctx Qwen3.8-27B 16384 | tee -a "$LOG"
bash "$HERE/run-suite.sh" Qwen3.8-27B bench-1-single-file bench-4-large-multi-file 2>&1 | tee -a "$LOG"
setctx Qwen3.8-27B 65536 | tee -a "$LOG"

# 3. Fill the remaining gaps in the short benchmarks for the models that only
#    ran the long ones.
say "Muse on the short benchmarks"
bash "$HERE/run-suite.sh" Muse bench-1-single-file bench-3-fix-existing 2>&1 | tee -a "$LOG"

say "gemma on bench-2, its one untried benchmark"
bash "$HERE/run-suite.sh" gemma bench-2-multi-file 2>&1 | tee -a "$LOG"

say "DeepSeek on bench-2"
bash "$HERE/run-suite.sh" DeepSeek bench-2-multi-file 2>&1 | tee -a "$LOG"

# 4. Repeat the baseline once more. Every result so far is a single run per
#    cell, so nothing says how much of it is variance.
say "Qwen3.8-27B, second pass over the full suite, for variance"
bash "$HERE/run-suite.sh" Qwen3.8-27B bench-1-single-file bench-2-multi-file bench-3-fix-existing bench-4-large-multi-file bench-5-rust 2>&1 | tee -a "$LOG"

# 5. Leave the machine as it was found.
setctx Qwen3-4B 8192 | tee -a "$LOG"
say "OVERNIGHT SEQUENCE COMPLETE"
