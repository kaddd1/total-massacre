import re, sys, os, os, json, urllib.request, html
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
base = sys.argv[1]
meta_path = os.path.join(base, 'fs_meta.json')
meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
for sid in sys.argv[2:]:
    if sid in meta and meta[sid].get('file'): continue
    try:
        req = urllib.request.Request(f'https://freesound.org/s/{sid}/', headers={'User-Agent': UA})
        r = urllib.request.urlopen(req, timeout=30); h = r.read().decode('utf-8', 'replace'); page = r.geturl()
        lic = re.findall(r'(Creative Commons 0|Attribution NonCommercial[^<"]*|Attribution 4\.0|Attribution 3\.0|Sampling\+)', h)
        lic_link = re.findall(r'href="(https?://creativecommons\.org/[^"]+)"', h)
        title = html.unescape((re.findall(r'<meta property="og:title" content="([^"]*)"', h) or ['?'])[0])
        prev = re.findall(r'(https://cdn\.freesound\.org/previews/\d+/\d+_\d+-hq\.mp3)', h)
        if not prev:
            lq = re.findall(r'(https://cdn\.freesound\.org/previews/\d+/\d+_\d+-lq\.mp3)', h)
            prev = [u.replace('-lq.mp3', '-hq.mp3') for u in lq]
        user = page.split('/people/')[1].split('/')[0] if '/people/' in page else '?'
        is_cc0 = any('publicdomain/zero' in l for l in lic_link) or 'Creative Commons 0' in lic
        d = os.path.join(base, 'fs_' + sid); os.makedirs(d, exist_ok=True)
        fn = None
        if is_cc0 and prev:
            data = urllib.request.urlopen(urllib.request.Request(prev[0], headers={'User-Agent': UA}), timeout=120).read()
            fn = os.path.join(d, f'{sid}.mp3'); open(fn, 'wb').write(data)
        meta[sid] = {'title': title, 'user': user, 'page': page, 'cc0': is_cc0, 'lic_links': sorted(set(lic_link))[:3], 'preview': prev[:1], 'file': fn}
        print(sid, 'CC0' if is_cc0 else 'NOT-CC0', user, '|', title[:50], '|', (os.path.getsize(fn) if fn else 'no file'))
    except Exception as e:
        print(sid, 'ERR', e)
json.dump(meta, open(meta_path, 'w'), indent=1)
