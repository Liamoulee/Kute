import { kute } from "../client.js";

window.chrome.webview.postMessage("drag, true");
window.chrome.webview.postMessage("throttle, menu");

// trick for hiding "PRESS ESC TO EXIT POINTER LOCK" also breaks the default notification for downloads
const originalExportSettings = window.exportSettings;
/**
 * Wraps Krunker's exportSettings to show a notification, since the default download popup is hidden.
 *
 * @return {any}
 */
window.exportSettings = () => {
    kute.showNotification("Settings exported to Downloads!", false, 3);
    return originalExportSettings();
};

// disable cpu throttling while on the skins menu
// fixes it taking 10 years to load

const originalshowWindow = window.showWindow;
/**
 * Wraps Krunker's showWindow to switch CPU throttling based on which window opens.
 *
 * @param {...any} args
 * @return {any}
 */
window.showWindow = (...args) => {
    const number = args[0];
    switch (number){
        case 3:
        case 53:
            window.chrome.webview.postMessage("throttle, game");
            break;
        case 15:
        case 26:
        case 52:
        case 9:
        case 44:
        case 43:
        case 40:
        case 38:
        case 50:
        case 17:
        case 39:
        case 51:
        case 16:
        case 34:
            window.chrome.webview.postMessage("throttle, menu");
            break;
        default:
            break;
    }
    return originalshowWindow.apply(this, args);
};

const originalclosWind = window.closWind;
/**
 * Wraps Krunker's closWind to re-enable dragging and menu throttling.
 *
 * @param {...any} args
 * @return {any}
 */
window.closWind = (...args) => {
    window.chrome.webview.postMessage("drag, true");
    window.chrome.webview.postMessage("throttle, menu");
    return originalclosWind.apply(this, args);
};

/**
 * Binds the alternate shoot key to F20 (key code 131) by simulating the keypress in the controls menu.
 */
kute.bindShoot = () => {
    window.changeCont("shoot", 1, undefined);
    const eventOptions = {
        key: "F20",
        code: "F20",
        keyCode: 131,
        which: 131,
        bubbles: true,
        cancelable: true,
    };
    window.dispatchEvent(new KeyboardEvent("keydown", eventOptions));
    window.dispatchEvent(new KeyboardEvent("keyup", eventOptions));
};

