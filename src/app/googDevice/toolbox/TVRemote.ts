import KeyEvent from '../android/KeyEvent';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { StreamClientScrcpy } from '../client/StreamClientScrcpy';

/**
 * TVRemote - A realistic floating remote control for Android TV.
 * Creates a draggable overlay panel with all standard TV remote buttons.
 * Each button sends the corresponding Android KeyEvent to the device.
 */
export class TVRemote {
    private readonly holder: HTMLDivElement;
    private visible = false;

    constructor(private readonly client: StreamClientScrcpy) {
        this.holder = this.buildRemote();
        document.body.appendChild(this.holder);
        this.initDrag();
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    public toggle(): void {
        this.visible = !this.visible;
        this.holder.style.display = this.visible ? 'flex' : 'none';
    }

    public show(): void {
        this.visible = true;
        this.holder.style.display = 'flex';
    }

    public hide(): void {
        this.visible = false;
        this.holder.style.display = 'none';
    }

    public isVisible(): boolean {
        return this.visible;
    }

    public destroy(): void {
        if (this.holder.parentElement) {
            this.holder.parentElement.removeChild(this.holder);
        }
    }

    // ─── Key sending ─────────────────────────────────────────────────────────

    private bindKey(el: HTMLElement, keycode: number): void {
        el.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            el.classList.add('pressed');
            this.client.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_DOWN, keycode, 0, 0));
        });
        el.addEventListener('pointerup', (e) => {
            e.preventDefault();
            el.classList.remove('pressed');
            this.client.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_UP, keycode, 0, 0));
        });
        el.addEventListener('pointerleave', () => {
            if (el.classList.contains('pressed')) {
                el.classList.remove('pressed');
                this.client.sendMessage(new KeyCodeControlMessage(KeyEvent.ACTION_UP, keycode, 0, 0));
            }
        });
    }

    // ─── DOM builder ─────────────────────────────────────────────────────────

    private buildRemote(): HTMLDivElement {
        const remote = document.createElement('div');
        remote.className = 'tv-remote';
        remote.style.display = 'none';

        // Header / drag handle
        const header = document.createElement('div');
        header.className = 'tv-remote-header';
        header.innerHTML = `
            <div class="tv-remote-drag-handle">
                <span class="tv-remote-title">Remote</span>
            </div>
            <button class="tv-remote-close" title="Close remote">✕</button>
        `;
        header.querySelector('.tv-remote-close')!.addEventListener('click', () => this.hide());
        remote.appendChild(header);

        // Body
        const body = document.createElement('div');
        body.className = 'tv-remote-body';

        // ── Row 1: Power  |  Mute  |  Settings ──────────────────────────────
        const row1 = this.row();
        row1.appendChild(this.btn('⏻', 'Power', KeyEvent.KEYCODE_POWER, 'tv-btn-power'));
        row1.appendChild(this.btn('🔇', 'Mute', KeyEvent.KEYCODE_MUTE, 'tv-btn-icon'));
        row1.appendChild(this.btn('⚙', 'Settings', KeyEvent.KEYCODE_SETTINGS, 'tv-btn-icon'));
        body.appendChild(row1);

        // ── Divider ──────────────────────────────────────────────────────────
        body.appendChild(this.divider());

        // ── D-Pad ────────────────────────────────────────────────────────────
        const dpad = document.createElement('div');
        dpad.className = 'tv-remote-dpad';

        // Up
        const dpadUp = this.dpadBtn('▲', 'Up', KeyEvent.KEYCODE_DPAD_UP);
        dpadUp.classList.add('tv-dpad-up');
        dpad.appendChild(dpadUp);

        // Left
        const dpadLeft = this.dpadBtn('◀', 'Left', KeyEvent.KEYCODE_DPAD_LEFT);
        dpadLeft.classList.add('tv-dpad-left');
        dpad.appendChild(dpadLeft);

        // Center / OK
        const dpadOk = this.dpadBtn('OK', 'Select', KeyEvent.KEYCODE_DPAD_CENTER);
        dpadOk.classList.add('tv-dpad-ok');
        dpad.appendChild(dpadOk);

        // Right
        const dpadRight = this.dpadBtn('▶', 'Right', KeyEvent.KEYCODE_DPAD_RIGHT);
        dpadRight.classList.add('tv-dpad-right');
        dpad.appendChild(dpadRight);

        // Down
        const dpadDown = this.dpadBtn('▼', 'Down', KeyEvent.KEYCODE_DPAD_DOWN);
        dpadDown.classList.add('tv-dpad-down');
        dpad.appendChild(dpadDown);

        body.appendChild(dpad);

        // ── Row: Back  |  Home  |  Menu ──────────────────────────────────────
        body.appendChild(this.divider());
        const row2 = this.row();
        row2.appendChild(this.btn('⬅', 'Back', KeyEvent.KEYCODE_BACK, 'tv-btn-sys'));
        row2.appendChild(this.btn('⌂', 'Home', KeyEvent.KEYCODE_HOME, 'tv-btn-sys'));
        row2.appendChild(this.btn('☰', 'Menu', KeyEvent.KEYCODE_MENU, 'tv-btn-sys'));
        body.appendChild(row2);

        // ── Divider ──────────────────────────────────────────────────────────
        body.appendChild(this.divider());

        // ── Volume & Channel ─────────────────────────────────────────────────
        const vcRow = this.row();

        const volCol = document.createElement('div');
        volCol.className = 'tv-remote-col';
        const volLabel = document.createElement('div');
        volLabel.className = 'tv-col-label';
        volLabel.textContent = 'VOL';
        const volUp = this.btn('＋', 'Volume Up', KeyEvent.KEYCODE_VOLUME_UP, 'tv-btn-rocker tv-btn-rocker-top');
        const volDown = this.btn('－', 'Volume Down', KeyEvent.KEYCODE_VOLUME_DOWN, 'tv-btn-rocker tv-btn-rocker-bot');
        volCol.appendChild(volLabel);
        volCol.appendChild(volUp);
        volCol.appendChild(volDown);

        const chCol = document.createElement('div');
        chCol.className = 'tv-remote-col';
        const chLabel = document.createElement('div');
        chLabel.className = 'tv-col-label';
        chLabel.textContent = 'CH';
        const chUp = this.btn('▲', 'Channel Up', KeyEvent.KEYCODE_CHANNEL_UP, 'tv-btn-rocker tv-btn-rocker-top');
        const chDown = this.btn('▼', 'Channel Down', KeyEvent.KEYCODE_CHANNEL_DOWN, 'tv-btn-rocker tv-btn-rocker-bot');
        chCol.appendChild(chLabel);
        chCol.appendChild(chUp);
        chCol.appendChild(chDown);

        vcRow.appendChild(volCol);
        vcRow.appendChild(chCol);
        body.appendChild(vcRow);

        // ── Divider ──────────────────────────────────────────────────────────
        body.appendChild(this.divider());

        // ── Media controls ───────────────────────────────────────────────────
        const mediaRow = this.row();
        mediaRow.appendChild(this.btn('⏮', 'Previous', KeyEvent.KEYCODE_MEDIA_PREVIOUS, 'tv-btn-media'));
        mediaRow.appendChild(this.btn('⏪', 'Rewind', KeyEvent.KEYCODE_MEDIA_REWIND, 'tv-btn-media'));
        mediaRow.appendChild(this.btn('⏯', 'Play/Pause', KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, 'tv-btn-media tv-btn-media-play'));
        mediaRow.appendChild(this.btn('⏩', 'Fast Forward', KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, 'tv-btn-media'));
        mediaRow.appendChild(this.btn('⏭', 'Next', KeyEvent.KEYCODE_MEDIA_NEXT, 'tv-btn-media'));
        body.appendChild(mediaRow);

        // ── Divider ──────────────────────────────────────────────────────────
        body.appendChild(this.divider());

        // ── Number pad ───────────────────────────────────────────────────────
        const numpad = document.createElement('div');
        numpad.className = 'tv-remote-numpad';

        const numCodes: Record<string, number> = {
            '1': KeyEvent.KEYCODE_1,
            '2': KeyEvent.KEYCODE_2,
            '3': KeyEvent.KEYCODE_3,
            '4': KeyEvent.KEYCODE_4,
            '5': KeyEvent.KEYCODE_5,
            '6': KeyEvent.KEYCODE_6,
            '7': KeyEvent.KEYCODE_7,
            '8': KeyEvent.KEYCODE_8,
            '9': KeyEvent.KEYCODE_9,
            '🔍': KeyEvent.KEYCODE_SEARCH,
            '0': KeyEvent.KEYCODE_0,
            '⌫': KeyEvent.KEYCODE_DEL,
        };

        for (const [label, code] of Object.entries(numCodes)) {
            const btn = this.btn(label, label, code, 'tv-btn-num');
            numpad.appendChild(btn);
        }
        body.appendChild(numpad);

        remote.appendChild(body);
        return remote;
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private row(): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'tv-remote-row';
        return row;
    }

    private divider(): HTMLDivElement {
        const d = document.createElement('div');
        d.className = 'tv-remote-divider';
        return d;
    }

    private btn(label: string, title: string, keycode: number, extraClass = ''): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = `tv-btn${extraClass ? ' ' + extraClass : ''}`;
        btn.title = title;
        btn.textContent = label;
        this.bindKey(btn, keycode);
        return btn;
    }

    private dpadBtn(label: string, title: string, keycode: number): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.className = 'tv-btn tv-dpad-btn';
        btn.title = title;
        btn.textContent = label;
        this.bindKey(btn, keycode);
        return btn;
    }

    // ─── Drag ────────────────────────────────────────────────────────────────

    private initDrag(): void {
        const el = this.holder;
        const handle = el.querySelector('.tv-remote-drag-handle') as HTMLElement;
        if (!handle) return;

        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;
        let dragging = false;

        // Default position: right side of screen, vertically centered
        el.style.position = 'fixed';
        el.style.right = '16px';
        el.style.top = '50%';
        el.style.transform = 'translateY(-50%)';

        const onMove = (e: PointerEvent) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            el.style.transform = '';
            el.style.left = `${startLeft + dx}px`;
            el.style.top = `${startTop + dy}px`;
            el.style.right = 'auto';
        };

        const onUp = () => {
            dragging = false;
            el.classList.remove('tv-remote-dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };

        handle.addEventListener('pointerdown', (e: PointerEvent) => {
            // Don't drag if target is the close button
            if ((e.target as HTMLElement).classList.contains('tv-remote-close')) return;
            dragging = true;
            el.classList.add('tv-remote-dragging');

            const rect = el.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            startX = e.clientX;
            startY = e.clientY;

            // Switch from right-anchored to left-anchored so offset math works
            el.style.transform = '';
            el.style.left = `${rect.left}px`;
            el.style.top = `${rect.top}px`;
            el.style.right = 'auto';

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });
    }
}
