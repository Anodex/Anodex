// Seeded projects for the benchmarks that need something to already exist.
//
// Kept apart from `bench-reset.mjs` so the reset stays readable: that file
// decides *what state to restore*, this one holds the material.
import fs from 'node:fs'
import path from 'node:path'

const POUND = '£'

/**
 * A defective inventory package, deliberately larger than a small context
 * window can hold.
 *
 * `bench-1` and `bench-3` are small enough that a model at 8,192 tokens may
 * never exhaust its window, so a run can finish without the eviction path being
 * exercised at all — which is exactly what happened when the loop-guard
 * forgiveness fix was first tested and produced a null result.
 *
 * This fixture is ~280 lines across five modules — roughly 3,500 tokens against
 * a working set of about 4,750 at an 8,192-token window. So the sources very
 * nearly fill the window on their own, and do exceed it once a plan, a system
 * prompt and a few tool results are in there too. That makes re-reading across
 * turns likely rather than certain, which is the honest claim: a bigger fixture
 * would force it, at the cost of a task no small model could finish for
 * unrelated reasons.
 *
 * The five defects are what make it long in *turns*: they sit in four files,
 * one file has two, and none is visible without reading the module it lives in.
 *
 * Five defects, each in a different place and each of a different kind, none
 * visible without reading the module it lives in:
 *   1. `models.py`  — `total_value` multiplies by the wrong field.
 *   2. `pricing.py` — the bulk tier boundary is exclusive where it should be
 *      inclusive, so an order of exactly 100 gets the smaller discount.
 *   3. `pricing.py` — money is discounted with float division rather than
 *      integer arithmetic, so some totals land a penny out.
 *   4. `stock.py`   — `remove_stock` lets a count go negative instead of
 *      refusing the move.
 *   5. `report.py`  — the sort key is the sku where it should be the value
 *      held, so "top by value" is really alphabetical.
 */
