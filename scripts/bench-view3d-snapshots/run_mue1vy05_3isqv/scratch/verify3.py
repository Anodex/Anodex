# -*- coding: utf-8 -*-
import io
tl = io.open('tests.py', encoding='utf-8').read().splitlines()
print("total lines:", len(tl))
print("check defs:", [tl[i] for i in range(len(tl)) if 'def check(' in tl[i]])
print("head (first 30):")
for i in range(30):
    print(f"  {i+1:4d} {tl[i]}")
print("feature_14 body (716-751):")
for i in range(715, 751):
    print(f"  {i+1:4d} {tl[i]}")
