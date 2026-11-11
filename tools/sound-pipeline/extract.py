import sys, os, zipfile
sys.path.insert(0, sys.argv[2])
import py7zr
base = sys.argv[1]
for d in sorted(os.listdir(base)):
    if not d.startswith('oga_'): continue
    for f in os.listdir(os.path.join(base, d)):
        p = os.path.join(base, d, f); out = os.path.join(base, d, 'x')
        try:
            if f.lower().endswith('.zip'):
                zipfile.ZipFile(p).extractall(out); print('unzipped', d, f)
            elif f.lower().endswith('.7z'):
                with py7zr.SevenZipFile(p, 'r') as z: z.extractall(out)
                print('un7z', d, f)
        except Exception as e:
            print('ERR', d, f, e)
