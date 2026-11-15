#!/usr/bin/env python3
"""Build the compact runtime catalog from the Valio Aimo challenge product download.

Usage: prepare_catalog.py data/raw/products.json data/catalog.json
Only structured supplier fields are carried over; nothing is inferred from product names.
"""
import json, sys, os
from decimal import Decimal, InvalidOperation

def dec(v):
    try:
        n = Decimal(str(v))
        return n if n.is_finite() and n > 0 else None
    except (InvalidOperation, TypeError):
        return None

FACT = {'LTR': ('L', Decimal(1)), 'MLT': ('L', Decimal('0.001')), 'KGM': ('kg', Decimal(1)), 'GRM': ('kg', Decimal('0.001'))}

def physical(row, data):
    if row.get('salesUnit') == 'KG':
        return {'v': 1.0, 'u': 'kg', 'n': 1.0}
    if data.get('variableUnit') is not False:
        return None
    sizes = {dec(u.get('sizeInBaseUnits')) for u in row.get('units', []) if u.get('unitId') == row.get('salesUnit')}
    if len(sizes) != 1 or None in sizes:
        return None
    size = sizes.pop()
    conv = [u for u in data.get('unitConversions', []) if u.get('synkkaPackagingType') == 'BASE_UNIT_OR_EACH']
    if len(conv) != 1:
        return None
    vol = conv[0].get('volume') or {}
    wt = conv[0].get('netWeight') or {}
    ev = vol if vol.get('unit') in ('LTR', 'MLT') else wt
    if ev.get('unit') not in FACT or not dec(ev.get('value')):
        return None
    unit, f = FACT[ev['unit']]
    return {'v': float(dec(ev['value']) * size * f), 'u': unit, 'n': float(size)}

def lang(items, *langs):
    for l in langs:
        for it in items or []:
            if it.get('language') == l and isinstance(it.get('value'), str) and it['value'].strip():
                return it['value'].strip(), l
    return None, None

def main():
    rows = json.load(open(sys.argv[1], encoding='utf-8'))
    raw_dir = os.path.dirname(sys.argv[1])
    def table(name):
        t = {}
        path = os.path.join(raw_dir, name)
        if os.path.exists(path):
            for line in open(path, encoding='utf-8').read().splitlines()[1:]:
                k, _, v = line.partition(',')
                try: t[k.strip()] = float(v)
                except ValueError: pass
        return t
    rel, co2 = table('reliability.csv'), table('carbon.csv')
    out = []
    for row in rows:
        d = row.get('synkkaData') or {}
        name, _ = lang(d.get('names'), 'fi', 'en', 'sv')
        if not name:
            continue
        name_en, _ = lang(d.get('names'), 'en')
        name_sv, _ = lang(d.get('names'), 'sv')
        ing, ing_lang = lang(d.get('keyIngredients'), 'fi', 'en', 'sv')
        cls = {c.get('name'): c.get('values') or [] for c in d.get('classifications', [])}
        al = {}
        lvl = {'CONTAINS': 'C', 'MAY_CONTAIN': 'M', 'UNDECLARED': 'U', 'FREE_FROM': 'F'}
        for v in cls.get('allergen', []) + cls.get('nonAllergen', []):
            code, l = v.get('id'), lvl.get(v.get('unit'))
            if not code or not l:
                continue
            prev = al.get(code)
            # keep the most cautious declaration if the supplier data repeats a code
            order = 'FUMC'
            if prev is None or order.index(l) > order.index(prev):
                al[code] = l
        item = {
            'id': str(row['id']), 'name': name[:240], 'brand': (d.get('brand') or '').strip(),
            'vendor': row.get('vendorName') or '', 'cat': str(row.get('category', '')),
            'su': row['salesUnit'], 'bu': row.get('baseUnit'), 'lot': float(dec(row.get('allowedLotSize')) or 1),
            'gtin': row.get('salesUnitGtin'), 'del': row.get('deleted') is True,
            'var': d.get('variableUnit') is not False, 'dep': bool(row.get('deposits')),
            'al': al, 'hasAl': bool(cls.get('allergen') or cls.get('nonAllergen')),
            'claims': sorted({v.get('id') for v in cls.get('nutritionalClaim', []) if v.get('id')}),
            'subs': sorted({s.get('substituteProduct') for s in row.get('substitutions', []) if s.get('substituteProduct')}),
            'upd': d.get('lastUpdated'), 'temp': row.get('temperatureCondition'),
        }
        labels = sorted({v.get('id') for v in cls.get('packagingMarkedLabel', [])
                         if v.get('id') and v['id'] not in ('warmTemperature', 'coolTemperature', 'freezeTemperature')})
        if labels:
            item['labels'] = labels
        if row.get('countryOfOrigin'):
            item['origin'] = row['countryOfOrigin']
        if name_en and name_en != name:
            item['en'] = name_en[:240]
        if name_sv and name_sv != name:
            item['sv'] = name_sv[:240]
        for l in ('en', 'sv'):
            t, tl = lang(d.get('keyIngredients'), l)
            if t and tl != ing_lang:
                item['ing_' + l] = t[:4000]
        if ing:
            item['ing'] = ing[:4000]
            item['ingLang'] = ing_lang
        p = physical(row, d)
        if p:
            item['per'] = p
        sizes = {dec(u.get('sizeInBaseUnits')) for u in row.get('units', []) if u.get('unitId') == row.get('salesUnit')}
        if len(sizes) == 1 and None not in sizes:
            item['n'] = float(sizes.pop())  # base units (pieces) in one sales unit
        if item['id'] in rel:
            item['rel'] = rel[item['id']]  # historical delivery reliability (challenge dataset)
        if item['id'] in co2:
            item['co2'] = round(co2[item['id']], 3)  # category-level average kg CO2-eq per kg
        out.append(item)
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(json.dumps({'records': len(out), 'withIngredients': sum('ing' in i for i in out), 'withAllergenData': sum(i['hasAl'] for i in out), 'withPhysical': sum('per' in i for i in out), 'bytes': os.path.getsize(sys.argv[2])}))

if __name__ == '__main__':
    main()
