import { kute } from "../client.js";

window.chrome.webview.postMessage("drag, true");
window.chrome.webview.postMessage("throttle, menu");

// hiding the pointer lock banner also hides the download notice
const originalExportSettings = window.exportSettings;
/**
 * @return {any}
 */
window.exportSettings = () => {
    kute.showNotification("Settings exported to Downloads!", false, 3);
    return originalExportSettings();
};

// no cpu throttle in heavy menus like skins, they take forever to load otherwise
const originalshowWindow = window.showWindow;
/**
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
    return originalshowWindow(...args);
};

const originalclosWind = window.closWind;
/**
 * @param {...any} args
 * @return {any}
 */
window.closWind = (...args) => {
    window.chrome.webview.postMessage("drag, true");
    window.chrome.webview.postMessage("throttle, menu");
    return originalclosWind(...args);
};

/**
 * binds alt shoot to F20 (131), the host sends left click as F20 while locked
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
