import { ToolBoxElement } from './ToolBoxElement';

const STORAGE_COLLAPSED_KEY = 'pcloudy-toolbox-collapsed';
const STORAGE_POS_KEY = 'pcloudy-toolbox-pos';

/** Viewport width below which the toolbar auto-collapses to icon-strip mode */
const COMPACT_THRESHOLD = 520;

export class ToolBox {
    private readonly holder: HTMLElement;
    private readonly contentWrapper: HTMLElement;
    private readonly toggleButton: HTMLButtonElement;
    private isDragging = false;
    private dragOffsetX = 0;
    private dragOffsetY = 0;
    private isCollapsed = false;
    private autoCollapsed = false;

    constructor(list: ToolBoxElement<any>[]) {
        this.holder = document.createElement('div');
        this.holder.classList.add('control-buttons-list', 'control-wrapper');

        // ── Header: "Quick Actions" title + chevron arrow ────────────────────────
        const header = document.createElement('div');
        header.className = 'toolbox-header';

        const title = document.createElement('span');
        title.className = 'toolbox-title';
        title.textContent = 'Quick Actions';
        header.appendChild(title);

        this.toggleButton = document.createElement('button');
        this.toggleButton.className = 'toolbox-toggle';
        this.toggleButton.innerHTML = this.chevron(false);
        this.toggleButton.title = 'Collapse';
        this.toggleButton.addEventListener('click', this.onToggle);
        header.appendChild(this.toggleButton);

        this.holder.appendChild(header);

        // ── Content ──────────────────────────────────────────────────────────────
        this.contentWrapper = document.createElement('div');
        this.contentWrapper.className = 'toolbox-content';
        list.forEach((item) => {
            item.getAllElements().forEach((el) => this.contentWrapper.appendChild(el));
        });
        this.holder.appendChild(this.contentWrapper);

        this.restoreState();
        this.initDrag();
        this.checkResponsive();
        window.addEventListener('resize', this.onWindowResize);
    }

    // ── Responsive ───────────────────────────────────────────────────────────────

    private checkResponsive(): void {
        const narrow = window.innerWidth < COMPACT_THRESHOLD;
        this.holder.classList.toggle('compact', narrow);
        if (narrow && !this.isCollapsed) {
            this.autoCollapsed = true;
            this.applyCollapsed(true, false);
        } else if (!narrow && this.autoCollapsed) {
            this.autoCollapsed = false;
            this.applyCollapsed(false, false);
        }
    }

    private onWindowResize = (): void => {
        this.checkResponsive();
        // Clamp position within visible viewport bounds after resize
        const rect = this.holder.getBoundingClientRect();
        const cx = Math.max(0, Math.min(rect.left, window.innerWidth - rect.width));
        const cy = Math.max(0, Math.min(rect.top, window.innerHeight - rect.height));
        if (cx !== rect.left || cy !== rect.top) {
            this.holder.style.left = `${cx}px`;
            this.holder.style.top = `${cy}px`;
            this.holder.style.transform = 'none';
        }
    };

    // ── Collapse helpers ─────────────────────────────────────────────────────────

    private applyCollapsed(collapsed: boolean, save = true): void {
        this.isCollapsed = collapsed;
        this.holder.classList.toggle('collapsed', collapsed);
        this.toggleButton.innerHTML = this.chevron(collapsed);
        this.toggleButton.title = collapsed ? 'Expand' : 'Collapse';
        if (save) this.saveCollapsedState();
    }

    private onToggle = (e: MouseEvent): void => {
        e.stopPropagation();
        this.autoCollapsed = false; // user explicitly toggled — clear auto flag
        this.applyCollapsed(!this.isCollapsed);
    };

