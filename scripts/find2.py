import json,sys
c=json.load(open('data/catalog.json'))
for q in sys.argv[1:]:
    lim=7
    toks=[t.lower() for t in q.split() if not t.startswith('-')]
    neg=[t[1:].lower() for t in q.split() if t.startswith('-')]
    print('###',q)
    n=0
    for p in c:
        s=p['name'].lower()
        if p['del'] or 'per' not in p or 'ing' not in p: continue
        if all(t in s for t in toks) and not any(t in s for t in neg):
            a=p['al']; k=''.join(f"{x}{a[x]} " for x in ('AW','UW','AM','ML','AE') if x in a)
            cl=','.join(x.replace('FREE_FROM_','ff') for x in p['claims'] if x in('FREE_FROM_GLUTEN','FREE_FROM_LACTOSE','FREE_FROM_WHEAT','LOW_LACTOSE'))
            print(f" {p['id']}|{p['name'][:62]}|{p['su']} {p['per']['v']}{p['per']['u']}|{k}|{cl}|{p['ing'][:70]}")
            n+=1
            if n>=lim: break
