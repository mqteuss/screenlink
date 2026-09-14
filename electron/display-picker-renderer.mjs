const bridge = window.screenLinkDisplayPicker;
const grid = document.querySelector('#source-grid');
const emptyState = document.querySelector('#empty-state');
const screenCount = document.querySelector('#screen-count');
const windowCount = document.querySelector('#window-count');
const filterButtons = [...document.querySelectorAll('[data-filter]')];
let activeFilter = 'screen';
let sources = [];

function render() {
  grid.replaceChildren();
  const visibleSources = sources.filter(source => source.kind === activeFilter);
  emptyState.hidden = visibleSources.length > 0;

  for (const source of visibleSources) {
    const button = document.createElement('button');
    button.className = 'source-card';
    button.type = 'button';
    button.title = source.name;

    const thumbnail = document.createElement('img');
    thumbnail.className = 'source-thumbnail';
    thumbnail.src = source.thumbnail;
    thumbnail.alt = '';
    thumbnail.draggable = false;

    const label = document.createElement('span');
    label.className = 'source-label';
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

    button.append(thumbnail, label);
    button.addEventListener('click', () => bridge.choose(source.id));
    grid.append(button);
  }
}

for (const button of filterButtons) {
  button.addEventListener('click', () => {
    activeFilter = button.dataset.filter;
    for (const candidate of filterButtons) candidate.classList.toggle('is-active', candidate === button);
    render();
  });
}

document.querySelector('#close-picker').addEventListener('click', () => bridge.cancel());
document.querySelector('#cancel-picker').addEventListener('click', () => bridge.cancel());
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') void bridge.cancel();
});

try {
  if (!bridge || typeof bridge.list !== 'function') {
    throw new Error('A ponte segura do seletor de tela não foi carregada.');
  }
  sources = await bridge.list();
  screenCount.textContent = String(sources.filter(source => source.kind === 'screen').length);
  windowCount.textContent = String(sources.filter(source => source.kind === 'window').length);
  if (!sources.some(source => source.kind === activeFilter)) {
    activeFilter = 'window';
    for (const button of filterButtons) button.classList.toggle('is-active', button.dataset.filter === activeFilter);
  }
  render();
} catch (error) {
  console.error(error);
  emptyState.textContent = 'Não foi possível listar as telas e janelas. Feche esta janela e tente novamente.';
  emptyState.hidden = false;
}
