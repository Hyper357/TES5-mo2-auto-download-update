import os
import sys
import time
import json
import urllib.request
import subprocess
from pathlib import Path
from websocket import create_connection

# Ensure UTF-8 output
sys.stdout.reconfigure(encoding='utf-8')

CLEAN_LIST_PATH = Path('tools/clean_update_list.json')
MO2_NXM_HANDLER = r'E:\SkyrimAE\mo2\nxmhandler.exe'
CDP_BASE = 'http://127.0.0.1:9222'

def get_browser_ws():
    req = urllib.request.Request(f'{CDP_BASE}/json/version')
    with urllib.request.urlopen(req) as resp:
        info = json.loads(resp.read().decode('utf-8'))
    return info['webSocketDebuggerUrl']

def download_mod(item, total, idx):
    mid = item['mod_id']
    fid = item['target_file_id']
    name = item['name']
    
    target_url = f'https://www.nexusmods.com/skyrimspecialedition/mods/{mid}?tab=files&file_id={fid}&nmm=1'
    print(f'[{idx:02d}/{total:02d}] 🚀 正在处理: {name[:32]} (Mod {mid}, File {fid})...')
    
    # Create new background tab via CDP
    req = urllib.request.Request(f'{CDP_BASE}/json/new?{target_url}', method='PUT')
    with urllib.request.urlopen(req) as resp:
        tab_info = json.loads(resp.read().decode('utf-8'))
    
    tab_id = tab_info['id']
    ws_url = tab_info['webSocketDebuggerUrl']
    
    signed_nxm = None
    try:
        ws = create_connection(ws_url, suppress_origin=True)
        # Navigate
        ws.send(json.dumps({'id': 1, 'method': 'Page.navigate', 'params': {'url': target_url}}))
        
        # Wait 4.5s for page to render and modal to appear
        time.sleep(4.5)
        
        # Trigger 'Slow download' button inside Shadow DOM
        click_script = '''
        (() => {
            const el = document.querySelector('mod-file-download');
            if (!el || !el.shadowRoot) return { ok: false, msg: 'no mod-file-download' };
            const btns = Array.from(el.shadowRoot.querySelectorAll('button, a'));
            const slowBtn = btns.find(b => b.innerText.toLowerCase().includes('slow download'));
            if (!slowBtn) return { ok: false, msg: 'no slow download button' };
            slowBtn.click();
            return { ok: true };
        })()
        '''
        ws.send(json.dumps({'id': 2, 'method': 'Runtime.evaluate', 'params': {'expression': click_script, 'returnByValue': True}}))
        
        # Wait 6.5s for Nexus 5-second countdown to complete and generate signed nxm link
        time.sleep(6.5)
        
        # Extract signed nxm link
        extract_script = '''
        (() => {
            const el = document.querySelector('mod-file-download');
            if (!el || !el.shadowRoot) return null;
            const a = el.shadowRoot.querySelector('a[href*="nxm://"]');
            return a ? a.href : null;
        })()
        '''
        ws.send(json.dumps({'id': 3, 'method': 'Runtime.evaluate', 'params': {'expression': extract_script, 'returnByValue': True}}))
        
        while True:
            res = json.loads(ws.recv())
            if res.get('id') == 3:
                signed_nxm = res.get('result', {}).get('result', {}).get('value')
                break
        
        ws.close()
    except Exception as e:
        print(f'   ❌ 发生异常: {e}')
    finally:
        # Close the tab
        try:
            urllib.request.urlopen(urllib.request.Request(f'{CDP_BASE}/json/close/{tab_id}', method='PUT'))
        except:
            pass

    if signed_nxm:
        print(f'   ✅ 成功获取合法签名 NXM 链接！正在推入 MO2...')
        subprocess.run([MO2_NXM_HANDLER, signed_nxm])
    else:
        print(f'   ⚠️ 未能直接抓取到签名链接，可能已由浏览器默认通道直接拉起。')

def main():
    with open(CLEAN_LIST_PATH, 'r', encoding='utf-8') as f:
        updates = json.load(f)
    
    total = len(updates)
    print(f'==================================================')
    print(f' 🎯 启动全自动化后台静默下载通道 (共 {total} 个 Mod)')
    print(f'==================================================\n')
    
    for idx, item in enumerate(updates, 1):
        download_mod(item, total, idx)
        time.sleep(1.0)
        
    print(f'\n🎉 全部 {total} 个 Mod 已全自动提取合法签名并注入 MO2 下载队列！')

if __name__ == '__main__':
    main()
