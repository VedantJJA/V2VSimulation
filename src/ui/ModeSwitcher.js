const STYLES_ID = 'mode-switcher-styles';
const STYLES = `
  .mode-switcher { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center;
    justify-content: center; background: rgba(9, 11, 15, 0.85); backdrop-filter: blur(8px);
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; color: #dfe4ea; }
  .ms-card { width: 380px; max-width: 90vw; padding: 26px; background: rgba(16, 20, 28, 0.96);
    border: 1px solid #2b3544; border-radius: 14px; text-align: center; box-shadow: 0 16px 36px rgba(0,0,0,0.5); }
  .ms-card h1 { margin: 0 0 4px; font-size: 20px; font-weight: 700; letter-spacing: 0.04em; color: #fff; }
  .ms-card .ms-sub { margin: 0 0 18px; font-size: 12px; color: #8b96a5; }
  .ms-btn-group { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
  .ms-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%;
    box-sizing: border-box; padding: 11px 14px; font: inherit; font-size: 13px; font-weight: 600;
    color: #dfe4ea; background: #1c222c; border: 1px solid #2b3544; border-radius: 8px; cursor: pointer;
    transition: all 0.15s ease; }
  .ms-btn:hover { background: #262e3c; border-color: #3f4c60; color: #fff; transform: translateY(-1px); }
  .ms-btn--run { background: #1a5336; border-color: #27794f; color: #fff; }
  .ms-btn--run:hover { background: #216843; border-color: #349864; }
  .ms-btn--host { background: #1e3a8a; border-color: #2563eb; color: #bfdbfe; }
  .ms-btn--host:hover { background: #1d4ed8; border-color: #3b82f6; color: #fff; }
  .ms-btn--join { background: #4c1d95; border-color: #7c3aed; color: #ddd6fe; }
  .ms-btn--join:hover { background: #5b21b6; border-color: #8b5cf6; color: #fff; }
  .ms-or { margin: 12px 0 6px; font-size: 11px; color: #5d6875; }
  .ms-file { display: block; font-size: 11px; color: #9fb0c0; cursor: pointer;
    border: 1px dashed #2b3544; border-radius: 8px; padding: 8px; transition: border-color 0.15s; }
  .ms-file:hover { border-color: #4a90c9; color: #dfe4ea; }
  .ms-file input { display: none; }
  .ms-note { margin: 10px 0 0; font-size: 11px; color: #5d6875; }

  /* Modal Form (Host / Join) */
  .ms-modal { text-align: left; }
  .ms-modal h2 { margin: 0 0 6px; font-size: 17px; color: #fff; display: flex; align-items: center; gap: 8px; }
  .ms-modal p { margin: 0 0 14px; font-size: 11px; color: #8b96a5; line-height: 1.4; }
  .ms-guide-box { background: #131720; border: 1px solid #232c3a; border-radius: 6px; padding: 10px;
    margin-bottom: 14px; font-size: 11px; color: #94a3b8; line-height: 1.5; }
  .ms-guide-box code { background: #1f2735; color: #4ac9ff; padding: 2px 5px; border-radius: 4px; }
  .ms-field { margin-bottom: 12px; }
  .ms-field label { display: block; font-size: 11px; font-weight: 600; color: #9fb0c0; margin-bottom: 4px; }
  .ms-field input[type="text"] { width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit;
    font-size: 12px; color: #fff; background: #0f131a; border: 1px solid #2b3544; border-radius: 6px; outline: none; }
  .ms-field input[type="text"]:focus { border-color: #4a90c9; }
  .ms-colors { display: flex; gap: 8px; margin-top: 4px; }
  .ms-color-dot { width: 26px; height: 26px; border-radius: 50%; cursor: pointer; border: 2px solid transparent;
    transition: transform 0.15s, border-color 0.15s; }
  .ms-color-dot:hover { transform: scale(1.15); }
  .ms-color-dot.active { border-color: #fff; transform: scale(1.18); box-shadow: 0 0 8px rgba(255,255,255,0.5); }
  .ms-modal-actions { display: flex; gap: 8px; margin-top: 18px; }
  .ms-modal-actions .ms-btn { flex: 1; margin: 0; }
`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const CAR_COLORS = [
  { name: 'Red', hex: 0xc23b2e, css: '#c23b2e' },
  { name: 'Blue', hex: 0x2563eb, css: '#2563eb' },
  { name: 'Cyan', hex: 0x06b6d4, css: '#06b6d4' },
  { name: 'Green', hex: 0x10b981, css: '#10b981' },
  { name: 'Gold', hex: 0xf59e0b, css: '#f59e0b' },
  { name: 'Purple', hex: 0x8b5cf6, css: '#8b5cf6' },
  { name: 'Dark', hex: 0x1e293b, css: '#1e293b' },
];

