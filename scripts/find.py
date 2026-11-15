import json,sys,re
c=json.load(open('data/catalog.json'))
q=[t.lower() for t in sys.argv[1].split()]
neg=[t.lower() for t in (sys.argv[2].split() if len(sys.argv)>2 else [])]
n=0
for p in c:
    s=(p['name']+' '+p.get('ing','')).lower() if '--ing' in sys.argv else p['name'].lower()
    if all(t in s for t in q) and not any(t in p['name'].lower() for t in neg) and not p['del']:
        print(p['id'],'|',p['name'],'|',p['su'],p.get('per'),'|',p['al'],'|',p['claims'],'|',p.get('ing','')[:160])
        n+=1
        if n>=int(sys.argv[3] if len(sys.argv)>3 and sys.argv[3].isdigit() else 14): break
