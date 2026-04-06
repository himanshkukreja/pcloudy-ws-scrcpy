/**
 * PhoneDragResize
 *
 * Makes the phone container draggable and resizable within the `.video` parent.
 * The wrapper element is positioned absolutely inside the flex `.video` div.
 * Users can drag the grip bar at the top to reposition, or drag corner handles to resize.
 *
 * Position and size are persisted to localStorage keyed by udid.
 */

const STORAGE_PREFIX = 'pcloudy-phone-pos-';
const MIN_WIDTH = 120;
const MIN_HEIGHT = 200;

type SavedState = {
    x: number;
    y: number;
    w: number;
    h: number;
};

type ResizeDir = 'tl' | 'tr' | 'bl' | 'br';

export class PhoneDragResize {
    private wrapper: HTMLElement;
    private onResize: () => void;
    private udid: string;

    // Drag state
    private isDragging = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private wrapperStartLeft = 0;
    private wrapperStartTop = 0;

    // Resize state
    private isResizing = false;
    private resizeDir: ResizeDir = 'br';
    private resizeStartX = 0;
    private resizeStartY = 0;
    private resizeStartW = 0;
    private resizeStartH = 0;
    private resizeStartLeft = 0;
    private resizeStartTop = 0;

    constructor(wrapper: HTMLElement, udid: string, onResize: () => void) {
        this.wrapper = wrapper;
        this.udid = udid;
        this.onResize = onResize;
    }

    public init(): void {
        this.buildGrip();
        this.buildResizeHandles();
        this.restoreState();
        document.addEventListener('mousemove', this.onMouseMove);
        document.addEventListener('mouseup', this.onMouseUp);
        document.addEventListener('touchmove', this.onTouchMove, { passive: false });
        document.addEventListener('touchend', this.onTouchEnd);
    }

    public destroy(): void {
        document.removeEventListener('mousemove', this.onMouseMove);
        document.removeEventListener('mouseup', this.onMouseUp);
        document.removeEventListener('touchmove', this.onTouchMove);
        document.removeEventListener('touchend', this.onTouchEnd);
    }

    // ── Build UI ─────────────────────────────────────────────────────────────

    private buildGrip(): void {
        const grip = document.createElement('div');
        grip.className = 'phone-grip';
        const dots = document.createElement('div');
        dots.className = 'phone-grip-dots';
        for (let i = 0; i < 6; i++) {
            dots.appendChild(document.createElement('span'));
        }
        grip.appendChild(dots);

        grip.addEventListener('mousedown', this.onGripMouseDown);
        grip.addEventListener('touchstart', this.onGripTouchStart, { passive: false });

        // Insert grip before the phone-container (first child of wrapper)
        this.wrapper.insertBefore(grip, this.wrapper.firstChild);
    }

    private buildResizeHandles(): void {
        const dirs: ResizeDir[] = ['tl', 'tr', 'bl', 'br'];
        dirs.forEach((dir) => {
            const handle = document.createElement('div');
            handle.className = `resize-handle resize-handle--${dir}`;
            handle.addEventListener('mousedown', (e) => this.onResizeMouseDown(e, dir));
            handle.addEventListener('touchstart', (e) => this.onResizeTouchStart(e, dir), { passive: false });
            this.wrapper.appendChild(handle);
        });
    }

    // ── State persistence ─────────────────────────────────────────────────────

    private storageKey(): string {
        return `${STORAGE_PREFIX}${this.udid}`;
    }

    private saveState(): void {
        try {
            const rect = this.wrapper.getBoundingClientRect();
            const parent = this.wrapper.parentElement;
            if (!parent) return;
            const parentRect = parent.getBoundingClientRect();
            const state: SavedState = {
                x: rect.left - parentRect.left,
                y: rect.top - parentRect.top,
                w: rect.width,
                h: rect.height,
            };
            localStorage.setItem(this.storageKey(), JSON.stringify(state));
        } catch (_) {
            // ignore
        }
    }

    private restoreState(): void {
        try {
            const raw = localStorage.getItem(this.storageKey());
            if (!raw) return;
            const state = JSON.parse(raw) as SavedState;
            const parent = this.wrapper.parentElement;
            if (!parent) return;
            const parentRect = parent.getBoundingClientRect();

            // Clamp to parent bounds
            const w = Math.max(MIN_WIDTH, Math.min(state.w, parentRect.width));
            const h = Math.max(MIN_HEIGHT, Math.min(state.h, parentRect.height));
            const x = Math.max(0, Math.min(state.x, parentRect.width - w));
            const y = Math.max(0, Math.min(state.y, parentRect.height - h));

            this.applyPosition(x, y);
            this.applySize(w, h);
        } catch (_) {
            // ignore
        }
    }

    // ── Drag ──────────────────────────────────────────────────────────────────

    private onGripMouseDown = (e: MouseEvent): void => {
        e.preventDefault();
        this.startDrag(e.clientX, e.clientY);
    };

