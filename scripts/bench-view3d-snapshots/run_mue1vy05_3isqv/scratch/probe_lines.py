src = open('engine.py', encoding='utf-8').read()
lines = src.splitlines()
print('total lines:', len(lines))
for i, l in enumerate(lines, 1):
    if 'line_of_sight' in l or 'def _compute_fov' in l or 'def _walkable' in l:
        print(i, l)
print('--- walkable block ---')
for i, l in enumerate(lines, 1):
    if 'def _walkable' in l:
        for j in range(i - 1, min(i + 7, len(lines))):
            print(j, lines[j - 1])
