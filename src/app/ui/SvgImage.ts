import KeyboardSVG from '../../public/images/skin-light/ic_keyboard_678_48dp.svg';
import MoreSVG from '../../public/images/skin-light/ic_more_horiz_678_48dp.svg';
import CameraSVG from '../../public/images/skin-light/ic_photo_camera_678_48dp.svg';
import PowerSVG from '../../public/images/skin-light/ic_power_settings_new_678_48px.svg';
import VolumeDownSVG from '../../public/images/skin-light/ic_volume_down_678_48px.svg';
import VolumeUpSVG from '../../public/images/skin-light/ic_volume_up_678_48px.svg';
import BackSVG from '../../public/images/skin-light/System_Back_678.svg';
import HomeSVG from '../../public/images/skin-light/System_Home_678.svg';
import OverviewSVG from '../../public/images/skin-light/System_Overview_678.svg';
import CancelSVG from '../../public/images/buttons/cancel.svg';
import OfflineSVG from '../../public/images/buttons/offline.svg';
import RefreshSVG from '../../public/images/buttons/refresh.svg';
import SettingsSVG from '../../public/images/buttons/settings.svg';
import MenuSVG from '../../public/images/buttons/menu.svg';
import ArrowBackSVG from '../../public/images/buttons/arrow_back.svg';
import ToggleOnSVG from '../../public/images/buttons/toggle_on.svg';
import ToggleOffSVG from '../../public/images/buttons/toggle_off.svg';
import ZoomInSVG from '../../public/images/buttons/zoom_in.svg';
import ZoomOutSVG from '../../public/images/buttons/zoom_out.svg';
import ZoomResetSVG from '../../public/images/buttons/zoom_reset.svg';
import ScreenRotationSVG from '../../public/images/buttons/screen_rotation.svg';
import VolumeOnSVG from '../../public/images/buttons/volume_on.svg';
import VolumeOffSVG from '../../public/images/buttons/volume_off.svg';

export enum Icon {
    BACK,
    HOME,
    OVERVIEW,
    POWER,
    VOLUME_UP,
    VOLUME_DOWN,
    MORE,
    CAMERA,
    KEYBOARD,
    CANCEL,
    OFFLINE,
    REFRESH,
    SETTINGS,
    MENU,
    ARROW_BACK,
    TOGGLE_ON,
    TOGGLE_OFF,
    ZOOM_IN,
    ZOOM_OUT,
    ZOOM_RESET,
    SCREEN_ROTATION,
    VOLUME_ON,
    VOLUME_OFF,
    TV_REMOTE,
}

export default class SvgImage {
    static Icon = Icon;
    private static getSvgString(type: Icon): string {
        switch (type) {
            case Icon.KEYBOARD:
                return KeyboardSVG;
            case Icon.MORE:
                return MoreSVG;
            case Icon.CAMERA:
                return CameraSVG;
            case Icon.POWER:
                return PowerSVG;
            case Icon.VOLUME_DOWN:
                return VolumeDownSVG;
            case Icon.VOLUME_UP:
                return VolumeUpSVG;
            case Icon.BACK:
                return BackSVG;
            case Icon.HOME:
                return HomeSVG;
            case Icon.OVERVIEW:
                return OverviewSVG;
            case Icon.CANCEL:
                return CancelSVG;
            case Icon.OFFLINE:
                return OfflineSVG;
            case Icon.REFRESH:
                return RefreshSVG;
            case Icon.SETTINGS:
                return SettingsSVG;
            case Icon.MENU:
                return MenuSVG;
            case Icon.ARROW_BACK:
                return ArrowBackSVG;
            case Icon.TOGGLE_ON:
                return ToggleOnSVG;
            case Icon.TOGGLE_OFF:
                return ToggleOffSVG;
            case Icon.ZOOM_IN:
                return ZoomInSVG;
            case Icon.ZOOM_OUT:
                return ZoomOutSVG;
            case Icon.ZOOM_RESET:
                return ZoomResetSVG;
            case Icon.SCREEN_ROTATION:
                return ScreenRotationSVG;
            case Icon.VOLUME_ON:
                return VolumeOnSVG;
            case Icon.VOLUME_OFF:
                return VolumeOffSVG;
            case Icon.TV_REMOTE:
                // Inline TV remote icon (Material Design "tv" style remote)
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                    <path d="M7 3C5.9 3 5 3.9 5 5v14c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2H7zm5 2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm-4 7h2v2H8v-2zm3 0h2v2h-2v-2zm3 0h2v2h-2v-2z"/>
                </svg>`;
            default:
                return '';
        }
    }
    public static create(type: Icon): Element {
        const dummy = document.createElement('div');
        dummy.innerHTML = this.getSvgString(type);
        const svg = dummy.children[0];
        const titles = svg.getElementsByTagName('title');
        for (let i = 0, l = titles.length; i < l; i++) {
            svg.removeChild(titles[i]);
        }
        return svg;
    }
}
