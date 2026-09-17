const { contextBridge, ipcRenderer } = require('electron');

const DISPLAY_PICKER_STATE = 'screenlink:display-picker:state';
let displayPickerSubscribers = 0;
let pickerHost = null;
let pickerCleanup = null;
let pickerCloseTimer = null;

function closeFallbackPicker(immediate = false) {
  if (pickerCloseTimer) clearTimeout(pickerCloseTimer);
  pickerCloseTimer = null;
  pickerCleanup?.();
  pickerCleanup = null;
  const host = pickerHost;
  pickerHost = null;
  if (!host) return;
  const overlay = host.shadowRoot?.querySelector('.overlay');
  const dialog = host.shadowRoot?.querySelector('.dialog');
  if (immediate || !overlay || !dialog || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    host.remove();
    return;
  }
  overlay.classList.remove('is-open');
  dialog.classList.remove('is-open');
  overlay.classList.add('is-closing');
  dialog.classList.add('is-closing');
  pickerCloseTimer = setTimeout(() => {
    pickerCloseTimer = null;
    host.remove();
  }, 150);
}

function renderFallbackPicker(state) {
  closeFallbackPicker(true);
  const sources = Array.isArray(state?.sources) ? state.sources : [];
  if (!state?.open || !sources.length) return;

  const host = document.createElement('div');
  host.id = 'screenlink-integrated-display-picker';
  host.dataset.open = 'true';
  host.dataset.sourceCount = String(sources.length);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { position: fixed; inset: 0; z-index: 2147483647; display: block; color-scheme: dark; font-family: Inter, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; }
      * { box-sizing: border-box; }
      button { color: inherit; font: inherit; }
      .overlay { position: absolute; inset: 0; padding: 1.25rem; display: grid; place-items: center; background: rgba(0,0,0,.7); opacity: 0; transition: opacity 250ms cubic-bezier(.22,1,.36,1); }
      .overlay.is-open { opacity: 1; }
      .overlay.is-closing { opacity: 0; pointer-events: none; transition-duration: 150ms; }
      .dialog { width: min(46rem, 100%); max-height: calc(100vh - 2.5rem); border: 1px solid rgba(230,244,247,.17); border-radius: 1.05rem; display: grid; grid-template-rows: auto auto minmax(0,1fr) auto; overflow: hidden; color: #edf3f4; background: #101314; box-shadow: 0 1.5rem 4.5rem rgba(0,0,0,.68); opacity: 0; transform: scale(.96); transition: opacity 250ms cubic-bezier(.22,1,.36,1), transform 250ms cubic-bezier(.22,1,.36,1); }
      .dialog.is-open { opacity: 1; transform: scale(1); }
      .dialog.is-closing { opacity: 0; transform: scale(.96); pointer-events: none; transition-duration: 150ms; }
      header { min-height: 4.75rem; padding: .9rem 1rem .8rem; display: grid; grid-template-columns: 2.55rem minmax(0,1fr) 2.35rem; align-items: center; gap: .75rem; }
      .picker-icon { width: 2.55rem; height: 2.55rem; border-radius: .72rem; display: grid; place-items: center; color: #94dbe5; background: #1c292c; }
      .picker-icon svg { width: 1.12rem; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; }
      .heading { min-width: 0; }
      h1 { margin: 0 0 .15rem; font-size: .95rem; font-weight: 650; letter-spacing: -.012em; }
      p { margin: 0; color: #879397; font-size: .7rem; line-height: 1.35; }
      .close { width: 2.35rem; height: 2.35rem; padding: 0; border: 0; border-radius: .65rem; display: grid; place-items: center; color: #8e989b; background: transparent; cursor: pointer; transition: color 150ms ease, background-color 150ms ease, transform 150ms cubic-bezier(.22,1,.36,1); }
      .close:hover { color: #f2f5f6; background: #1f2426; }
      .close:active { transform: scale(.94); }
      .close svg { width: .92rem; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.7; }
      nav { position: relative; isolation: isolate; width: min(18rem, calc(100% - 2rem)); margin: 0 1rem .85rem; padding: .18rem; border-radius: .65rem; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); background: #191d1f; }
      nav::before { content: ""; position: absolute; z-index: 0; top: .18rem; bottom: .18rem; left: .18rem; width: calc((100% - .36rem) / 2); border-radius: .5rem; background: #303638; transform: translateX(0); transition: transform 250ms cubic-bezier(.22,1,.36,1); }
      nav.is-window::before { transform: translateX(100%); }
      nav button { position: relative; z-index: 1; min-width: 0; min-height: 2.05rem; padding: 0 .62rem; border: 0; border-radius: .5rem; display: flex; align-items: center; justify-content: center; gap: .45rem; color: #899396; background: transparent; font-size: .69rem; font-weight: 620; cursor: pointer; transition: color 150ms ease, transform 150ms cubic-bezier(.22,1,.36,1); }
      nav button span { min-width: 1.2rem; padding: .08rem .28rem; border-radius: 999px; color: #929c9f; background: #252a2c; font-size: .57rem; line-height: 1.2; text-align: center; transition: color 150ms ease, background-color 150ms ease; }
      nav button.is-active { color: #f1f4f5; }
      nav button.is-active span { color: #dce2e3; background: #454c4f; }
      nav button:active { transform: scale(.97); }
      nav button:disabled { opacity: .42; cursor: default; }
      .scroll { min-height: 11rem; max-height: calc(100vh - 14.5rem); padding: 0 .8rem .85rem 1rem; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
      .scroll::-webkit-scrollbar { width: .5rem; }
      .scroll::-webkit-scrollbar-thumb { border: .12rem solid transparent; border-radius: 999px; background: #3a4347; background-clip: padding-box; }
      .grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: .65rem; }
      .source { min-width: 0; padding: .35rem; border: 1px solid transparent; border-radius: .78rem; color: #d5dcde; background: #171b1d; text-align: left; cursor: pointer; transition: transform 150ms cubic-bezier(.22,1,.36,1), border-color 150ms ease, background-color 150ms ease; }
      .source:hover, .source:focus-visible { outline: none; border-color: rgba(105,204,217,.72); background: #1d2426; transform: translateY(-.08rem); }
      .source:disabled { cursor: progress; opacity: .65; transform: none; }
      .thumbnail, .placeholder { width: 100%; aspect-ratio: 16/9; border-radius: .52rem; display: grid; place-items: center; object-fit: cover; color: #667276; background: #07090a; }
      .placeholder svg { width: 1.5rem; fill: none; stroke: currentColor; stroke-width: 1.6; }
      .label { min-width: 0; padding: .52rem .22rem .14rem; display: flex; align-items: center; gap: .42rem; }
      .label img { width: 1.05rem; height: 1.05rem; flex: 0 0 auto; border-radius: .22rem; }
      .label span { overflow: hidden; font-size: .7rem; font-weight: 580; text-overflow: ellipsis; white-space: nowrap; }
      .empty { min-height: 11rem; display: grid; place-items: center; color: #7d888c; font-size: .72rem; }
      footer { min-height: 3.65rem; padding: .62rem 1rem; border-top: 1px solid rgba(230,244,247,.09); display: flex; align-items: center; justify-content: space-between; gap: 1rem; background: #111516; }
      footer > span { display: inline-flex; align-items: center; gap: .45rem; color: #7f8a8d; font-size: .64rem; line-height: 1.4; }
      footer > span i { width: .38rem; height: .38rem; flex: 0 0 auto; border-radius: 50%; background: #69ccd9; box-shadow: 0 0 .45rem rgba(105,204,217,.28); }
      footer > span b { font-weight: 400; }
      footer button { min-width: 5rem; min-height: 2.25rem; padding: 0 .85rem; border: 0; border-radius: .62rem; color: #dbe0e2; background: #252b2d; font-size: .7rem; font-weight: 620; cursor: pointer; transition: background-color 150ms ease, transform 150ms cubic-bezier(.22,1,.36,1); }
      footer button:hover { background: #32393b; }
      footer button:active { transform: scale(.97); }
      @media (max-width: 1040px) { .grid { grid-template-columns: repeat(2,minmax(0,1fr)); } }
      @media (prefers-reduced-motion: reduce) { .overlay, .dialog, .source { transition: none !important; } }
    </style>
    <div class="overlay">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="picker-title" aria-describedby="picker-description">
        <header><span class="picker-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></span><div class="heading"><h1 id="picker-title">Compartilhar tela</h1><p id="picker-description">Escolha uma tela ou janela.</p></div><button class="close" type="button" aria-label="Cancelar compartilhamento"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
        <nav aria-label="Tipo de fonte"><button type="button" data-filter="screen">Telas <span></span></button><button type="button" data-filter="window">Janelas <span></span></button></nav>
        <div class="scroll"><div class="grid"></div><p class="empty" hidden>Nenhuma fonte disponível nesta categoria.</p></div>
        <footer><span><i aria-hidden="true"></i><b></b></span><button type="button" data-cancel>Cancelar</button></footer>
      </section>
    </div>`;
  const embeddedStyle = shadow.querySelector('style');
  const stylesheet = new CSSStyleSheet();
  stylesheet.replaceSync(embeddedStyle.textContent);
  shadow.adoptedStyleSheets = [stylesheet];
  embeddedStyle.remove();

  const overlay = shadow.querySelector('.overlay');
  const dialog = shadow.querySelector('.dialog');
  const grid = shadow.querySelector('.grid');
  const empty = shadow.querySelector('.empty');
  const filterButtons = [...shadow.querySelectorAll('[data-filter]')];
  let activeFilter = sources.some(source => source.kind === 'screen') ? 'screen' : 'window';
  let pending = false;

  const cancel = () => void ipcRenderer.invoke('screenlink:display-picker:cancel');
  const render = () => {
    grid.replaceChildren();
    const visible = sources.filter(source => source.kind === activeFilter);
    empty.hidden = visible.length > 0;
    for (const button of filterButtons) {
      const kind = button.dataset.filter;
      const count = sources.filter(source => source.kind === kind).length;
      button.querySelector('span').textContent = String(count);
      button.classList.toggle('is-active', kind === activeFilter);
      button.disabled = count === 0;
    }
    shadow.querySelector('nav').classList.toggle('is-window', activeFilter === 'window');
    for (const source of visible) {
      const button = document.createElement('button');
      button.className = 'source';
      button.type = 'button';
      button.title = source.name;
      button.setAttribute('aria-label', `Compartilhar ${source.name}`);
      if (source.thumbnail) {
        const thumbnail = document.createElement('img');
        thumbnail.className = 'thumbnail';
        thumbnail.src = source.thumbnail;
        thumbnail.alt = '';
        thumbnail.draggable = false;
        button.append(thumbnail);
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'placeholder';
        placeholder.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
        button.append(placeholder);
      }
      const label = document.createElement('span');
      label.className = 'label';
      if (source.appIcon) {
        const icon = document.createElement('img');
        icon.src = source.appIcon;
        icon.alt = '';
        icon.draggable = false;
        label.append(icon);
      }
      const name = document.createElement('span');
      name.textContent = source.name;
      label.append(name);
      button.append(label);
      button.addEventListener('click', async () => {
        if (pending) return;
        pending = true;
        for (const candidate of shadow.querySelectorAll('.source')) candidate.disabled = true;
        const accepted = await ipcRenderer.invoke('screenlink:display-picker:choose', source.id).catch(() => false);
        if (!accepted) {
          pending = false;
          for (const candidate of shadow.querySelectorAll('.source')) candidate.disabled = false;
        }
      });
      grid.append(button);
    }
  };

  for (const button of filterButtons) button.addEventListener('click', () => { activeFilter = button.dataset.filter; render(); });
  shadow.querySelector('.close').addEventListener('click', cancel);
  shadow.querySelector('[data-cancel]').addEventListener('click', cancel);
  overlay.addEventListener('pointerdown', event => { if (event.target === overlay) cancel(); });
  shadow.querySelector('footer b').textContent = state.systemAudioAvailable
    ? 'Áudio do sistema incluído quando disponível'
    : 'Somente o vídeo da fonte será enviado';

  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...shadow.querySelectorAll('button:not(:disabled)')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  window.addEventListener('keydown', onKeyDown, true);
  pickerCleanup = () => window.removeEventListener('keydown', onKeyDown, true);
  pickerHost = host;
  document.documentElement.append(host);
  render();
  requestAnimationFrame(() => {
    overlay.classList.add('is-open');
    dialog.classList.add('is-open');
    shadow.querySelector('.source, nav button:not(:disabled)')?.focus({ preventScroll: true });
  });
}

ipcRenderer.on(DISPLAY_PICKER_STATE, (_event, state) => {
  if (!state?.open) {
    closeFallbackPicker();
    return;
  }
  if (displayPickerSubscribers === 0) renderFallbackPicker(state);
  else closeFallbackPicker(true);
});

contextBridge.exposeInMainWorld('screenLinkProfile', Object.freeze({
  load: () => ipcRenderer.invoke('screenlink:profile:load'),
  save: profile => ipcRenderer.invoke('screenlink:profile:save', profile)
}));

contextBridge.exposeInMainWorld('screenLinkDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  getUpdateState: () => ipcRenderer.invoke('screenlink:update:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('screenlink:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('screenlink:update:download'),
  installUpdate: () => ipcRenderer.invoke('screenlink:update:install'),
  chooseDisplaySource: sourceId => ipcRenderer.invoke('screenlink:display-picker:choose', sourceId),
  cancelDisplayPicker: () => ipcRenderer.invoke('screenlink:display-picker:cancel'),
  onDisplayPickerState: callback => {
    if (typeof callback !== 'function') return () => undefined;
    displayPickerSubscribers += 1;
    closeFallbackPicker(true);
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(DISPLAY_PICKER_STATE, listener);
    return () => {
      displayPickerSubscribers = Math.max(0, displayPickerSubscribers - 1);
      ipcRenderer.removeListener(DISPLAY_PICKER_STATE, listener);
    };
  },
  onUpdateState: callback => {
    if (typeof callback !== 'function') return () => undefined;
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('screenlink:update:state', listener);
    return () => ipcRenderer.removeListener('screenlink:update:state', listener);
  }
}));
