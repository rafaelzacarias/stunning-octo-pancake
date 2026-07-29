/**
 * Keyboard shortcuts for the shredder HUD.
 *
 * Delegates to the {@link import('./UI.js').UI} instance so that every hotkey
 * drives the *same* state as the on-screen control (buttons stay in sync, no
 * divergent code paths). Key events originating inside form fields are ignored
 * so typing in a slider/number field never fires a shortcut.
 */

/** True when the event target is an editable form control. */
function isFormField(el) {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

export class Hotkeys {
  /**
   * @param {object} opts
   * @param {import('./UI.js').UI} opts.ui
   */
  constructor({ ui }) {
    this.ui = ui;
    this._reverseHeld = false;
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
  }

  /** Start listening. */
  attach() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  /** Stop listening. */
  detach() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }

  /** @private */
  _onKeyDown(e) {
    if (e.repeat && e.code !== 'Equal' && e.code !== 'Minus') return;
    if (isFormField(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const ui = this.ui;
    switch (e.code) {
      case 'Space': ui.togglePower(); break;
      case 'KeyR':
        if (!this._reverseHeld) { this._reverseHeld = true; ui.setReverseHeld(true); }
        break;
      case 'Digit1': ui.cameraPresetByIndex(0); break;
      case 'Digit2': ui.cameraPresetByIndex(1); break;
      case 'Digit3': ui.cameraPresetByIndex(2); break;
      case 'Digit4': ui.cameraPresetByIndex(3); break;
      case 'Digit5': ui.cameraPresetByIndex(4); break;
      case 'KeyF': ui.spawnSelected(); break;
      case 'KeyA': ui.toggleAutoFeed(); break;
      case 'KeyC': ui.clearAll(); break;
      case 'KeyH': ui.toggleHud(); break;
      case 'KeyM': ui.toggleMute(); break;
      case 'KeyK': ui.toggleCinematic(); break;
      case 'Equal':
      case 'NumpadAdd': ui.nudgeThrottle(0.1); break;
      case 'Minus':
      case 'NumpadSubtract': ui.nudgeThrottle(-0.1); break;
      default: return;
    }
    e.preventDefault();
  }

  /** @private */
  _onKeyUp(e) {
    if (e.code === 'KeyR' && this._reverseHeld) {
      this._reverseHeld = false;
      this.ui.setReverseHeld(false);
    }
  }
}
