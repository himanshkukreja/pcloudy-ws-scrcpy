import { Optional, ToolBoxElement } from './ToolBoxElement';
import SvgImage, { Icon } from '../ui/SvgImage';

export class ToolBoxButton extends ToolBoxElement<HTMLButtonElement> {
    private readonly btn: HTMLButtonElement;
    constructor(title: string, icon: Icon, optional?: Optional, label?: string) {
        super(title, optional);
        const btn = document.createElement('button');
        btn.classList.add('control-button');
        if (label !== undefined) {
            btn.classList.add('control-button--labeled');
        }
        btn.title = title;

        const iconEl = SvgImage.create(icon);
        btn.appendChild(iconEl);

        if (label !== undefined) {
            const labelEl = document.createElement('span');
            labelEl.className = 'control-button-label';
            labelEl.textContent = label;
            btn.appendChild(labelEl);
        }

        this.btn = btn;
    }

    public getElement(): HTMLButtonElement {
        return this.btn;
    }
    public getAllElements(): HTMLElement[] {
        return [this.btn];
    }
}
