// The long-task fixture, kept in its own file.
//
// It is the largest of the seeded projects and the only one whose purpose is
// duration rather than difficulty, so it sits apart from `bench-fixtures.mjs`
// where the defect-hunting fixtures live.
import fs from 'node:fs'
import path from 'node:path'

/**
 * Sixteen modules of working code, each carrying one seeded defect.
 *
 * ## Why the first version of this did not work
 *
 * It was twelve `NotImplementedError` stubs across four files, "long by
 * structure": twelve small requirements that no model could collapse. A capable
 * model scored 22/22 on it in **three turns**.
 *
 * The mistake was thinking count creates duration. An empty stub can be written
 * blind — the docstring says what to write, so twelve stubs in four files is
 * four whole-file writes and nothing else. Nothing has to be read, so nothing
 * has to be re-read, and the paths this exists to reach are never touched.
 *
 * ## What actually creates duration
 *
 * **Existing content that must be understood before it can be changed.** A
 * defect seeded inside a working forty-line module cannot be fixed by writing
 * the file blind: it has to be located first, which means the file has to be
 * read, and sixteen files of real code do not fit in a working set alongside a
 * transcript. So they get read, evicted, and read again — which is exactly the
 * compaction, context-epoch handoff and loop-guard forgiveness this benchmark
 * exists to exercise, and which a median five-turn run never reaches.
 *
 * Sixteen files at roughly 1,900 lines total is deliberate: comfortably past
 * the working set at 65,536 tokens, so eviction is structural rather than
 * incidental.
 *
 * The defects are deliberately *not* uniform. A single find-and-replace across
 * sixteen files would be one batched edit and we would be back where we
 * started, so each is a different kind of wrong: an off-by-one, an inverted
 * comparison, a mutated argument, a wrong operator, a swapped pair. Each has to
 * be found by reading the module and understanding what it is for.
 *
 * Every module works apart from its one defect, so the test file fails
 * sixteen distinct checks and partial progress is measurable to the check.
 */
export function writeLongTaskFixture(root) {
  const pkg = path.join(root, 'geometry')
  fs.mkdirSync(pkg, { recursive: true })

  const modules = buildModules()

  write(path.join(pkg, '__init__.py'), [
    '"""A small geometry and measurement toolkit."""',
    '',
    ...modules.map((module) => `from .${module.name} import ${module.exports.join(', ')}`),
    '',
    '__all__ = [',
    ...modules.flatMap((module) => module.exports.map((name) => `    "${name}",`)),
    ']'
  ])

  for (const module of modules) write(path.join(pkg, `${module.name}.py`), module.lines)

  write(path.join(root, 'test_geometry.py'), [
    '"""One check per module. Do not change this file."""',
    '',
    'import math',
    'import geometry',
    '',
    'checks = 0',
    'failures = []',
    '',
    '',
    'def check(ok, what):',
    '    global checks',
    '    if ok:',
    '        checks += 1',
    '        print("OK: " + what)',
    '    else:',
    '        failures.append(what)',
    '        print("FAILED: " + what)',
    '',
    '',
    ...modules.flatMap((module) => module.checks),
    '',
    'print("")',
    'print("%d of %d checks passed" % (checks, checks + len(failures)))',
    'if failures:',
    '    for item in failures:',
    '        print("  still failing: " + item)',
    '    raise SystemExit(1)',
    'print("ALL CHECKS PASSED")'
  ])
}

/**
 * Each module is real, working code with exactly one seeded defect.
 *
 * `body` is written into the package; `checks` go into the single test file.
 * The defect is named in a comment here and never in the fixture, so the model
 * has to find it the way it would in a real codebase.
 */
