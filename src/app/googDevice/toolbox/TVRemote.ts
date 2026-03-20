import KeyEvent from '../android/KeyEvent';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { StreamClientScrcpy } from '../client/StreamClientScrcpy';

/**
 * TVRemote — Floating draggable panel, compact 2-row grid layout per section.
 * All groups sit in a single horizontal line; each group uses a 2×3 grid
 * so height equals ~2 buttons while width is only 3 buttons wide.
 * Numpad (3×4) sits at the far right.
 */
export class TVRemote {
    private readonly holder: HTMLDivElement;
    private visible = false;

    constructor(private readonly client: StreamClientScrcpy) {
        this.holder = this.buildPanel();
        document.body.appendChild(this.holder);
        this.initDrag();
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    public toggle(): void {
        this.visible = !this.visible;
        this.holder.style.display = this.visible ? 'flex' : 'none';
    }

    public isVisible(): boolean {
        return this.visible;
    }

    // ─── Drag ────────────────────────────────────────────────────────────────

    private initDrag(): void {
        const handle = this.holder.querySelector('.tv-remote-titlebar') as HTMLElement;
        if (!handle) return;
        let startX = 0, startY = 0, origLeft = 0, origTop = 0, dragging = false;

        handle.addEventListener('pointerdown', (e) => {
            if ((e.target as HTMLElement).tagName === 'BUTTON') return;
            e.preventDefault();
            dragging = true;
            handle.setPointerCapture(e.pointerId);
            const rect = this.holder.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY;
            origLeft = rect.left; origTop = rect.top;
            this.holder.style.transform = 'none';
            this.holder.style.left = `${origLeft}px`;
            this.holder.style.top = `${origTop}px`;
            this.holder.classList.add('tv-remote-dragging');
        });
        handle.addEventListener('pointermove', (e) => {
            if (!dragging || !handle.hasPointerCapture(e.pointerId)) return;
            this.holder.style.left = `${origLeft + e.clientX - startX}px`;
            this.holder.style.top  = `${origTop  + e.clientY - startY}px`;
        });
        handle.addEventListener('pointerup', () => {
            dragging = false;
            this.holder.classList.remove('tv-remote-dragging');
        });
    }

    // ─── Key binding ─────────────────────────────────────────────────────────

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

    private buildPanel(): HTMLDivElement {
        const panel = document.createElement('div');
        panel.className = 'tv-remote-panel';
        panel.style.display = 'none';

        // Title bar / drag handle
        const titlebar = document.createElement('div');
        titlebar.className = 'tv-remote-titlebar';
        const grip1 = document.createElement('div'); grip1.className = 'tv-remote-grip';
        const title = document.createElement('span'); title.className = 'tv-remote-title'; title.textContent = 'TV Remote';
        const grip2 = document.createElement('div'); grip2.className = 'tv-remote-grip';
        titlebar.appendChild(grip1); titlebar.appendChild(title); titlebar.appendChild(grip2);
        panel.appendChild(titlebar);

        // Single content row — all groups side by side
        const row = document.createElement('div');
        row.className = 'tv-remote-row';

        // ── Group 1: System  (2×3 grid: top row Power/Mute/Settings, bottom row Back/Home/Menu) ──
        row.appendChild(this.grid2x3([
            this.btn('⏻', 'Power',    KeyEvent.KEYCODE_POWER,    'tv-btn-power'),
            this.btn('🔇', 'Mute',     KeyEvent.KEYCODE_MUTE),
            this.btn('⚙',  'Settings', KeyEvent.KEYCODE_SETTINGS),
            this.btn('⬅', 'Back',     KeyEvent.KEYCODE_BACK,     'tv-btn-sys'),
            this.btn('⌂', 'Home',     KeyEvent.KEYCODE_HOME,     'tv-btn-sys'),
            this.btn('☰', 'Menu',     KeyEvent.KEYCODE_MENU,     'tv-btn-sys'),
        ]));

        row.appendChild(this.sep());

        // ── Group 2: D-Pad (3×3 grid — unchanged) ────────────────────────────
        const dpad = document.createElement('div');
        dpad.className = 'tv-bar-dpad';
        const up    = this.btn('▲', 'Up',     KeyEvent.KEYCODE_DPAD_UP);
        const left  = this.btn('◀', 'Left',   KeyEvent.KEYCODE_DPAD_LEFT);
        const ok    = this.btn('OK','Select',  KeyEvent.KEYCODE_DPAD_CENTER, 'tv-bar-ok');
        const right = this.btn('▶', 'Right',  KeyEvent.KEYCODE_DPAD_RIGHT);
        const down  = this.btn('▼', 'Down',   KeyEvent.KEYCODE_DPAD_DOWN);
        up.classList.add('tv-bar-dpad-up');
        left.classList.add('tv-bar-dpad-left');
        ok.classList.add('tv-bar-dpad-ok');
        right.classList.add('tv-bar-dpad-right');
        down.classList.add('tv-bar-dpad-down');
        dpad.appendChild(up); dpad.appendChild(left); dpad.appendChild(ok);
        dpad.appendChild(right); dpad.appendChild(down);
        row.appendChild(dpad);

        row.appendChild(this.sep());

        // ── Group 3: Vol+CH (2×2: VOL+/CH+ top, VOL−/CH− bottom, labelled) ──
        row.appendChild(this.volChGroup());

        row.appendChild(this.sep());

        // ── Group 4: Media (2×3 grid: ⏮⏪⏯ top, ⏩⏭_ bottom) ────────────────
        row.appendChild(this.grid2x3([
            this.btn('⏮', 'Previous',   KeyEvent.KEYCODE_MEDIA_PREVIOUS,    'tv-btn-media'),
            this.btn('⏪', 'Rewind',     KeyEvent.KEYCODE_MEDIA_REWIND,      'tv-btn-media'),
            this.btn('⏯', 'Play/Pause', KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,  'tv-btn-media tv-btn-media-play'),
            this.btn('⏩', 'Fast Fwd',  KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,'tv-btn-media'),
            this.btn('⏭', 'Next',       KeyEvent.KEYCODE_MEDIA_NEXT,        'tv-btn-media'),
            this.placeholder(),
        ]));

        row.appendChild(this.sep());

        // ── Group 5: Numpad (3×4) ─────────────────────────────────────────────
        const numpad = document.createElement('div');
        numpad.className = 'tv-bar-numpad';
        const nums: [string, number][] = [
            ['1', KeyEvent.KEYCODE_1], ['2', KeyEvent.KEYCODE_2], ['3', KeyEvent.KEYCODE_3],
            ['4', KeyEvent.KEYCODE_4], ['5', KeyEvent.KEYCODE_5], ['6', KeyEvent.KEYCODE_6],
            ['7', KeyEvent.KEYCODE_7], ['8', KeyEvent.KEYCODE_8], ['9', KeyEvent.KEYCODE_9],
            ['🔍', KeyEvent.KEYCODE_SEARCH], ['0', KeyEvent.KEYCODE_0], ['⌫', KeyEvent.KEYCODE_DEL],
        ];
        for (const [label, code] of nums) {
            numpad.appendChild(this.btn(label, label, code, 'tv-btn-num'));
        }
        row.appendChild(numpad);

        panel.appendChild(row);
        return panel;
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /** 2-row × 3-col grid. Pass exactly 6 elements (use placeholder() for empty cell). */
    private grid2x3(cells: HTMLElement[]): HTMLDivElement {
        const g = document.createElement('div');
        g.className = 'tv-grid-2x3';
        cells.forEach((c) => g.appendChild(c));
        return g;
    }

    /** Vol + CH as a labelled 2×2 block */
    private volChGroup(): HTMLDivElement {
        const wrap = document.createElement('div');
        wrap.className = 'tv-volch-group';

        // Header labels row
        const labels = document.createElement('div');
        labels.className = 'tv-volch-labels';
        const vLbl = document.createElement('span'); vLbl.className = 'tv-volch-label'; vLbl.textContent = 'VOL';
        const cLbl = document.createElement('span'); cLbl.className = 'tv-volch-label'; cLbl.textContent = 'CH';
        labels.appendChild(vLbl); labels.appendChild(cLbl);

        // Buttons grid: VOL+ | CH+  /  VOL− | CH−
        const grid = document.createElement('div');
        grid.className = 'tv-volch-grid';
        grid.appendChild(this.btn('+', 'Volume Up',    KeyEvent.KEYCODE_VOLUME_UP,    'tv-bar-rocker-btn'));
        grid.appendChild(this.btn('+', 'Channel Up',   KeyEvent.KEYCODE_CHANNEL_UP,   'tv-bar-rocker-btn'));
        grid.appendChild(this.btn('−', 'Volume Down',  KeyEvent.KEYCODE_VOLUME_DOWN,  'tv-bar-rocker-btn'));
        grid.appendChild(this.btn('−', 'Channel Down', KeyEvent.KEYCODE_CHANNEL_DOWN, 'tv-bar-rocker-btn'));

        wrap.appendChild(labels);
        wrap.appendChild(grid);
        return wrap;
    }

    private sep(): HTMLDivElement {
        const s = document.createElement('div');
        s.className = 'tv-bar-sep';
        return s;
    }

    /** Invisible spacer cell to fill a 2×3 grid */
    private placeholder(): HTMLDivElement {
        const d = document.createElement('div');
        d.className = 'tv-cell-placeholder';
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
}