    private onGripTouchStart = (e: TouchEvent): void => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        const t = e.touches[0];
        this.startDrag(t.clientX, t.clientY);
    };

    private startDrag(clientX: number, clientY: number): void {
        this.isDragging = true;
        this.wrapper.classList.add('is-dragging');
        this.dragStartX = clientX;
        this.dragStartY = clientY;

        const rect = this.wrapper.getBoundingClientRect();
        const parent = this.wrapper.parentElement;
        const parentRect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
        this.wrapperStartLeft = rect.left - parentRect.left;
        this.wrapperStartTop = rect.top - parentRect.top;
        this.clearTransform();
    }

    // ── Resize ────────────────────────────────────────────────────────────────

    private onResizeMouseDown = (e: MouseEvent, dir: ResizeDir): void => {
        e.preventDefault();
        e.stopPropagation();
        this.startResize(e.clientX, e.clientY, dir);
    };

    private onResizeTouchStart = (e: TouchEvent, dir: ResizeDir): void => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        const t = e.touches[0];
        this.startResize(t.clientX, t.clientY, dir);
    };

    private startResize(clientX: number, clientY: number, dir: ResizeDir): void {
        this.isResizing = true;
        this.resizeDir = dir;
        this.resizeStartX = clientX;
        this.resizeStartY = clientY;

        const rect = this.wrapper.getBoundingClientRect();
        const parent = this.wrapper.parentElement;
        const parentRect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
        this.resizeStartW = rect.width;
        this.resizeStartH = rect.height;
        this.resizeStartLeft = rect.left - parentRect.left;
        this.resizeStartTop = rect.top - parentRect.top;
        this.clearTransform();
    }

    // ── Mouse/Touch move ──────────────────────────────────────────────────────

    private onMouseMove = (e: MouseEvent): void => {
        this.handleMove(e.clientX, e.clientY);
    };

    private onTouchMove = (e: TouchEvent): void => {
        if (e.touches.length !== 1) return;
        if (this.isDragging || this.isResizing) e.preventDefault();
        const t = e.touches[0];
        this.handleMove(t.clientX, t.clientY);
    };

    private handleMove(clientX: number, clientY: number): void {
        if (this.isDragging) {
            const dx = clientX - this.dragStartX;
            const dy = clientY - this.dragStartY;
            this.constrainAndApplyPosition(
                this.wrapperStartLeft + dx,
                this.wrapperStartTop + dy,
            );
        } else if (this.isResizing) {
            this.handleResize(clientX, clientY);
        }
    }

    private handleResize(clientX: number, clientY: number): void {
        const dx = clientX - this.resizeStartX;
        const dy = clientY - this.resizeStartY;
        const parent = this.wrapper.parentElement;
        const parentRect = parent ? parent.getBoundingClientRect() : { width: 9999, height: 9999 };

        let newW = this.resizeStartW;
        let newH = this.resizeStartH;
        let newLeft = this.resizeStartLeft;
        let newTop = this.resizeStartTop;

        const dir = this.resizeDir;

        // Width/x
        if (dir === 'tl' || dir === 'bl') {
            newW = Math.max(MIN_WIDTH, this.resizeStartW - dx);
            newLeft = this.resizeStartLeft + (this.resizeStartW - newW);
        } else {
            newW = Math.max(MIN_WIDTH, this.resizeStartW + dx);
        }

        // Height/y
        if (dir === 'tl' || dir === 'tr') {
            newH = Math.max(MIN_HEIGHT, this.resizeStartH - dy);
            newTop = this.resizeStartTop + (this.resizeStartH - newH);
        } else {
            newH = Math.max(MIN_HEIGHT, this.resizeStartH + dy);
        }

        // Constrain to parent
        newLeft = Math.max(0, Math.min(newLeft, parentRect.width - newW));
        newTop = Math.max(0, Math.min(newTop, parentRect.height - newH));

        this.applyPosition(newLeft, newTop);
        this.applySize(newW, newH);
        this.onResize();
    }

    // ── Mouse/Touch up ────────────────────────────────────────────────────────

    private onMouseUp = (): void => {
        this.endInteraction();
    };

    private onTouchEnd = (): void => {
        this.endInteraction();
    };

    private endInteraction(): void {
        if (this.isDragging || this.isResizing) {
            this.isDragging = false;
            this.isResizing = false;
            this.wrapper.classList.remove('is-dragging');
            this.saveState();
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private clearTransform(): void {
        // Remove the initial centering transform so left/top are in parent coords
        if (this.wrapper.style.transform) {
            const rect = this.wrapper.getBoundingClientRect();
            const parent = this.wrapper.parentElement;
            const parentRect = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
            this.wrapper.style.transform = '';
            this.wrapper.style.left = `${rect.left - parentRect.left}px`;
            this.wrapper.style.top = `${rect.top - parentRect.top}px`;
        }
    }

    private applyPosition(x: number, y: number): void {
        this.wrapper.style.transform = '';
        this.wrapper.style.left = `${x}px`;
        this.wrapper.style.top = `${y}px`;
    }

    private constrainAndApplyPosition(x: number, y: number): void {
        const parent = this.wrapper.parentElement;
        if (!parent) return;
        const parentRect = parent.getBoundingClientRect();
        const wRect = this.wrapper.getBoundingClientRect();
        const maxX = parentRect.width - wRect.width;
        const maxY = parentRect.height - wRect.height;
        this.applyPosition(
            Math.max(0, Math.min(x, maxX)),
            Math.max(0, Math.min(y, maxY)),
        );
    }

    private applySize(w: number, h: number): void {
        this.wrapper.style.width = `${w}px`;
        this.wrapper.style.height = `${h}px`;
    }
}
