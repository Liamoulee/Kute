// Ambient types for the injected frontend bundle.
// Krunker's own globals are typed as loosely as needed, since they change with every game update.

declare module "*.css" {
    const content: string;
    export default content;
}

declare module "*.html" {
    const content: string;
    export default content;
}

/** Imported as a data URL. */
declare module "*.webp" {
    const content: string;
    export default content;
}

/** Messages posted by the host (Rust) to the page. */
type HostMessage =
    | "game-updated"
    | { fpsInfo: number }
    | { pingInfo: number }
    | { wheel: number }
    | { type: "obs-plugin"; ok: boolean; message: string }
    | { args: string }
    | { specs: Record<string, any> }
    | { presentFps: number }
    | { settings: Record<string, any>; version: string; launchArgs: string }
    | Record<string, any>;

type HostMessageListener = (event: MessageEvent<any>) => void;

/** The WebView2 script bridge (window.chrome.webview). */
interface WebViewBridge {
    postMessage(message: string): void;
    addEventListener(type: "message", listener: HostMessageListener): void;
    removeEventListener(type: "message", listener: HostMessageListener): void;
}

interface KuteSettings {
    /** Current setting values by id. */
    data: Record<string, any>;
    changeSetting(id: string, rawValue: string | number | boolean, slider: boolean): void;
    /** toggle<Id>(value) functions registered by modules. Called with the new value of the setting. */
    [toggleFunction: `toggle${string}`]: (value: any) => void;
}

/** The client object exported by client.js: host info plus the functions modules attach to it. */
interface Kute {
    settings: KuteSettings;
    version: string;
    launchArgs: string;
    parseArgs(args: string): Promise<void>;
    showNotification(message: string, reqUserInput: boolean, seconds: number): any;
    showChangelogPopup(version: string): Promise<void>;
    showAboutPopup(): Promise<void>;
    autoDetect: { start(automatic?: boolean, inMatch?: boolean): Promise<void>; fineTune(): Promise<void>; undo(): void };
    bindShoot(): void;
}

interface KrunkerGameActivity {
    mode: string;
    map: string | null;
    custom: boolean;
}

interface KrunkerSound {
    play(soundName: string, volume?: number, loop?: boolean): any;
}

// client globals (everything else the client needs lives in modules, see client.js and utils.js)

declare var chrome: { webview: WebViewBridge };
/** Called by Krunker's own client exit button. */
declare var closeClient: () => void;
declare var OffCliV: boolean;
declare var gameLoaded: boolean;

// krunker globals

declare var windows: any[];
declare var SOUND: KrunkerSound;
declare var getGameActivity: () => KrunkerGameActivity;
declare var setSpect: (enabled: boolean) => void;
declare var showWindow: (...args: any[]) => any;
declare var closWind: (...args: any[]) => any;
declare var bundlePopup: (...args: any[]) => any;
declare var exportSettings: () => any;
declare var importSettings: () => any;
declare var importSettingsPopup: () => any;
declare var openRankedMenu: () => void;
declare var openHostWindow: (custom: boolean, mode: number) => void;
declare var createPrivateRoom: () => void;
declare var setSetting: (key: string, value: any) => void;
declare var loginOrRegister: () => void;
declare var logoutAcc: () => void;
declare var playSelect: (volume?: number) => void;
declare var switchChat: (element: Element | null) => void;
declare var changeCont: (name: string, index: number, value: any) => void;