export function writeInventoryFixture(root) {
  const pkg = path.join(root, 'inventory')
  fs.mkdirSync(pkg, { recursive: true })

  write(path.join(pkg, '__init__.py'), [
    '"""A small inventory package: items, pricing, stock moves and reporting."""',
    '',
    'from .models import Item, Warehouse',
    'from .pricing import line_total, bulk_discount_percent, to_pence, format_pence',
    'from .stock import add_stock, remove_stock, move_stock, StockError',
    'from .report import top_by_value, low_stock, summary_lines',
    '',
    '__all__ = [',
    '    "Item",',
    '    "Warehouse",',
    '    "line_total",',
    '    "bulk_discount_percent",',
    '    "to_pence",',
    '    "format_pence",',
    '    "add_stock",',
    '    "remove_stock",',
    '    "move_stock",',
    '    "StockError",',
    '    "top_by_value",',
    '    "low_stock",',
    '    "summary_lines",',
    ']'
  ])

  write(path.join(pkg, 'models.py'), [
    '"""Core types. An Item is immutable; a Warehouse owns a mutable count map."""',
    '',
    '',
    'class Item:',
    '    """A stocked product. Prices are held in whole pence, never floats."""',
    '',
    '    __slots__ = ("sku", "name", "unit_pence", "reorder_level")',
    '',
    '    def __init__(self, sku, name, unit_pence, reorder_level=0):',
    '        if not sku:',
    '            raise ValueError("sku must not be empty")',
    '        if not isinstance(unit_pence, int):',
    '            raise TypeError("unit_pence must be whole pence")',
    '        if unit_pence < 0:',
    '            raise ValueError("unit_pence must not be negative")',
    '        if reorder_level < 0:',
    '            raise ValueError("reorder_level must not be negative")',
    '        object.__setattr__(self, "sku", sku)',
    '        object.__setattr__(self, "name", name)',
    '        object.__setattr__(self, "unit_pence", unit_pence)',
    '        object.__setattr__(self, "reorder_level", reorder_level)',
    '',
    '    def __setattr__(self, key, value):',
    '        raise AttributeError("Item is immutable")',
    '',
    '    def __repr__(self):',
    '        return "Item(%r, %r, %d)" % (self.sku, self.name, self.unit_pence)',
    '',
    '    def __eq__(self, other):',
    '        return isinstance(other, Item) and other.sku == self.sku',
    '',
    '    def __hash__(self):',
    '        return hash(self.sku)',
    '',
    '',
    'class Warehouse:',
    '    """Holds how many of each item are on hand, keyed by sku."""',
    '',
    '    def __init__(self, name):',
    '        self.name = name',
    '        self._items = {}',
    '        self._counts = {}',
    '',
    '    def register(self, item):',
    '        """Add an item to the catalogue with a count of zero."""',
    '        if item.sku in self._items:',
    '            raise ValueError("sku already registered: %s" % item.sku)',
    '        self._items[item.sku] = item',
    '        self._counts[item.sku] = 0',
    '        return item',
    '',
    '    def item(self, sku):',
    '        if sku not in self._items:',
    '            raise KeyError("no such sku: %s" % sku)',
    '        return self._items[sku]',
    '',
    '    def count(self, sku):',
    '        if sku not in self._counts:',
    '            raise KeyError("no such sku: %s" % sku)',
    '        return self._counts[sku]',
    '',
    '    def set_count(self, sku, value):',
    '        if sku not in self._counts:',
    '            raise KeyError("no such sku: %s" % sku)',
    '        self._counts[sku] = value',
    '',
    '    def skus(self):',
    '        return sorted(self._items)',
    '',
    '    def items(self):',
    '        return [self._items[sku] for sku in self.skus()]',
    '',
    '    def total_value(self):',
    '        """Total pence tied up in stock: unit price times quantity held."""',
    '        total = 0',
    '        for sku, item in self._items.items():',
    '            total += item.unit_pence * item.reorder_level',
    '        return total',
    '',
    '    def __len__(self):',
    '        return len(self._items)'
  ])

  write(path.join(pkg, 'pricing.py'), [
    '"""Money and discounts. Everything is whole pence; floats are not allowed."""',
    '',
    '',
    'BULK_TIERS = (',
    '    (500, 20),',
    '    (100, 10),',
    '    (25, 5),',
    ')',
    '',
    '',
    'def to_pence(pounds, pence=0):',
    '    """Build a pence amount from pounds and pence, as whole integers."""',
    '    if not isinstance(pounds, int) or not isinstance(pence, int):',
    '        raise TypeError("pounds and pence must be integers")',
    '    if pence < 0 or pence > 99:',
    '        raise ValueError("pence must be between 0 and 99")',
    '    return pounds * 100 + pence',
    '',
    '',
    'def format_pence(amount):',
    '    """Render a pence amount as a currency string, e.g. 150 -> ' + POUND + '1.50."""',
    '    if not isinstance(amount, int):',
    '        raise TypeError("amount must be whole pence")',
    '    sign = "-" if amount < 0 else ""',
    '    amount = abs(amount)',
    '    return "%s' + POUND + '%d.%02d" % (sign, amount // 100, amount % 100)',
    '',
    '',
    'def bulk_discount_percent(quantity):',
    '    """The discount percentage earned by ordering this many units."""',
    '    if quantity < 0:',
    '        raise ValueError("quantity must not be negative")',
    '    for threshold, percent in BULK_TIERS:',
    '        if quantity > threshold:',
    '            return percent',
    '    return 0',
    '',
    '',
    'def line_total(unit_pence, quantity):',
    '    """Total pence for a line, after any bulk discount, in whole pence."""',
    '    if quantity < 0:',
    '        raise ValueError("quantity must not be negative")',
    '    gross = unit_pence * quantity',
    '    percent = bulk_discount_percent(quantity)',
    '    if percent == 0:',
    '        return gross',
    '    return int(gross - (gross * percent / 100.0))'
  ])

  write(path.join(pkg, 'stock.py'), [
    '"""Stock movements. A move either applies fully or raises; never partially."""',
    '',
    '',
    'class StockError(Exception):',
    '    """Raised when a movement would leave the warehouse in an invalid state."""',
    '',
    '',
    'def add_stock(warehouse, sku, quantity):',
    '    """Bring quantity units of sku into the warehouse."""',
    '    if quantity <= 0:',
    '        raise StockError("quantity to add must be positive, got %d" % quantity)',
    '    current = warehouse.count(sku)',
    '    warehouse.set_count(sku, current + quantity)',
    '    return warehouse.count(sku)',
    '',
    '',
    'def remove_stock(warehouse, sku, quantity):',
    '    """Take quantity units of sku out, refusing to overdraw."""',
    '    if quantity <= 0:',
    '        raise StockError("quantity to remove must be positive, got %d" % quantity)',
    '    current = warehouse.count(sku)',
    '    warehouse.set_count(sku, current - quantity)',
    '    return warehouse.count(sku)',
    '',
    '',
    'def move_stock(source, destination, sku, quantity):',
    '    """Move stock between warehouses, leaving both consistent."""',
    '    remove_stock(source, sku, quantity)',
    '    try:',
    '        add_stock(destination, sku, quantity)',
    '    except StockError:',
    '        add_stock(source, sku, quantity)',
    '        raise',
    '    return (source.count(sku), destination.count(sku))'
  ])

  write(path.join(pkg, 'report.py'), [
    '"""Reporting views over a warehouse. Pure: nothing here mutates state."""',
    '',
    'from .pricing import format_pence',
    '',
    '',
    'def _value_of(warehouse, sku):',
    '    return warehouse.item(sku).unit_pence * warehouse.count(sku)',
    '',
    '',
    'def top_by_value(warehouse, limit=3):',
    '    """The skus holding the most value, most valuable first."""',
    '    if limit < 0:',
    '        raise ValueError("limit must not be negative")',
    '    skus = warehouse.skus()',
    '    ordered = sorted(skus, key=lambda sku: sku, reverse=True)',
    '    return ordered[:limit]',
    '',
    '',
    'def low_stock(warehouse):',
    '    """Skus at or below their reorder level, in catalogue order."""',
    '    out = []',
    '    for sku in warehouse.skus():',
    '        if warehouse.count(sku) <= warehouse.item(sku).reorder_level:',
    '            out.append(sku)',
    '    return out',
    '',
    '',
    'def summary_lines(warehouse):',
    '    """One human-readable line per sku, in catalogue order."""',
    '    out = []',
    '    for sku in warehouse.skus():',
    '        item = warehouse.item(sku)',
    '        out.append(',
    '            "%s  %-14s x%-4d %s"',
    '            % (sku, item.name, warehouse.count(sku), format_pence(_value_of(warehouse, sku)))',
    '        )',
    '    return out'
  ])

  write(path.join(root, 'test_inventory.py'), [
    '"""Checks that describe the behaviour wanted. Do not change this file."""',
    '',
    'import inventory',
    'from inventory import Item, Warehouse',
    '',
    'checks = 0',
    '',
    '',
    'def check(ok, what):',
    '    global checks',
    '    assert ok, "FAILED: " + what',
    '    checks += 1',
    '    print("OK: " + what)',
    '',
    '',
    'def build():',
    '    w = Warehouse("main")',
    '    w.register(Item("A-1", "Widget", 250, reorder_level=5))',
    '    w.register(Item("B-2", "Gadget", 1000, reorder_level=2))',
    '    w.register(Item("C-3", "Doohickey", 75, reorder_level=10))',
    '    inventory.add_stock(w, "A-1", 10)',
    '    inventory.add_stock(w, "B-2", 3)',
    '    inventory.add_stock(w, "C-3", 20)',
    '    return w',
    '',
    '',
    '# --- models -------------------------------------------------------------',
    'w = build()',
    'check(',
    '    w.total_value() == 250 * 10 + 1000 * 3 + 75 * 20,',
    '    "total_value uses the quantity held, not the reorder level",',
    ')',
    '',
    '# --- pricing ------------------------------------------------------------',
    'check(inventory.bulk_discount_percent(100) == 10,',
    '      "a tier threshold is inclusive: exactly 100 earns 10 percent")',
    'check(inventory.bulk_discount_percent(25) == 5, "exactly 25 earns 5 percent")',
    'check(inventory.bulk_discount_percent(24) == 0, "just under a threshold earns nothing")',
    '# 333p x 101 = 33_633 gross. Multiplying before dividing gives 30_270;',
    '# float division truncates to 30_269. A quantity of 100 would divide',
    '# evenly and hide the defect completely.',
    'check(inventory.line_total(333, 101) == 30270,',
    '      "line_total discounts in whole pence with no float error")',
    'check(inventory.format_pence(inventory.line_total(333, 101)) == "' + POUND + '302.70",',
    '      "the discounted total formats exactly")',
    '',
    '# --- stock --------------------------------------------------------------',
    'w = build()',
    'try:',
    '    inventory.remove_stock(w, "B-2", 99)',
    '    check(False, "removing more than is held raises StockError")',
    'except inventory.StockError:',
    '    check(True, "removing more than is held raises StockError")',
    'check(w.count("B-2") == 3, "a refused removal leaves the count untouched")',
    '',
    '# --- report -------------------------------------------------------------',
    'w = build()',
    'check(inventory.top_by_value(w, 2) == ["B-2", "A-1"],',
    '      "top_by_value ranks by value held, not by sku")',
    'check(inventory.low_stock(w) == [], "nothing is below its reorder level here")',
    '',
    'print("ALL CHECKS PASSED (%d)" % checks)'
  ])
}