/**
 * ModeSwitcher — Start screen overlay with options for:
 * 1. Single Player Simulation (Silverstone)
 * 2. Create / Host Server
 * 3. Join Server
 * 4. Edit Map
 * 5. Run saved map JSON
 */
export class ModeSwitcher {
  constructor({ title = 'Silverstone F1 Simulation', subtitle = 'British Grand Prix Circuit (5.89 km)' } = {}) {
    if (!document.getElementById(STYLES_ID)) {
      const style = el('style');
      style.id = STYLES_ID;
      style.textContent = STYLES;
      document.head.appendChild(style);
    }

    this._root = el('div', 'mode-switcher');
    this._card = el('div', 'ms-card');
    this._root.appendChild(this._card);
    document.body.appendChild(this._root);

    this.title = title;
    this.subtitle = subtitle;
    this._promise = null;
    this._resolve = null;

    this._renderMainMenu();
  }

  _renderMainMenu() {
    this._card.replaceChildren();

    this._card.append(
      el('h1', null, this.title),
      el('p', 'ms-sub', this.subtitle)
    );

    const btnGroup = el('div', 'ms-btn-group');

    // 1. Single Player
    const singleBtn = el('button', 'ms-btn ms-btn--run', '🏎️ Single Player Simulation');
    singleBtn.addEventListener('click', () => this._finish({ mode: 'simulate' }));

    // 2. Create / Host Server
    const hostBtn = el('button', 'ms-btn ms-btn--host', '🌐 Create / Host Server');
    hostBtn.addEventListener('click', () => this._renderHostModal());

    // 3. Join Server
    const joinBtn = el('button', 'ms-btn ms-btn--join', '🔗 Join Multiplayer Server');
    joinBtn.addEventListener('click', () => this._renderJoinModal());

    // 4. Edit Map
    const editBtn = el('button', 'ms-btn', '🛠️ Edit Map');
    editBtn.addEventListener('click', () => this._finish({ mode: 'edit' }));

    btnGroup.append(singleBtn, hostBtn, joinBtn, editBtn);
    this._card.appendChild(btnGroup);

    // File input fallback
    this._card.append(el('div', 'ms-or', '— or —'));
    const fileLabel = el('label', 'ms-file', '📂 Run a saved map file…');
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileLabel.appendChild(fileInput);
    this._card.append(fileLabel, el('p', 'ms-note', 'Controller (Gamepad) & Keyboard supported.'));

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

  _renderHostModal() {
    this._card.replaceChildren();
    const modal = el('div', 'ms-modal');

    modal.innerHTML = `
      <h2>🌐 Host Multiplayer Server</h2>
      <p>Host a real-time multiplayer race on Silverstone circuit.</p>
      <div class="ms-guide-box">
        <strong>💡 How to Host:</strong><br>
        1. Open a terminal in project folder and run:<br>
        <code>npm run server</code><br>
        2. Keep terminal open and launch below.<br>
        3. Friends on same Wi-Fi connect via your LAN IP.
      </div>
    `;

    // Server Address
    const addrField = el('div', 'ms-field');
    addrField.innerHTML = `
      <label>WebSocket Server URL</label>
      <input type="text" id="ms-host-url" value="ws://localhost:8080" />
    `;
    modal.appendChild(addrField);

    // Driver Name
    const nameField = el('div', 'ms-field');
    nameField.innerHTML = `
      <label>Your Driver Name</label>
      <input type="text" id="ms-host-name" value="Host Driver" maxlength="20" />
    `;
    modal.appendChild(nameField);

    // Color picker
    let selectedColor = CAR_COLORS[0].hex;
    const colorField = el('div', 'ms-field');
    colorField.innerHTML = `<label>Car Paint Color</label>`;
    const colorsDiv = el('div', 'ms-colors');
    CAR_COLORS.forEach((c, idx) => {
      const dot = el('div', `ms-color-dot ${idx === 0 ? 'active' : ''}`);
      dot.style.background = c.css;
      dot.title = c.name;
      dot.addEventListener('click', () => {
        colorsDiv.querySelectorAll('.ms-color-dot').forEach((d) => d.classList.remove('active'));
        dot.classList.add('active');
        selectedColor = c.hex;
      });
      colorsDiv.appendChild(dot);
    });
    colorField.appendChild(colorsDiv);
    modal.appendChild(colorField);

    // Actions
    const actions = el('div', 'ms-modal-actions');
    const backBtn = el('button', 'ms-btn', '← Back');
    backBtn.addEventListener('click', () => this._renderMainMenu());

    const launchBtn = el('button', 'ms-btn ms-btn--host', '🚀 Launch as Host');
    launchBtn.addEventListener('click', () => {
      const serverUrl = modal.querySelector('#ms-host-url')?.value?.trim() || 'ws://localhost:8080';
      const playerName = modal.querySelector('#ms-host-name')?.value?.trim() || 'Host Driver';
      this._finish({
        mode: 'simulate',
        multiplayer: {
          enabled: true,
          isHost: true,
          serverUrl,
          playerName,
          vehicleColor: selectedColor,
        },
      });
    });

    actions.append(backBtn, launchBtn);
    modal.appendChild(actions);
    this._card.appendChild(modal);
  }

  _renderJoinModal() {
    this._card.replaceChildren();
    const modal = el('div', 'ms-modal');

    modal.innerHTML = `
      <h2>🔗 Join Multiplayer Server</h2>
      <p>Connect to an existing host server across LAN or local machine.</p>
    `;

    // Server Address
    const addrField = el('div', 'ms-field');
    addrField.innerHTML = `
      <label>Host Server Address (ws://...)</label>
      <input type="text" id="ms-join-url" value="ws://localhost:8080" placeholder="e.g. ws://192.168.1.50:8080" />
    `;
    modal.appendChild(addrField);

    // Driver Name
    const nameField = el('div', 'ms-field');
    nameField.innerHTML = `
      <label>Your Driver Name</label>
      <input type="text" id="ms-join-name" value="Racer 2" maxlength="20" />
    `;
    modal.appendChild(nameField);

    // Color picker
    let selectedColor = CAR_COLORS[1].hex; // Default blue for joiner
    const colorField = el('div', 'ms-field');
    colorField.innerHTML = `<label>Car Paint Color</label>`;
    const colorsDiv = el('div', 'ms-colors');
    CAR_COLORS.forEach((c, idx) => {
      const dot = el('div', `ms-color-dot ${idx === 1 ? 'active' : ''}`);
      dot.style.background = c.css;
      dot.title = c.name;
      dot.addEventListener('click', () => {
        colorsDiv.querySelectorAll('.ms-color-dot').forEach((d) => d.classList.remove('active'));
        dot.classList.add('active');
        selectedColor = c.hex;
      });
      colorsDiv.appendChild(dot);
    });
    colorField.appendChild(colorsDiv);
    modal.appendChild(colorField);

    // Actions
    const actions = el('div', 'ms-modal-actions');
    const backBtn = el('button', 'ms-btn', '← Back');
    backBtn.addEventListener('click', () => this._renderMainMenu());

    const joinBtn = el('button', 'ms-btn ms-btn--join', '🏎️ Connect & Join');
    joinBtn.addEventListener('click', () => {
      const serverUrl = modal.querySelector('#ms-join-url')?.value?.trim() || 'ws://localhost:8080';
      const playerName = modal.querySelector('#ms-join-name')?.value?.trim() || 'Racer 2';
      this._finish({
        mode: 'simulate',
        multiplayer: {
          enabled: true,
          isHost: false,
          serverUrl,
          playerName,
          vehicleColor: selectedColor,
        },
      });
    });

    actions.append(backBtn, joinBtn);
    modal.appendChild(actions);
    this._card.appendChild(modal);
  }

  /**
   * @returns {Promise<{ mode: 'edit' } | { mode: 'simulate', data?: object, multiplayer?: object }>}
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