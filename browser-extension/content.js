
(function () {
  'use strict';

  const BRIDGE   = 'http://localhost:7432';
  const SFAB_API = 'https://api.sketchfab.com/v3';
  let busy = false;
  let pollTimer = null;
  let availableFmts = {};
  let selectedFmt = null;

  const PRETTY = { gltf: 'GLB', fbx: 'FBX', obj: 'OBJ', source: 'Source' };

  function getUID() {
    const fromPath = window.location.pathname.match(/-([a-f0-9]{32})(?:[/?#].*)?$/i);
    if (fromPath) return fromPath[1];

    const iframe = document.querySelector(
      '.c-overlay__content iframe, [class*="overlay"] iframe, [class*="modal"] iframe, iframe[src*="sketchfab.com/models/"]'
    );
    if (iframe) {
      const m = (iframe.src || '').match(/\/models\/([a-f0-9]{32})/i);
      if (m) return m[1];
    }

    /* Overlay anchor tag that carries the UID in href */
    const link = document.querySelector(
      '[class*="overlay"] a[href*="/3d-models/"], [class*="modal"] a[href*="/3d-models/"]'
    );
    if (link)
    {
      const m = link.href.match(/-([a-f0-9]{32})(?:[/?#].*)?$/i);
      if (m) 
      {
        return m[1];
      }
      
    }

    return null;
  }

  function getToken()
  {
    return new Promise(res => chrome.storage.sync.get(['apiToken'], d => res(d.apiToken || '')));
  }

  function fetchT(url, opts = {}, ms = 5000) 
  {
    return new Promise((res, rej) =>
    {
      const t = setTimeout(() => rej(new Error('Timeout')), ms);
      fetch(url, opts).then(r => { clearTimeout(t); res(r); })
          .catch(e => { clearTimeout(t); rej(e); });
    });
  }

  let _shadow = null;

  function getShadow()
  {
    if (_shadow) 
    {
      return _shadow;
    }
    
    const host = document.createElement('div');
    host.id = 'sfab-host';
    Object.assign(host.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      overflow: 'visible',
    });
    
    document.documentElement.appendChild(host);
    _shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; }
      #sfab-root {
        position: fixed;
        bottom: 28px;
        right: 28px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        pointer-events: auto;
      }
    `;
    _shadow.appendChild(style);
    return _shadow;
  }

  function $id(id)
  {
    return getShadow().getElementById(id);
  }

  function buildUI()
  {
    const shadow = getShadow();
    shadow.getElementById('sfab-root')?.remove();
    shadow.getElementById('sfab-toast')?.remove();

    const uid = getUID();
    if (!uid) return;

    availableFmts = {};
    selectedFmt   = null;

    const root = document.createElement('div');
    root.id = 'sfab-root';

    const chipsRow = document.createElement('div');
    chipsRow.id = 'sfab-chips';
    css(chipsRow, {
      display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end',
    });

    const btn = document.createElement('button');
    btn.id = 'sfab-btn';
    css(btn, {
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: '0px', padding: '13px 24px 10px',
      background: '#E87D0D', color: '#fff', border: 'none',
      borderRadius: '10px', fontSize: '14px', fontWeight: '700',
      cursor: 'pointer', boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      minWidth: '210px', userSelect: 'none',
      transition: 'background .15s, transform .15s', pointerEvents: 'auto',
    });

    const topRow = document.createElement('div');
    css(topRow, { display: 'flex', alignItems: 'center', gap: '8px' });
    topRow.appendChild(mkSVG());
    const lbl = document.createElement('span');
    lbl.id = 'sfab-lbl';
    lbl.textContent = 'Import to Blender';
    topRow.appendChild(lbl);

    const sub = document.createElement('div');
    sub.id = 'sfab-sub';
    css(sub, { fontSize: '11px', fontWeight: '500', opacity: '0.8', marginTop: '2px', minHeight: '14px' });
    sub.textContent = 'Loading formats…';

    const barWrap = document.createElement('div');
    barWrap.id = 'sfab-barwrap';
    css(barWrap, {
      width: '100%', height: '4px', background: 'rgba(255,255,255,0.3)',
      borderRadius: '3px', marginTop: '8px', display: 'none', overflow: 'hidden',
    });
    const bar = document.createElement('div');
    bar.id = 'sfab-bar';
    css(bar, { height: '100%', width: '0%', background: '#fff', borderRadius: '3px', transition: 'width .4s ease' });
    barWrap.appendChild(bar);

    btn.appendChild(topRow);
    btn.appendChild(sub);
    btn.appendChild(barWrap);
    btn.onmouseenter = () => { if (!busy) btn.style.transform = 'translateY(-2px)'; };
    btn.onmouseleave = () => { btn.style.transform = 'translateY(0)'; };
    btn.onclick = handleClick;

    root.appendChild(chipsRow);
    root.appendChild(btn);
    shadow.appendChild(root);

    loadFormats(uid);
  }

  async function loadFormats(uid) {
    const token = await getToken();
    const sub   = $id('sfab-sub');
    const chips = $id('sfab-chips');

    if (!token)
    {
      if (sub) sub.textContent = 'Add API token in extension popup';
      return;
    }

    try
    {
      const resp = await fetchT(
        `${SFAB_API}/models/${uid}/download`,
        { headers: { Authorization: `Token ${token}` } },
        8000
      );
      if (!resp.ok)
      {
        if (sub) 
        {
          sub.textContent = resp.status === 403 ? '🔒 Not downloadable' : `API error ${resp.status}`;
        }
        
        return;
      }
      const data = await resp.json();
      availableFmts = {};
      for (const key of ['gltf', 'fbx', 'obj', 'source'])
      {
        
        if (data[key]?.url) 
        {
          availableFmts[key] = data[key];
        }
        
      }
      const fmtKeys = Object.keys(availableFmts);
      if (!fmtKeys.length)
      {
        if (sub) 
        {
          sub.textContent = '🔒 No downloadable formats';
        } return; 
      }

      selectedFmt = fmtKeys[0];

      if (chips)
      {
        chips.innerHTML = '';
        for (const key of fmtKeys) 
        {
          const chip = document.createElement('button');
          chip.dataset.fmt = key;
          const sz = availableFmts[key].size ? ` ${(availableFmts[key].size/1024/1024).toFixed(0)}MB` : '';
          chip.textContent = (PRETTY[key] || key.toUpperCase()) + sz;
          css(chip, {
            padding: '5px 10px', borderRadius: '6px', border: '2px solid transparent',
            background: 'rgba(30,30,30,0.85)', color: '#ddd', fontSize: '12px',
            fontWeight: '700', cursor: 'pointer', fontFamily: 'inherit',
            transition: 'all .15s', backdropFilter: 'blur(6px)', pointerEvents: 'auto',
          });
          chip.onclick = () => selectFmt(key);
          chips.appendChild(chip);
        }
        selectFmt(selectedFmt);
      }
      updateSub();
    } catch {
      if (sub) sub.textContent = 'Could not load formats';
    }
  }

  function selectFmt(key)
  {
    selectedFmt = key;
    getShadow().querySelectorAll('#sfab-chips button').forEach(c => 
    {
      const a = c.dataset.fmt === key;
      c.style.background  = a ? '#E87D0D' : 'rgba(30,30,30,0.85)';
      c.style.color = a ? '#fff'    : '#ddd';
      c.style.borderColor = a ? '#fff' : 'transparent';
      c.style.transform = a ? 'translateY(-1px)' : 'none';
    });
    updateSub();
  }

  function updateSub()
  {
    const sub = $id('sfab-sub');
    if (!sub || !selectedFmt) 
    {
      return;
    }
    
    const info = availableFmts[selectedFmt];
    const name = PRETTY[selectedFmt] || selectedFmt.toUpperCase();
    const sz = info?.size ? ` · ${(info.size/1024/1024).toFixed(1)} MB` : '';
    sub.textContent = `Format: ${name}${sz}`;
  }

  async function handleClick() {
    if (busy) return;
    const uid   = getUID();
    const token = await getToken();

    if (!uid) 
    {
      toast('Could not detect model ID', '#b22222');
      return; 
    }
    
    if (!token) 
    { 
      toast('Add your API token in the extension popup', '#c0790a');
      return;
    }
    
    if (!selectedFmt) 
    {
      toast('Formats still loading, try again in a second', '#c0790a');
      return; 
    }

    busy = true;
    setBtn('loading', 'Connecting to Blender…', null);

    let blenderOk = false;
    for (let i = 0; i < 3; i++) 
    {
      try 
      {
        const h = await fetchT(`${BRIDGE}/status`, {}, 2000);
        if (h.ok) 
        {
          blenderOk = true; break;
        }
      } catch (_) {}
      if (i < 2) 
      {
        setBtn('loading', `Connecting… (attempt ${i+2}/3)`, null);
        await new Promise(r => setTimeout(r, 900));
      }
    }

    if (!blenderOk)
    {
      busy = false; setBtn('idle');
      toast('❌ Blender is not open! Open Blender with the add-on enabled.', '#b22222');
      return;
    }

    setBtn('loading', 'Starting download…', 2);

    try
    {
      const r = await fetchT(`${BRIDGE}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_uid: uid, api_token: token, format: selectedFmt }),
      }, 8000);
      const res = await r.json();
      
      if (!res.success) 
      {
        throw new Error(res.error || 'Failed');
      }
      
    } catch (e) {
      busy = false; setBtn('idle');
      toast(`❌ ${e.message}`, '#b22222');
      return;
    }

    pollTimer = setInterval(() => pollProgress(uid), 700);
  }

  async function pollProgress(uid)
  {
    try {
      const r = await fetch(`${BRIDGE}/progress/${uid}`);
      const data = await r.json();
      const pct  = data.pct   || 0;
      const lbl  = data.label || 'Working…';
      if (data.status === 'done') 
      {
        clearInterval(pollTimer); busy = false;
        setBtn('success', 'Imported!', 100);
        toast('Model is now in Blender!', '#1e6e3e');
        setTimeout(() => setBtn('idle'), 5000);
      }
      else if (data.status === 'error')
      {
        clearInterval(pollTimer); busy = false;
        setBtn('idle'); toast(`❌ ${lbl}`, '#b22222');
      } 
      else 
      {
        setBtn('loading', lbl, pct);
      }
    } catch (_) {}
  }

  /* If Village */
  function setBtn(state, label, pct)
  {
    const btn = $id('sfab-btn');
    const lbl = $id('sfab-lbl');
    const barWrap = $id('sfab-barwrap');
    const bar = $id('sfab-bar');
    if (!btn)
    {
      return;
    }
    
    if (state === 'idle') 
    {
      btn.style.background = '#E87D0D'; btn.style.cursor = 'pointer';
      if (lbl) 
      {
        lbl.textContent = 'Import to Blender';
      }
      
      if (barWrap) 
      {
        barWrap.style.display = 'none';
      }
      
      if (bar) 
      {
        bar.style.width       = '0%';
      }
      
      updateSub();
    } 
    else if (state === 'loading')
    {
      btn.style.background = '#444'; btn.style.cursor = 'wait';
      if (lbl) 
      {
        lbl.textContent = label || 'Working…';
      }
      
      if (barWrap) 
      {
        barWrap.style.display = 'block';
      }
      
      if (bar && pct != null) 
      {
        bar.style.width = pct + '%';
      }
      
      const sub = $id('sfab-sub');
      if (sub) 
      {
        sub.textContent = '';
      }
      
    } 
    else if (state === 'success')
    {
      btn.style.background = '#2a7a4f'; btn.style.cursor = 'default';
      if (lbl) 
      {
        lbl.textContent = label;
      }
      
      if (barWrap) 
      {
        barWrap.style.display = 'block';
      }
      
      if (bar) 
      {
        bar.style.width = '100%';
      }
      
    }
  }

  function toast(msg, bg = '#333') 
  {
    const shadow = getShadow();
    shadow.getElementById('sfab-toast')?.remove();
    const t = document.createElement('div');
    t.id = 'sfab-toast';
    css(t, {
      position: 'fixed', bottom: '105px', right: '28px', zIndex: '2147483647',
      background: bg, color: '#fff', padding: '11px 16px', borderRadius: '8px',
      fontSize: '13px', fontWeight: '600',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      maxWidth: '320px', boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
      opacity: '0', transform: 'translateY(8px)',
      transition: 'opacity .25s, transform .25s', pointerEvents: 'none',
    });
    t.textContent = msg;
    shadow.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 5000);
  }

  function css(el, styles) 
  { 
    Object.assign(el.style, styles); 
  }

  function mkSVG()
  {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('width', '15'); s.setAttribute('height', '15');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
    s.style.flexShrink = '0';
    s.innerHTML = `<path d="M12 2L2 7l10 5 10-5-10-5z" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>
      <path d="M2 17l10 5 10-5M2 12l10 5 10-5" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>`;
    return s;
  }

  /* (c) overlay closing, (d) SPA navigation between pages. 
  * For Some Reason, Sketchfab Have 2 type Models Page, One is Full Page And One is Overlay.
  * */
  let lastUID  = null;
  let lastPath = location.pathname;

  function maybeRebuild()
  {
    const uid = getUID();

    if (location.pathname !== lastPath)
    {
      lastPath = location.pathname;
      clearInterval(pollTimer);
      busy = false;
      lastUID = null;
    }

    if (uid && uid !== lastUID)
    {
      lastUID = uid;
      buildUI();
      return;
    }

    if (!uid && getShadow().getElementById('sfab-root'))
    {
      getShadow().getElementById('sfab-root')?.remove();
      getShadow().getElementById('sfab-toast')?.remove();
      lastUID = null;
    }
  }

  new MutationObserver(maybeRebuild)
    .observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => 
  {
    if (location.pathname !== lastPath) 
    {
      maybeRebuild();
    }
    
  }, 500);

  maybeRebuild();
  setTimeout(maybeRebuild, 1500);
  setTimeout(maybeRebuild, 3500);

})();