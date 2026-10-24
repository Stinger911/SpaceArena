#!/usr/bin/env python3
"""E2E: два браузера играют через эмулятор Cardputer (портал → комната → старт → бой).
Запуск: npm run build:cardputer && python3 tests/e2e/mp_smoke.py"""
import json, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

PORT = 8099
BASE = f'http://127.0.0.1:{PORT}'

def api(path, body=None, token=''):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'X-Token': token, 'Content-Type': 'application/json'},
                                 method='POST' if body is not None else 'GET')
    return json.load(urllib.request.urlopen(req))

srv = subprocess.Popen(['node', 'server/cardputer-server.mjs', '--port', str(PORT), '--latency', '30', '--jitter', '10'],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
ok = False
try:
    for _ in range(50):
        try: api('/api/status'); break
        except Exception: time.sleep(0.1)
    a = api('/api/guest', {}); b = api('/api/guest', {})
    games = api('/api/games', token=a['token'])['games']
    assert any(g['id'] == 'space-arena' and g['max'] == 4 for g in games), games
    room = api('/api/room/create', {'game': 'space-arena', 'title': 'e2e'}, a['token'])['room']
    api('/api/room/join', {'id': room['id']}, b['token'])

    errors = []
    with sync_playwright() as p:
        br = p.chromium.launch()
        pages = []
        for who, tok in (('A', a['token']), ('B', b['token'])):
            ctx = br.new_context(viewport={'width': 960, 'height': 540})
            pg = ctx.new_page()
            pg.on('console', lambda m, w=who: errors.append(f'{w}: {m.text}') if m.type == 'error' else None)
            pg.on('pageerror', lambda e, w=who: errors.append(f'{w} pageerror: {e}'))
            pages.append(pg)
        # портал: хост нажимает «Старт» — комната закрывается, все переходят в игру
        api('/api/room/start', {}, a['token'])
        for pg, tok in zip(pages, (a['token'], b['token'])):
            pg.goto(f"{BASE}/g/space-arena/?room={room['id']}&t={tok}")
        pages[0].wait_for_selector('button[data-act="start"]', timeout=10000)
        pages[0].click('button[data-act="mode"][data-v="team"]')
        pages[0].click('button[data-act="start"]')
        for pg in pages:
            pg.wait_for_function('window.__sa && window.__sa.state === "play"', timeout=15000)
        # игроки жмут газ/огонь: держим пробел у обоих
        for pg in pages:
            pg.keyboard.down('Space'); pg.keyboard.down('KeyW')
        time.sleep(8)
        s = [pg.evaluate('({ships: window.__sa.ships(), me: window.__sa.localId, role: window.__sa.role, dbg: window.__sa.debug()})') for pg in pages]
        pages[0].screenshot(path='/tmp/mp_host.png'); pages[1].screenshot(path='/tmp/mp_client.png')
        br.close()
    print('roles', [x['role'] for x in s], 'locals', [x['me'] for x in s])
    print('debug host', s[0]['dbg']); print('debug client', s[1]['dbg'])
    assert [x['role'] for x in s] == ['host', 'client']
    assert s[0]['me'] == 0 and s[1]['me'] == 1
    assert len(s[0]['ships']) == len(s[1]['ships']) > 2, (len(s[0]['ships']), len(s[1]['ships']))
    worst = 0
    h = {x['id']: x for x in s[0]['ships']}
    for x in s[1]['ships']:
        if h[x['id']]['alive'] and x['alive']:
            d = sum((u - v) ** 2 for u, v in zip(h[x['id']]['pos'], x['pos'])) ** 0.5
            worst = max(worst, d)
    print('worst position diff host/client:', round(worst, 1))
    assert worst < 400, worst
    dbg = api('/api/debug')
    print('relay', {k: dbg['counters'][k] for k in ('wsIn', 'wsOut', 'maxIn', 'oversize')})
    assert dbg['counters']['oversize'] == 0 and dbg['counters']['maxIn'] <= 1024
    assert not [e for e in errors if 'favicon' not in e], errors
    ok = True
    print('E2E OK')
finally:
    srv.terminate()
sys.exit(0 if ok else 1)