    private chevron(collapsed: boolean): string {
        const pts = collapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6';
        return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="${pts}"/></svg>`;
    }

    // ── Persistence ──────────────────────────────────────────────────────────────

    private restoreState(): void {
        try {
            if (localStorage.getItem(STORAGE_COLLAPSED_KEY) === 'true') {
                this.applyCollapsed(true, false);
            }
        } catch (_) { /* localStorage may be unavailable in some iframe contexts */ }

        try {
            const saved = localStorage.getItem(STORAGE_POS_KEY);
            if (saved) {
                const { x, y } = JSON.parse(saved) as { x: number; y: number };
                this.holder.style.left = `${x}px`;
                this.holder.style.top = `${y}px`;
                this.holder.style.transform = 'none';
            }
        } catch (_) { /* ignore parse errors */ }
    }

    private saveCollapsedState(): void {
        try { localStorage.setItem(STORAGE_COLLAPSED_KEY, String(this.isCollapsed)); } catch (_) { /* ignore */ }
    }

    private savePosition(x: number, y: number): void {
        try { localStorage.setItem(STORAGE_POS_KEY, JSON.stringify({ x, y })); } catch (_) { /* ignore */ }
    }

    // ── Drag ─────────────────────────────────────────────────────────────────────

    private initDrag(): void {
        this.holder.addEventListener('mousedown', this.onDragStart);
        this.holder.addEventListener('touchstart', this.onTouchStart, { passive: false });
    }

    private onDragStart = (e: MouseEvent): void => {
        const target = e.target as HTMLElement;
        if (target.closest('.control-button') || target.closest('.toolbox-toggle') || target.tagName === 'INPUT') return;
        e.preventDefault();
        this.isDragging = true;
        this.holder.classList.add('dragging');
        const rect = this.holder.getBoundingClientRect();
        this.dragOffsetX = e.clientX - rect.left;
        this.dragOffsetY = e.clientY - rect.top;
        document.addEventListener('mousemove', this.onDragMove);
        document.addEventListener('mouseup', this.onDragEnd);
    };

    private onTouchStart = (e: TouchEvent): void => {
        const target = e.target as HTMLElement;
        if (target.closest('.control-button') || target.closest('.toolbox-toggle') || target.tagName === 'INPUT') return;
        if (e.touches.length !== 1) return;
        e.preventDefault();
        this.isDragging = true;
        this.holder.classList.add('dragging');
        const rect = this.holder.getBoundingClientRect();
        this.dragOffsetX = e.touches[0].clientX - rect.left;
        this.dragOffsetY = e.touches[0].clientY - rect.top;
        document.addEventListener('touchmove', this.onTouchMove, { passive: false });
        document.addEventListener('touchend', this.onTouchEnd);
    };

    private onDragMove = (e: MouseEvent): void => {
        if (!this.isDragging) return;
        this.setPosition(e.clientX - this.dragOffsetX, e.clientY - this.dragOffsetY);
    };

    private onTouchMove = (e: TouchEvent): void => {
        if (!this.isDragging || e.touches.length !== 1) return;
        e.preventDefault();
        this.setPosition(e.touches[0].clientX - this.dragOffsetX, e.touches[0].clientY - this.dragOffsetY);
    };

    private setPosition(x: number, y: number): void {
        const rect = this.holder.getBoundingClientRect();
        x = Math.max(0, Math.min(x, window.innerWidth - rect.width));
        y = Math.max(0, Math.min(y, window.innerHeight - rect.height));
        this.holder.style.left = `${x}px`;
        this.holder.style.top = `${y}px`;
        this.holder.style.transform = 'none';
        this.savePosition(x, y);
    }

    private onDragEnd = (): void => {
        this.isDragging = false;
        this.holder.classList.remove('dragging');
        document.removeEventListener('mousemove', this.onDragMove);
        document.removeEventListener('mouseup', this.onDragEnd);
    };

    private onTouchEnd = (): void => {
        this.isDragging = false;
        this.holder.classList.remove('dragging');
        document.removeEventListener('touchmove', this.onTouchMove);
        document.removeEventListener('touchend', this.onTouchEnd);
    };

    // ── Public API ───────────────────────────────────────────────────────────────

    public getHolderElement(): HTMLElement { return this.holder; }

    public destroy(): void {
        this.toggleButton.removeEventListener('click', this.onToggle);
        this.holder.removeEventListener('mousedown', this.onDragStart);
        this.holder.removeEventListener('touchstart', this.onTouchStart);
        document.removeEventListener('mousemove', this.onDragMove);
        document.removeEventListener('mouseup', this.onDragEnd);
        document.removeEventListener('touchmove', this.onTouchMove);
        document.removeEventListener('touchend', this.onTouchEnd);
        window.removeEventListener('resize', this.onWindowResize);
    }
}
