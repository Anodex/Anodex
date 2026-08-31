import sys
sys.path.insert(0, r"C:\Users\Owner\Desktop\Sandbox\Bench")
import stats

bad = 0
def check(ok, what):
    global bad
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: bad += 1

check(stats.mean([1, 2, 3, 4]) == 2.5, "mean of an even list")
check(stats.mean([5]) == 5, "mean of one value")
check(stats.median([3, 1, 2]) == 2, "median sorts before picking")
check(stats.median([4, 1, 3, 2]) == 2.5, "median of an even list averages the middle two")
# The tie-break is the part a naive implementation gets wrong.
check(stats.mode([3, 3, 1, 1, 2]) == 1, "mode returns the smallest value on a tie")
check(stats.mode([7, 7, 7, 2]) == 7, "mode returns the most frequent value")
check(stats.mode([5, 4, 3]) == 3, "all-unique falls back to the smallest")

for name, fn in (("mean", stats.mean), ("median", stats.median), ("mode", stats.mode)):
    try:
        fn([])
        check(False, name + "([]) raises ValueError")
    except ValueError as e:
        check(str(e).strip() != "", name + "([]) raises ValueError with a message")
    except Exception as e:
        check(False, name + "([]) raises ValueError (got %r)" % e)

original = [3, 1, 2]
stats.median(original)
check(original == [3, 1, 2], "median does not reorder the caller's list")

print("INDEPENDENT: " + ("ALL PASSED" if bad == 0 else "%d FAILURE(S)" % bad))
sys.exit(1 if bad else 0)
