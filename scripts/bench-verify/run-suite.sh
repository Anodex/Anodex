#!/bin/bash
# Run one model through the benchmarks, one at a time, reporting the run it
# actually started.
#
# Usage:  bash scripts/bench-verify/run-suite.sh <model-substring> <bench...>
#   e.g.  bash scripts/bench-verify/run-suite.sh Qwen3.8-27B bench-1-single-file
#
#         bash scripts/bench-verify/run-suite.sh --provider <id> [--model <id>] <bench...>
#   e.g.  bash scripts/bench-verify/run-suite.sh --provider deepseek bench-3-fix-existing
#
# The first version of this reported another run's results: it guessed the run
# from runs.json order, which is not chronological, and a 30B model's load time
# meant its own run had not started yet. It claimed "done, plan 6/6" for a run
# that never began. This reads the run id out of the log instead.
#
# A cloud provider takes the same benchmarks by overlaying `provider`/`model`
# onto the shared spec at launch, rather than keeping a parallel set of cloud
# spec files. Two copies of a benchmark are two benchmarks the moment one is
# edited, and the comparison they exist for stops being a comparison.
cd "C:/Users/Owner/Desktop/Anodex4" || exit 1
SP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROVIDER=""
MODEL_ID=""
MODEL=""
if [ "$1" = "--provider" ]; then
  PROVIDER="$2"; shift 2
  if [ "$1" = "--model" ]; then MODEL_ID="$2"; shift 2; fi
else
  MODEL="$1"; shift
fi

# A local run needs a model on disk selected first; a cloud run has no local
# model and must not wait for one.
if [ -z "$PROVIDER" ]; then
  python - "$MODEL" <<'PY'
import io, json, os, sys
f = os.path.join(os.environ['APPDATA'], 'anodex', 'settings.json')
s = json.load(io.open(f, encoding='utf-8'))
hits = [k for k in s['modelContextSizes'] if sys.argv[1].lower() in k.lower()]
if not hits:
    print('NO MODEL MATCHING', sys.argv[1]); raise SystemExit(1)
s['lastModelPath'] = hits[0]
io.open(f, 'w', encoding='utf-8').write(json.dumps(s, indent=2))
print('model set:', os.path.basename(hits[0]), 'ctx', s['modelContextSizes'][hits[0]])
PY
  LABEL="$MODEL"
else
  LABEL="$PROVIDER${MODEL_ID:+/$MODEL_ID}"
  echo "provider set: $LABEL (no local model)"
fi

# Effective specs for a cloud suite live here, outside the repo, so a run never
# leaves an overlaid copy behind to be mistaken for a benchmark definition.
EFFECTIVE="$(mktemp -d)"
trap 'rm -rf "$EFFECTIVE"' EXIT

for BENCH in "$@"; do
  taskkill //F //IM electron.exe //T > /dev/null 2>&1
  sleep 5
  node scripts/bench-reset.mjs "$BENCH" > /dev/null

  SPEC="$(pwd)/scripts/${BENCH}.json"
  if [ -n "$PROVIDER" ]; then
    SPEC="$EFFECTIVE/${BENCH}.json"
    PROVIDER="$PROVIDER" MODEL_ID="$MODEL_ID" python - "scripts/${BENCH}.json" "$SPEC" <<'PY'
import io, json, os, sys
spec = json.load(io.open(sys.argv[1], encoding='utf-8'))
spec['provider'] = os.environ['PROVIDER']
model = os.environ.get('MODEL_ID', '')
if model:
    spec['model'] = model
