import sys, os, urllib.request, urllib.parse
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
base = sys.argv[1]
for line in open(os.path.join(base, 'urls2.txt'), encoding='utf-8'):
    slug, url = line.split()
    d = os.path.join(base, 'oga_' + slug); os.makedirs(d, exist_ok=True)
    fn = urllib.parse.unquote(url.rsplit('/', 1)[1])
    dst = os.path.join(d, fn)
    if os.path.exists(dst) and os.path.getsize(dst) > 0: continue
    try:
        data = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=180).read()
        open(dst, 'wb').write(data); print('ok', slug, fn, len(data))
    except Exception as e:
        print('FAIL', slug, fn, e)
