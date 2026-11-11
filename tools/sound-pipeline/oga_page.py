import re, sys, os, urllib.request, html, json
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
res = {}
for slug in sys.argv[1:]:
    url = 'https://opengameart.org/content/' + slug
    h = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30).read().decode('utf-8', 'replace')
    lic = re.findall(r"license-name'>([^<]+)</div>", h)
    author = re.findall(r'Author:.*?<a href="/users/[^"]+"[^>]*>([^<]+)</a>', h, re.S)
    files = re.findall(r'href="(https://opengameart\.org/sites/default/files/[^"]+)"', h)
    files = [f for f in dict.fromkeys(files) if not re.search(r'\.(png|jpg|jpeg|gif)$', f, re.I)]
    attrib = re.findall(r'Attribution Instructions:.*?<div class="field-item even">(.*?)</div>', h, re.S)
    res[slug] = {'license': lic, 'author': author[:1], 'files': files, 'attrib': [re.sub('<[^>]+>', '', html.unescape(a)).strip()[:200] for a in attrib]}
    print(f"{slug}: lic={lic} by={author[:1]} files={[f.rsplit('/',1)[1] for f in files]}")
json.dump(res, open(os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), 'oga_meta.json'), 'w'), indent=1)