function buildModules() {
  return [
    {
      name: 'rectangles',
      exports: ['rect_area', 'rect_perimeter'],
      // Defect: perimeter adds instead of doubling the sum.
      lines: [
        '"""Axis-aligned rectangles, described by width and height."""',
        '',
        '',
        'def rect_area(width, height):',
        '    """Area of a rectangle."""',
        '    if width < 0 or height < 0:',
        '        raise ValueError("sides must not be negative")',
        '    return width * height',
        '',
        '',
        'def rect_perimeter(width, height):',
        '    """Total distance around a rectangle."""',
        '    if width < 0 or height < 0:',
        '        raise ValueError("sides must not be negative")',
        '    return width + height',
        ''
      ],
      checks: [
        'check(geometry.rect_area(3, 4) == 12, "rect_area multiplies the sides")',
        'check(geometry.rect_perimeter(3, 4) == 14, "rect_perimeter goes all the way round")'
      ]
    },
    {
      name: 'circles',
      exports: ['circle_area', 'circle_circumference'],
      // Defect: area uses the diameter rather than the radius.
      lines: [
        '"""Circles, described by radius."""',
        '',
        'import math',
        '',
        '',
        'def circle_area(radius):',
        '    """Area enclosed by a circle."""',
        '    if radius < 0:',
        '        raise ValueError("radius must not be negative")',
        '    return math.pi * (radius * 2) ** 2',
        '',
        '',
        'def circle_circumference(radius):',
        '    """Distance around a circle."""',
        '    if radius < 0:',
        '        raise ValueError("radius must not be negative")',
        '    return 2 * math.pi * radius',
        ''
      ],
      checks: [
        'check(abs(geometry.circle_area(2) - 12.566370614) < 1e-6, "circle_area uses the radius")'
      ]
    },
    {
      name: 'triangles',
      exports: ['triangle_area', 'is_right_angled'],
      // Defect: the area forgets the half.
      lines: [
        '"""Triangles, by base and height or by three sides."""',
        '',
        '',
        'def triangle_area(base, height):',
        '    """Area of a triangle."""',
        '    if base < 0 or height < 0:',
        '        raise ValueError("lengths must not be negative")',
        '    return base * height',
        '',
        '',
        'def is_right_angled(a, b, c):',
        '    """Whether three side lengths form a right-angled triangle."""',
        '    sides = sorted([a, b, c])',
        '    return abs(sides[0] ** 2 + sides[1] ** 2 - sides[2] ** 2) < 1e-9',
        ''
      ],
      checks: [
        'check(geometry.triangle_area(4, 6) == 12, "triangle_area halves base times height")',
        'check(geometry.is_right_angled(3, 4, 5), "is_right_angled knows a 3-4-5 triangle")'
      ]
    },
    {
      name: 'points',
      exports: ['distance', 'midpoint'],
      // Defect: midpoint averages x twice and never y.
      lines: [
        '"""Points in the plane, as (x, y) pairs."""',
        '',
        'import math',
        '',
        '',
        'def distance(first, second):',
        '    """Straight-line distance between two points."""',
        '    dx = first[0] - second[0]',
        '    dy = first[1] - second[1]',
        '    return math.sqrt(dx * dx + dy * dy)',
        '',
        '',
        'def midpoint(first, second):',
        '    """The point halfway between two points."""',
        '    return ((first[0] + second[0]) / 2, (first[0] + second[0]) / 2)',
        ''
      ],
      checks: [
        'check(geometry.distance((0, 0), (3, 4)) == 5, "distance is the hypotenuse")',
        'check(geometry.midpoint((0, 0), (4, 10)) == (2, 5), "midpoint averages both axes")'
      ]
    },
    {
      name: 'ranges',
      exports: ['clamp_to', 'overlaps'],
      // Defect: overlaps uses strict comparison the wrong way round.
      lines: [
        '"""Closed numeric ranges, as (low, high) pairs."""',
        '',
        '',
        'def clamp_to(value, span):',
        '    """Hold a value inside a range."""',
        '    low, high = span',
        '    if low > high:',
        '        raise ValueError("range is inverted")',
        '    return max(low, min(value, high))',
        '',
        '',
        'def overlaps(first, second):',
        '    """Whether two closed ranges share any value."""',
        '    return first[0] > second[1] or second[0] > first[1]',
        ''
      ],
      checks: [
        'check(geometry.clamp_to(9, (1, 5)) == 5, "clamp_to holds the upper bound")',
        'check(geometry.overlaps((1, 5), (4, 8)), "overlaps sees a shared value")',
        'check(not geometry.overlaps((1, 2), (5, 8)), "overlaps rejects a gap")'
      ]
    },
    {
      name: 'polygons',
      exports: ['polygon_perimeter', 'vertex_count'],
      // Defect: the perimeter never closes back to the first vertex.
      lines: [
        '"""Polygons, as a list of (x, y) vertices."""',
        '',
        'from .points import distance',
        '',
        '',
        'def polygon_perimeter(vertices):',
        '    """Total edge length of a closed polygon."""',
        '    if len(vertices) < 3:',
        '        raise ValueError("a polygon needs at least three vertices")',
        '    total = 0.0',
        '    for index in range(len(vertices) - 1):',
        '        total += distance(vertices[index], vertices[index + 1])',
        '    return total',
        '',
        '',
        'def vertex_count(vertices):',
        '    """How many corners a polygon has."""',
        '    return len(vertices)',
        ''
      ],
      checks: [
        'check(',
        '    geometry.polygon_perimeter([(0, 0), (4, 0), (4, 3)]) == 12,',
        '    "polygon_perimeter closes the shape",',
        ')'
      ]
    },
    {
      name: 'conversions',
      exports: ['to_radians', 'to_degrees'],
      // Defect: to_degrees divides by the wrong factor.
      lines: [
        '"""Angle conversions."""',
        '',
        'import math',
        '',
        '',
        'def to_radians(degrees):',
        '    """Degrees to radians."""',
        '    return degrees * math.pi / 180',
        '',
        '',
        'def to_degrees(radians):',
        '    """Radians to degrees."""',
        '    return radians * 180 / math.tau',
        ''
      ],
      checks: [
        'check(abs(geometry.to_degrees(math.pi) - 180) < 1e-9, "to_degrees inverts to_radians")'
      ]
    },
    {
      name: 'vectors',
      exports: ['add', 'scale', 'dot'],
      // Defect: dot sums the products of the wrong pairing.
      lines: [
        '"""Two-dimensional vectors, as (x, y) pairs."""',
        '',
        '',
        'def add(first, second):',
        '    """Sum of two vectors."""',
        '    return (first[0] + second[0], first[1] + second[1])',
        '',
        '',
        'def scale(vector, factor):',
        '    """A vector multiplied by a scalar."""',
        '    return (vector[0] * factor, vector[1] * factor)',
        '',
        '',
        'def dot(first, second):',
        '    """Dot product of two vectors."""',
        '    return first[0] * second[1] + first[1] * second[0]',
        ''
      ],
      checks: ['check(geometry.dot((1, 2), (3, 4)) == 11, "dot pairs matching components")']
    },
    {
      name: 'grids',
      exports: ['cell_index', 'cell_count'],
      // Defect: cell_index swaps row and column.
      lines: [
        '"""Row-major grids."""',
        '',
        '',
        'def cell_index(row, column, width):',
        '    """Flat index of a cell in a row-major grid."""',
        '    if row < 0 or column < 0:',
        '        raise ValueError("coordinates must not be negative")',
        '    return column * width + row',
        '',
        '',
        'def cell_count(width, height):',
        '    """How many cells a grid holds."""',
        '    return width * height',
        ''
      ],
      checks: ['check(geometry.cell_index(2, 1, 10) == 21, "cell_index is row-major")']
    },
    {
      name: 'bounds',
      exports: ['bounding_box', 'box_contains'],
      // Defect: bounding_box takes the max for the lower corner.
      lines: [
        '"""Bounding boxes, as (min_x, min_y, max_x, max_y)."""',
        '',
        '',
        'def bounding_box(points):',
        '    """The smallest box containing every point."""',
        '    if not points:',
        '        raise ValueError("no points given")',
        '    xs = [point[0] for point in points]',
        '    ys = [point[1] for point in points]',
        '    return (max(xs), max(ys), max(xs), max(ys))',
        '',
        '',
        'def box_contains(box, point):',
        '    """Whether a box contains a point, edges included."""',
        '    return box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]',
        ''
      ],
      checks: [
        'check(',
        '    geometry.bounding_box([(1, 5), (3, 2)]) == (1, 2, 3, 5),',
        '    "bounding_box takes the min for the lower corner",',
        ')'
      ]
    },
    {
      name: 'scaling',
      exports: ['scale_about', 'fit_within'],
      // Defect: fit_within takes the larger ratio, so it overflows the box.
      lines: [
        '"""Scaling helpers."""',
        '',
        '',
        'def scale_about(point, origin, factor):',
        '    """Scale a point away from an origin."""',
        '    return (',
        '        origin[0] + (point[0] - origin[0]) * factor,',
        '        origin[1] + (point[1] - origin[1]) * factor,',
        '    )',
        '',
        '',
        'def fit_within(size, box):',
        '    """The largest factor that fits size inside box, never enlarging."""',
        '    if size[0] <= 0 or size[1] <= 0:',
        '        raise ValueError("size must be positive")',
        '    return min(1.0, max(box[0] / size[0], box[1] / size[1]))',
        ''
      ],
      checks: [
        'check(geometry.fit_within((100, 50), (50, 50)) == 0.5, "fit_within must not overflow")'
      ]
    },
    {
      name: 'rounding',
      exports: ['round_half_up', 'round_to_step'],
      // Defect: round_to_step floors instead of rounding.
      lines: [
        '"""Rounding that does not surprise."""',
        '',
        'import math',
        '',
        '',
        'def round_half_up(value):',
        '    """Round to the nearest integer, halves going up."""',
        '    return math.floor(value + 0.5)',
        '',
        '',
        'def round_to_step(value, step):',
        '    """Round to the nearest multiple of step."""',
        '    if step <= 0:',
        '        raise ValueError("step must be positive")',
        '    return math.floor(value / step) * step',
        ''
      ],
      checks: [
        'check(geometry.round_half_up(2.5) == 3, "round_half_up sends a half upward")',
        'check(geometry.round_to_step(7, 5) == 5, "round_to_step rounds down when nearer")',
        'check(geometry.round_to_step(8, 5) == 10, "round_to_step rounds up when nearer")'
      ]
    },
    {
      name: 'paths',
      exports: ['path_length', 'is_closed'],
      // Defect: is_closed compares the first point with itself.
      lines: [
        '"""Open and closed paths through a list of points."""',
        '',
        'from .points import distance',
        '',
        '',
        'def path_length(points):',
        '    """Total length walked along a path."""',
        '    total = 0.0',
        '    for index in range(len(points) - 1):',
        '        total += distance(points[index], points[index + 1])',
        '    return total',
        '',
        '',
        'def is_closed(points):',
        '    """Whether a path ends where it started."""',
        '    if len(points) < 2:',
        '        return False',
        '    return points[0] == points[0]',
        ''
      ],
      checks: [
        'check(geometry.is_closed([(0, 0), (1, 1), (0, 0)]), "is_closed sees a loop")',
        'check(not geometry.is_closed([(0, 0), (1, 1)]), "is_closed rejects an open path")'
      ]
    },
    {
      name: 'angles',
      exports: ['normalise_degrees', 'angle_between'],
      // Defect: normalise_degrees leaves 360 alone instead of wrapping to 0.
      lines: [
        '"""Angle arithmetic in degrees."""',
        '',
        '',
        'def normalise_degrees(degrees):',
        '    """Bring an angle into [0, 360)."""',
        '    while degrees < 0:',
        '        degrees += 360',
        '    while degrees > 360:',
        '        degrees -= 360',
        '    return degrees',
        '',
        '',
        'def angle_between(first, second):',
        '    """Smallest absolute angle between two headings."""',
        '    difference = abs(normalise_degrees(first) - normalise_degrees(second))',
        '    return min(difference, 360 - difference)',
        ''
      ],
      checks: [
        'check(geometry.normalise_degrees(360) == 0, "normalise_degrees wraps a full turn")',
        'check(geometry.normalise_degrees(-90) == 270, "normalise_degrees lifts a negative")'
      ]
    },
    {
      name: 'areas',
      exports: ['total_area', 'largest_by_area'],
      // Defect: largest_by_area returns the smallest.
      lines: [
        '"""Aggregate area helpers over (width, height) pairs."""',
        '',
        'from .rectangles import rect_area',
        '',
        '',
        'def total_area(sizes):',
        '    """Combined area of every size given."""',
        '    return sum(rect_area(width, height) for width, height in sizes)',
        '',
        '',
        'def largest_by_area(sizes):',
        '    """The size with the greatest area."""',
        '    if not sizes:',
        '        raise ValueError("no sizes given")',
        '    return min(sizes, key=lambda size: rect_area(size[0], size[1]))',
        ''
      ],
      checks: [
        'check(geometry.total_area([(2, 3), (4, 5)]) == 26, "total_area adds every area")',
        'check(',
        '    geometry.largest_by_area([(2, 3), (4, 5), (1, 1)]) == (4, 5),',
        '    "largest_by_area returns the largest",',
        ')'
      ]
    },
    {
      name: 'summaries',
      exports: ['describe_shape', 'shape_report'],
      // Defect: shape_report mutates the list it is given.
      lines: [
        '"""Human-readable summaries."""',
        '',
        '',
        'def describe_shape(name, sides):',
        '    """One line describing a shape."""',
        '    if sides < 3:',
        '        raise ValueError("a shape needs at least three sides")',
        '    return "%s has %d sides" % (name, sides)',
        '',
        '',
        'def shape_report(shapes):',
        '    """Lines describing every shape, with a trailing count."""',
        '    lines = shapes',
        '    lines.append("%d shapes" % len(shapes))',
        '    return lines',
        ''
      ],
      checks: [
        'check(',
        '    geometry.describe_shape("square", 4) == "square has 4 sides",',
        '    "describe_shape names the shape",',
        ')',
        'original = ["a", "b"]',
        'report = geometry.shape_report(original)',
        'check(report == ["a", "b", "2 shapes"], "shape_report appends a count")',
        'check(original == ["a", "b"], "shape_report does not mutate its argument")'
      ]
    }
  ]
}

function write(file, rows) {
  fs.writeFileSync(file, `${rows.join('\n')}\n`, 'utf-8')
}
