import re, sys, os, urllib.request, urllib.parse, html, json
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30).read().decode('utf-8', 'replace')
out = {}
for q in sys.argv[1:]:
    url = 'https://freesound.org/search/?' + urllib.parse.urlencode({'q': q, 'f': 'license:"Creative Commons 0"', 's': 'Downloads (most first)'})
    h = get(url)
    # each result: sound link /people/<user>/sounds/<id>/ + title + mp3 preview + duration
    items = []
    for m in re.finditer(r'data-mp3="([^"]+)"[^>]*data-ogg="[^"]*"[^>]*', h):
        items.append(m.group(1))
    titles = re.findall(r'href="/people/([^/]+)/sounds/(\d+)/"[^>]*title="([^"]*)"', h)
    seen = []
    for u, i, t in titles:
        if i not in [s[1] for s in seen]: seen.append((u, i, html.unescape(t)))
    durs = re.findall(r'data-duration="([\d.]+)"', h)
    print('###', q, '| results:', len(seen))
    for k, (u, i, t) in enumerate(seen[:8]):
        print(f'  {i} | {u} | {t[:60]} | dur={durs[k] if k < len(durs) else "?"}')
    out[q] = seen[:8]
json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'fs_results.json'), 'w'), indent=1)
