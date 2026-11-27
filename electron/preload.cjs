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
      :host { position: fixed; inset: 0; z-index: 2147483647; display: block; color-scheme: dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", sans-serif; -webkit-font-smoothing: antialiased; }
      * { box-sizing: border-box; }
      button { color: inherit; font: inherit; }
      .overlay { position: absolute; inset: 0; padding: 20px; display: grid; place-items: center; background: rgb(0 0 0 / 60%); opacity: 0; transition: opacity 250ms cubic-bezier(0.19, 1, 0.22, 1); }
      .overlay.is-open { opacity: 1; }
      .overlay.is-closing { opacity: 0; pointer-events: none; transition: opacity 150ms cubic-bezier(0.8, 0, 0.4, 1); }
      .dialog { width: min(720px, 100%); max-height: calc(100vh - 40px); border: 1px solid rgb(255 255 255 / 12%); border-radius: 16px; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; overflow: hidden; color: #ffffff; background: #303030; box-shadow: 0 10px 15px -3px rgb(0 0 0 / 32%), 0 4px 6px -4px rgb(0 0 0 / 24%), 0 0 0 1px rgb(255 255 255 / 10%); opacity: 0; transform: scale(.95); transition: opacity 250ms cubic-bezier(0.19, 1, 0.22, 1), transform 250ms cubic-bezier(0.19, 1, 0.22, 1); }
      .dialog.is-open { opacity: 1; transform: scale(1); }
      .dialog.is-closing { opacity: 0; transform: scale(.95); pointer-events: none; transition: opacity 150ms cubic-bezier(0.8, 0, 0.4, 1), transform 150ms cubic-bezier(0.8, 0, 0.4, 1); }
      header { min-height: 72px; padding: 16px 16px 12px; display: grid; grid-template-columns: 40px minmax(0, 1fr) 36px; align-items: center; gap: 12px; }
      .picker-icon { width: 40px; height: 40px; border-radius: 10px; border: 1px solid rgb(255 255 255 / 10%); display: grid; place-items: center; color: #f3f3f3; background: rgb(255 255 255 / 6%); }
      .picker-icon svg { width: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.75; }
      .heading { min-width: 0; }
      h1 { margin: 0 0 2px; font-size: 16px; line-height: 22px; font-weight: 600; letter-spacing: 0; }
      p { margin: 0; color: #afafaf; font-size: 13px; line-height: 18px; }
      .close { width: 36px; height: 36px; padding: 0; border: 0; border-radius: 8px; display: grid; place-items: center; color: #afafaf; background: transparent; cursor: pointer; transition: color 150ms ease, background-color 150ms ease, transform 150ms cubic-bezier(0.19, 1, 0.22, 1); }
      .close:hover { color: #ffffff; background: rgb(255 255 255 / 8%); }
      .close:active { transform: scale(.96); }
      .close:focus-visible, nav button:focus-visible, .source:focus-visible, footer button:focus-visible { outline: 2px solid #0285ff; outline-offset: 2px; }
      .close svg { width: 16px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.75; }
      nav { position: relative; isolation: isolate; width: min(280px, calc(100% - 32px)); margin: 0 16px 12px; padding: 2px; border: 1px solid rgb(255 255 255 / 8%); border-radius: 8px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); background: #181818; }
      nav::before { content: ""; position: absolute; z-index: 0; top: 2px; bottom: 2px; left: 2px; width: calc((100% - 4px) / 2); border-radius: 6px; background: #303030; box-shadow: 0 1px 4px -1px rgb(0 0 0 / 28%); transform: translateX(0); transition: transform 300ms cubic-bezier(0.19, 1, 0.22, 1); }
      nav.is-window::before { transform: translateX(100%); }
      nav button { position: relative; z-index: 1; min-width: 0; min-height: 32px; padding: 0 10px; border: 0; border-radius: 6px; display: flex; align-items: center; justify-content: center; gap: 6px; color: #afafaf; background: transparent; font-size: 13px; font-weight: 500; cursor: pointer; transition: color 150ms ease; }
      nav button span { min-width: 18px; padding: 1px 6px; border-radius: 9999px; color: #afafaf; background: rgb(255 255 255 / 8%); font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; text-align: center; }
      nav button.is-active { color: #ffffff; font-weight: 600; }
      nav button.is-active span { color: #ffffff; background: rgb(255 255 255 / 14%); }
      nav button:disabled { opacity: .4; cursor: not-allowed; }
      .scroll { min-height: 180px; max-height: calc(100vh - 232px); padding: 0 16px 16px; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
      .scroll::-webkit-scrollbar { width: 8px; }
      .scroll::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 9999px; background: rgb(255 255 255 / 18%); background-clip: padding-box; }
      .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .source { min-width: 0; padding: 6px; border: 1px solid rgb(255 255 255 / 10%); border-radius: 10px; color: #ffffff; background: #212121; text-align: left; cursor: pointer; transition: border-color 150ms ease, background-color 150ms ease, transform 150ms cubic-bezier(0.19, 1, 0.22, 1); }
      .source:hover { border-color: rgb(255 255 255 / 24%); background: #282828; }
      .source:active { transform: scale(.98); }
      .source:disabled { cursor: progress; opacity: .6; }
      .thumbnail, .placeholder { width: 100%; aspect-ratio: 16 / 9; border-radius: 6px; display: grid; place-items: center; object-fit: cover; color: #8f8f8f; background: #131313; }
      .placeholder svg { width: 24px; fill: none; stroke: currentColor; stroke-width: 1.6; }
      .label { min-width: 0; padding: 8px 4px 2px; display: flex; align-items: center; gap: 6px; }
      .label img { width: 16px; height: 16px; flex: 0 0 auto; border-radius: 4px; }
      .label span { overflow: hidden; font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
      .empty { min-height: 180px; display: grid; place-items: center; color: #8f8f8f; font-size: 14px; }
      footer { min-height: 56px; padding: 10px 16px; border-top: 1px solid rgb(255 255 255 / 8%); display: flex; align-items: center; justify-content: space-between; gap: 16px; background: #262626; }
      footer > span { display: inline-flex; align-items: center; gap: 8px; color: #afafaf; font-size: 12px; line-height: 18px; }
      footer > span i { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 9999px; background: #04b84c; }
      footer > span b { font-weight: 400; }
      footer button { min-width: 80px; min-height: 36px; padding: 0 14px; border: 1px solid rgb(255 255 255 / 12%); border-radius: 9999px; color: #ffffff; background: rgb(255 255 255 / 8%); font-size: 13px; font-weight: 500; cursor: pointer; transition: background-color 150ms ease, transform 150ms cubic-bezier(0.19, 1, 0.22, 1); }
      footer button:hover { background: rgb(255 255 255 / 14%); }
      footer button:active { transform: scale(.97); }
      @media (max-width: 1040px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      @media (prefers-reduced-motion: reduce) { .overlay, .dialog, .source, nav::before { transition: none !important; } }
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
