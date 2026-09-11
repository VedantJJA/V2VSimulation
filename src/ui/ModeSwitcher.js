const STYLES_ID = 'mode-switcher-styles';
const STYLES = `
  .mode-switcher { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center;
    justify-content: center; background: rgba(9, 11, 15, 0.78); backdrop-filter: blur(5px);
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; color: #dfe4ea; }
  .ms-card { width: 340px; padding: 28px; background: rgba(16, 19, 24, 0.95);
    border: 1px solid #2b313a; border-radius: 12px; text-align: center; }
  .ms-card h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: 0.04em; }
  .ms-card .ms-sub { margin: 0 0 20px; font-size: 12px; color: #8b96a5; }
  .ms-btn { display: block; width: 100%; margin: 8px 0; padding: 12px; font: inherit;
    font-size: 14px; color: #dfe4ea; background: #1c2027; border: 1px solid #2b313a;
    border-radius: 8px; cursor: pointer; }
  .ms-btn:hover { background: #262c35; }
  .ms-btn--run { background: #1f5c40; border-color: #2f8a5c; color: #fff; }
  .ms-btn--run:hover { background: #256e4d; }
  .ms-or { margin: 14px 0 6px; font-size: 11px; color: #5d6875; }
  .ms-file { display: block; font-size: 12px; color: #9fb0c0; cursor: pointer;
    border: 1px dashed #2b313a; border-radius: 8px; padding: 10px; }
  .ms-file:hover { border-color: #4a90c9; color: #dfe4ea; }
  .ms-file input { display: none; }
  .ms-note { margin: 14px 0 0; font-size: 11px; color: #5d6875; }
`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * ModeSwitcher — the start screen. A DOM overlay with "Edit Map" (blank
 * editor) and "Run Simulation" (default sample map), plus a file input to
 * boot the simulation directly from a saved map JSON. `choose()` resolves
 * once with the selection and removes itself.
 */
export class ModeSwitcher {
  constructor({ title = 'Road Network Sandbox', subtitle = 'Choose a mode to start' } = {}) {
    if (!document.getElementById(STYLES_ID)) {
      const style = el('style');
      style.id = STYLES_ID;
      style.textContent = STYLES;
      document.head.appendChild(style);
    }

    this._root = el('div', 'mode-switcher');
    const card = el('div', 'ms-card');
    card.append(el('h1', null, title), el('p', 'ms-sub', subtitle));

    const editButton = el('button', 'ms-btn', 'Edit Map');
    const runButton = el('button', 'ms-btn ms-btn--run', 'Run Simulation');
    card.append(editButton, runButton);

    card.append(el('div', 'ms-or', '— or —'));
    const fileLabel = el('label', 'ms-file', 'Run a saved map file…');
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileLabel.appendChild(fileInput);
    card.append(fileLabel, el('p', 'ms-note', 'Edit Map starts a blank world with drawing tools.'));

    this._root.appendChild(card);
    document.body.appendChild(this._root);

    this._promise = null;
    this._resolve = null;

    editButton.addEventListener('click', () => this._finish({ mode: 'edit' }));
    runButton.addEventListener('click', () => this._finish({ mode: 'simulate' }));
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      try {
        this._finish({ mode: 'simulate', data: JSON.parse(await file.text()) });
      } catch (error) {
        console.error('[ModeSwitcher] invalid map file:', error);
      }
    });
  }

  /**
   * @returns {Promise<{ mode: 'edit' } | { mode: 'simulate', data?: object }>}
   */
  choose() {
    if (this._promise) return this._promise;
    this._promise = new Promise((resolve) => {
      this._resolve = resolve;
    });
    return this._promise;
  }

  _finish(result) {
    this._root?.remove();
    this._root = null;
    if (this._resolve) this._resolve(result);
  }

  dispose() {
    this._root?.remove();
    this._root = null;
    this._resolve = null;
  }
}