/**
 * A defective Rust crate, for the one non-Python language testable here.
 *
 * Every benchmark before this is Python, so the multi-language work —
 * `TEXT_EXT` learning twenty languages, `SKIP_DIRS` learning `target/`,
 * `code_outline` no longer claiming a Rust project has no code, the toolchain
 * line in the orientation summary — is covered by unit tests and has never been
 * exercised by a real run. Two earlier Rust runs did not touch it either: a
 * one-file crate never needs to search.
 *
 * This one does. Three modules plus a test module, with `target/` present after
 * the first build, so a model has to orient in a real Cargo layout.
 *
 * Three defects, each idiomatic to get wrong in Rust specifically:
 *   1. `parse.rs` — `trim()` is applied before splitting rather than to each
 *      field, so values keep their surrounding spaces.
 *   2. `total.rs` — integer division truncates before the multiply, losing
 *      pennies, where the multiply must come first.
 *   3. `rank.rs`  — `sort_by` compares the wrong way round, so "highest first"
 *      is lowest first.
 */
export function writeRustFixture(root) {
  const src = path.join(root, 'src')
  fs.mkdirSync(src, { recursive: true })

  write(path.join(root, 'Cargo.toml'), [
    '[package]',
    'name = "orders"',
    'version = "0.1.0"',
    'edition = "2021"',
    '',
    '[dependencies]'
  ])

  write(path.join(root, '.gitignore'), ['/target'])

  write(path.join(src, 'lib.rs'), [
    '//! A tiny order-processing crate: parse lines, total them, rank them.',
    '',
    'pub mod parse;',
    'pub mod rank;',
    'pub mod total;',
    '',
    'pub use parse::{parse_line, Order};',
    'pub use rank::rank_by_total;',
    'pub use total::line_total_pence;'
  ])

  write(path.join(src, 'parse.rs'), [
    '//! Reading order lines of the form "sku, quantity, unit_pence".',
    '',
    '/// One parsed order line. Prices are whole pence, never floats.',
    '#[derive(Debug, Clone, PartialEq, Eq)]',
    'pub struct Order {',
    '    pub sku: String,',
    '    pub quantity: u32,',
    '    pub unit_pence: u32,',
    '}',
    '',
    '/// Parse one line, rejecting anything malformed with a clear message.',
    'pub fn parse_line(line: &str) -> Result<Order, String> {',
    "    let fields: Vec<&str> = line.trim().split(',').collect();",
    '    if fields.len() != 3 {',
    '        return Err(format!("expected 3 fields, found {}", fields.len()));',
    '    }',
    '    let sku = fields[0].to_string();',
    '    if sku.is_empty() {',
    '        return Err("sku must not be empty".to_string());',
    '    }',
    '    let quantity: u32 = fields[1]',
    '        .parse()',
    '        .map_err(|_| format!("quantity is not a number: {:?}", fields[1]))?;',
    '    let unit_pence: u32 = fields[2]',
    '        .parse()',
    '        .map_err(|_| format!("unit_pence is not a number: {:?}", fields[2]))?;',
    '    Ok(Order {',
    '        sku,',
    '        quantity,',
    '        unit_pence,',
    '    })',
    '}'
  ])

  write(path.join(src, 'total.rs'), [
    '//! Money. Everything is whole pence and integer arithmetic only.',
    '',
    'use crate::parse::Order;',
    '',
    '/// Percent discount earned by a quantity, as whole percent.',
    'pub fn discount_percent(quantity: u32) -> u32 {',
    '    if quantity >= 100 {',
    '        10',
    '    } else if quantity >= 25 {',
    '        5',
    '    } else {',
    '        0',
    '    }',
    '}',
    '',
    '/// Total pence for one order line, after any discount.',
    'pub fn line_total_pence(order: &Order) -> u32 {',
    '    let gross = order.unit_pence * order.quantity;',
    '    let percent = discount_percent(order.quantity);',
    '    if percent == 0 {',
    '        return gross;',
    '    }',
    '    gross - (gross / 100) * percent',
    '}'
  ])

  write(path.join(src, 'rank.rs'), [
    '//! Ordering views over parsed orders. Nothing here mutates its input.',
    '',
    'use crate::parse::Order;',
    'use crate::total::line_total_pence;',
    '',
    '/// SKUs ranked by line total, highest first.',
    'pub fn rank_by_total(orders: &[Order]) -> Vec<String> {',
    '    let mut ranked: Vec<&Order> = orders.iter().collect();',
    '    ranked.sort_by(|a, b| line_total_pence(a).cmp(&line_total_pence(b)));',
    '    ranked.into_iter().map(|o| o.sku.clone()).collect()',
    '}'
  ])

  write(path.join(src, 'tests.rs'), [
    '//! Checks describing the behaviour wanted. Do not change this file.',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    use crate::*;',
    '',
    '    #[test]',
    '    fn fields_are_trimmed_individually() {',
    '        let order = parse_line(" A-1 , 10 , 250 ").expect("should parse");',
    '        assert_eq!(order.sku, "A-1", "sku keeps surrounding spaces");',
    '        assert_eq!(order.quantity, 10);',
    '        assert_eq!(order.unit_pence, 250);',
    '    }',
    '',
    '    #[test]',
    '    fn malformed_lines_are_rejected() {',
    '        assert!(parse_line("A-1, 10").is_err());',
    '        assert!(parse_line("A-1, x, 250").is_err());',
    '        assert!(parse_line(", 10, 250").is_err());',
    '    }',
    '',
    '    #[test]',
    '    fn discount_multiplies_before_dividing() {',
    '        // 333p x 101 = 33_633 gross. Multiplying first gives a 3_363',
    '        // discount and a 30_270 total; dividing first truncates 336.33 to',
    '        // 336 and lands three pence out. A gross divisible by 100 would',
    '        // hide the defect entirely, which is why this one is not.',
    '        let order = Order {',
    '            sku: "A-1".to_string(),',
    '            quantity: 101,',
    '            unit_pence: 333,',
    '        };',
    '        assert_eq!(line_total_pence(&order), 30_270);',
    '    }',
    '',
    '    #[test]',
    '    fn undiscounted_lines_are_exact() {',
    '        let order = Order {',
    '            sku: "B-2".to_string(),',
    '            quantity: 3,',
    '            unit_pence: 1000,',
    '        };',
    '        assert_eq!(line_total_pence(&order), 3_000);',
    '    }',
    '',
    '    #[test]',
    '    fn ranking_puts_the_largest_first() {',
    '        let orders = vec![',
    '            Order { sku: "small".to_string(), quantity: 1, unit_pence: 100 },',
    '            Order { sku: "large".to_string(), quantity: 10, unit_pence: 1000 },',
    '            Order { sku: "middle".to_string(), quantity: 5, unit_pence: 100 },',
    '        ];',
    '        assert_eq!(rank_by_total(&orders), vec!["large", "middle", "small"]);',
    '    }',
    '}'
  ])

  // `lib.rs` has to declare the test module or it never runs.
  write(path.join(src, 'lib.rs'), [
    '//! A tiny order-processing crate: parse lines, total them, rank them.',
    '',
    'pub mod parse;',
    'pub mod rank;',
    'pub mod total;',
    '',
    'mod tests;',
    '',
    'pub use parse::{parse_line, Order};',
    'pub use rank::rank_by_total;',
    'pub use total::{discount_percent, line_total_pence};'
  ])
}

function write(file, rows) {
  fs.writeFileSync(file, rows.join('\n') + '\n', 'utf-8')
}
