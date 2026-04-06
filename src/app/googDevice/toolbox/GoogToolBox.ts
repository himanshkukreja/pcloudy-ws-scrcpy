import { ToolBox } from '../../toolbox/ToolBox';
import KeyEvent from '../android/KeyEvent';
import SvgImage from '../../ui/SvgImage';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
import { ToolBoxElement } from '../../toolbox/ToolBoxElement';
import { StreamClientScrcpy } from '../client/StreamClientScrcpy';
import { BasePlayer } from '../../player/BasePlayer';
import { TVRemote } from './TVRemote';

// Navigation keys — sent as KeyCodeControlMessage via WebSocket (zero latency)
const NAV_BUTTONS = [
    { title: 'Back',     label: 'Back',     code: KeyEvent.KEYCODE_BACK,       icon: SvgImage.Icon.BACK },
    { title: 'Home',     label: 'Home',     code: KeyEvent.KEYCODE_HOME,       icon: SvgImage.Icon.HOME },
    { title: 'Overview', label: 'Apps',     code: KeyEvent.KEYCODE_APP_SWITCH, icon: SvgImage.Icon.OVERVIEW },
    { title: 'Menu',     label: 'Menu',     code: KeyEvent.KEYCODE_MENU,       icon: SvgImage.Icon.MENU },
];

// System / volume keys
const SYSTEM_BUTTONS = [
    { title: 'Power',       label: 'Power',    code: KeyEvent.KEYCODE_POWER,        icon: SvgImage.Icon.POWER },
    { title: 'Volume up',   label: 'Vol +',    code: KeyEvent.KEYCODE_VOLUME_UP,    icon: SvgImage.Icon.VOLUME_UP },
    { title: 'Volume down', label: 'Vol -',    code: KeyEvent.KEYCODE_VOLUME_DOWN,  icon: SvgImage.Icon.VOLUME_DOWN },
    { title: 'Mute',        label: 'Mute',     code: KeyEvent.KEYCODE_VOLUME_MUTE,  icon: SvgImage.Icon.MUTE_KEY },
    { title: 'Notifications', label: 'Notifs', code: KeyEvent.KEYCODE_NOTIFICATION, icon: SvgImage.Icon.NOTIFICATIONS },
];

/** Creates a thin visual divider between button groups */
function makeDivider(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'toolbox-divider';
    return el;
}

/** Creates a small section heading */
function makeSectionHeader(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'toolbox-section-header';
    el.textContent = text;
    return el;
}

/** Wraps a raw HTMLElement as a minimal ToolBoxElement so ToolBox can accept it */
class RawElement extends ToolBoxElement<HTMLElement> {
    private readonly el: HTMLElement;
    constructor(el: HTMLElement) {
        super('', undefined);
        this.el = el;
    }
    public getElement(): HTMLElement { return this.el; }
    public getAllElements(): HTMLElement[] { return [this.el]; }
}

export class GoogToolBox extends ToolBox {
    public tvRemote?: TVRemote;

    protected constructor(list: ToolBoxElement<any>[]) {
        super(list);
    }

    public static createToolBox(
        _udid: string,
        _player: BasePlayer,
        client: StreamClientScrcpy,
        _moreBox?: HTMLElement,
    ): GoogToolBox {
        const elements: ToolBoxElement<any>[] = [];

        // --- Key handler (mousedown/mouseup → KeyCodeControlMessage over WebSocket) ---
        const handler = <K extends keyof HTMLElementEventMap, T extends HTMLElement>(
            type: K,
            element: ToolBoxElement<T>,
        ) => {
            if (!element.optional?.code) return;
            const { code } = element.optional;
            const action = type === 'mousedown' ? KeyEvent.ACTION_DOWN : KeyEvent.ACTION_UP;
            const event = new KeyCodeControlMessage(action, code, 0, 0);
            client.sendMessage(event);
        };

        // ── Section: Navigation ──────────────────────────────────────────────────
        elements.push(new RawElement(makeSectionHeader('Navigation')));
        NAV_BUTTONS.forEach((item) => {
            const button = new ToolBoxButton(item.title, item.icon, { code: item.code }, item.label);
            button.addEventListener('mousedown', handler);
            button.addEventListener('mouseup', handler);
            elements.push(button);
        });

        // ── Divider ──────────────────────────────────────────────────────────────
        elements.push(new RawElement(makeDivider()));

        // ── Section: System ──────────────────────────────────────────────────────
        elements.push(new RawElement(makeSectionHeader('System')));
        SYSTEM_BUTTONS.forEach((item) => {
            const button = new ToolBoxButton(item.title, item.icon, { code: item.code }, item.label);
            button.addEventListener('mousedown', handler);
            button.addEventListener('mouseup', handler);
            elements.push(button);
        });

        // Android TV: add a remote control toggle button
        const params = new URLSearchParams(window.location.search);
        const isAndroidTV = params.get('deviceType') === 'androidtv';
        let tvRemote: TVRemote | undefined;
        if (isAndroidTV) {
            tvRemote = new TVRemote(client);
            const remoteBtn = new ToolBoxButton('TV Remote', SvgImage.Icon.TV_REMOTE, undefined, 'TV Remote');
            remoteBtn.addEventListener('click', () => {
                tvRemote!.toggle();
            });
            elements.unshift(remoteBtn);
        }

        const toolBox = new GoogToolBox(elements);
        if (tvRemote) {
            toolBox.tvRemote = tvRemote;
        }
        return toolBox;
    }
}