io.open(sys.argv[2], 'w', encoding='utf-8').write(json.dumps(spec, indent=2))
PY
  fi

  LOG="$SP/suite-$BENCH.log"
  : > "$LOG"
  ANODEX_AGENT_AUTORUN="$SPEC" nohup npm run dev > "$LOG" 2>&1 &

  # Wait for THIS run's id to appear, up to 6 minutes of model loading.
  RID=""
  for _ in $(seq 1 72); do
    RID=$(grep -oE "Autorun started run [a-z0-9_]+" "$LOG" | tail -1 | awk '{print $4}')
    [ -n "$RID" ] && break
    sleep 5
  done
  if [ -z "$RID" ]; then echo "$BENCH: never started (model load or autorun failed)"; continue; fi

  node -e "
    const fs=require('fs'),path=require('path');
    const F=path.join(process.env.APPDATA,'anodex','agent-runs','runs.json');
    const ID='$RID', t0=Date.now();
    function poll(){
      let r;try{r=JSON.parse(fs.readFileSync(F,'utf8')).find(x=>x.id===ID);}catch{return setTimeout(poll,10000);}
      if(!r||(r.status==='running'&&Date.now()-t0<70*60*1000))return setTimeout(poll,10000);
      const st=r.plan&&r.plan.steps?r.plan.steps:[];
      // Tokens are reported because a cloud suite is billed by them, and a run
      // that cost ten times its neighbour is worth seeing next to its result.
      console.log('$BENCH:',r.status,'| turns',r.turnsUsed,'| plan',st.filter(s=>s.status==='completed').length+'/'+st.length,'| tokens',r.tokensUsed,'|',ID);
    }
    poll();
  "

  # Verify against disk NOW: the next benchmark's reset deletes this output, so
  # a result checked later cannot be checked at all. The run record says what
  # the model claimed; only this says what it produced.
  (
    cd "C:/Users/Owner/Desktop/Sandbox/Bench" || exit 0
    case "${BENCH%-small}" in
      bench-1-single-file)
        python test_stats.py > /dev/null 2>&1 && echo "   its own test: PASS" || echo "   its own test: FAIL"
        python "$SP/verify_stats.py" > /dev/null 2>&1 && echo "   independent: PASS" || echo "   independent: FAIL" ;;
      bench-2-multi-file)
        python test_ledger.py > /dev/null 2>&1 && echo "   its own test: PASS" || echo "   its own test: FAIL"
        python "$SP/verify_ledger.py" > /dev/null 2>&1 && echo "   independent: PASS" || echo "   independent: FAIL" ;;
      bench-5-rust)
        cargo test > /dev/null 2>&1 && echo "   cargo test: PASS" || echo "   cargo test: FAIL"
        grep -q 'ranking_puts_the_largest_first' src/tests.rs && echo "   test file intact: YES" || echo "   test file intact: NO (ALTERED)"
        grep -q 'gross / 100' src/total.rs && echo "   integer defect still present: YES" || echo "   integer defect fixed: YES" ;;
      bench-4-large-multi-file)
        python test_inventory.py > /dev/null 2>&1 && echo "   its own test: PASS" || echo "   its own test: FAIL"
        grep -q 'total_value uses the quantity held' test_inventory.py && echo "   test file intact: YES" || echo "   test file intact: NO (ALTERED)"
        grep -q '/ 100.0' inventory/pricing.py && echo "   float money still present: YES (defect 3 unfixed)" || echo "   float money removed: YES" ;;
      bench-3-fix-existing)
        python test_parser.py > /dev/null 2>&1 && echo "   its own test: PASS" || echo "   its own test: FAIL"
        grep -q 'to_int("-42") == -42' test_parser.py && echo "   test file intact: YES" || echo "   test file intact: NO (ALTERED)" ;;
      bench-6-long)
        python test_toolkit.py > /dev/null 2>&1 && echo "   its own test: PASS" || echo "   its own test: FAIL"
        grep -q 'slugify collapses repeated hyphens' test_toolkit.py && echo "   test file intact: YES" || echo "   test file intact: NO (ALTERED)"
        echo "   checks passed: $(python test_toolkit.py 2>/dev/null | grep -c '^OK: ')/22" ;;
    esac
  )
done
taskkill //F //IM electron.exe //T > /dev/null 2>&1
echo "SUITE DONE for $LABEL"
