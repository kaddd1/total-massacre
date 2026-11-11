import re, sys, urllib.request, urllib.parse, html
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"
def search(q, lic=None):
    p = {'keys': q, 'field_art_type_tid[]': '13', 'sort_by': 'count', 'sort_order': 'DESC'}
    if lic: p['field_art_licenses_tid[]'] = lic
    url = 'https://opengameart.org/art-search-advanced?' + urllib.parse.urlencode(p)
    h = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=30).read().decode('utf-8', 'replace')
    out = re.findall(r'<span class="art-preview-title"><a href="(/content/[^"]+)">([^<]+)</a>', h)
    return [(a, html.unescape(t)) for a, t in out]
for q in sys.argv[1:]:
    r = search(q, '4')  # 4 = CC0
    print('###', q, '(CC0):', '; '.join(f'{t} [{a[9:]}]' for a, t in r[:10]))
