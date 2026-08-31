"""Independent checks for bench-2, testing behaviour rather than source text.

An earlier version grepped the module for "float(" and "/ 100", which a
docstring mentioning "150/100" would fail, and probed Account's constructor by
signature length. Both produced verdicts about the checker rather than the code.
Everything here now exercises the public API and asks whether the *results* are
right, which is what the task specified.
"""
import sys, inspect
sys.path.insert(0, r"C:\Users\Owner\Desktop\Sandbox\Bench")
import ledger

bad = 0
def check(ok, what):
    global bad
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: bad += 1

Money = ledger.Money

m = Money(150)
check(m.format().endswith("1.50"), "formats 150 pence as 1.50 (got %r)" % m.format())
check(Money(5).format().endswith("0.05"), "formats 5 pence with a leading zero")
check(Money(100000).format().endswith("1000.00"), "formats a large amount")

a, b = Money(150), Money(75)
check(hasattr(a, "add") and hasattr(a, "subtract"), "Money has the required add and subtract")
if hasattr(a, "add"):
    check(a.add(b).format().endswith("2.25"), "add returns the sum")
    check(a.subtract(b).format().endswith("0.75"), "subtract returns the difference")
    check(a.format().endswith("1.50"), "add and subtract leave the original untouched")

# "Never use floats" is a property of the results, not of the source text: a
# float would show up as a non-integer store or as rounding drift over many
# operations.
stored = list(vars(a).values()) if hasattr(a, "__dict__") else [
    getattr(a, s) for s in getattr(Money, "__slots__", [])
]
check(all(isinstance(v, int) and not isinstance(v, bool) for v in stored),
      "every stored value is a whole integer (got %r)" % stored)

if hasattr(Money(1), "add"):
    running = Money(0)
    for _ in range(1000):
        running = running.add(Money(1))
    check(running.format().endswith("10.00"),
          "a thousand additions of 1p land exactly on 10.00 (got %r)" % running.format())

try:
    a.pence = 999
    check(False, "Money is immutable")
except Exception:
    check(True, "Money is immutable (assignment rejected)")

check(hasattr(ledger, "Account"), "the package exports an Account")

print("INDEPENDENT: " + ("ALL PASSED" if bad == 0 else "%d FAILURE(S)" % bad))
sys.exit(1 if bad else 0)
