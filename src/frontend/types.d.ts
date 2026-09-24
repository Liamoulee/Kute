declare module "*.css" {
    const content: string;
    export default content;
}

declare module "*.html" {
    const content: string;
    export default content;
}

/** base64 */
declare module "*.ogg" {
    const content: string;
    export default content;
}

/** minified source as a string, see popupScriptPlugin in esbuild.config.mjs */
declare module "popup-script:*" {
    const content: string;
    export default content;
}

/** data url */
declare module "*.webp" {
    const content: string;
    export default content;
}

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

interface WebViewBridge {
    postMessage(message: string): void;
    addEventListener(type: "message", listener: HostMessageListener): void;
    removeEventListener(type: "message", listener: HostMessageListener): void;
}

interface KuteSettings {
    data: Record<string, any>;
    changeSetting(id: string, rawValue: string | number | boolean, slider: boolean): void;
    [toggleFunction: `toggle${string}`]: (value: any) => void;
}

interface Kute {
    settings: KuteSettings;
    version: string;
    launchArgs: string;
    parseArgs(args: string): Promise<void>;
    showNotification(message: string, reqUserInput: boolean, seconds: number): any;
    showChangelogPopup(version: string): Promise<void>;
    showAboutPopup(): Promise<void>;
    openKuteSettings(): void;
    autoDetect: { start(): Promise<void>; setUp(): void; undo(): void; showLast(): void; dropUndo(): void; afterImport(): void };
    clanColors: { apply(styles: unknown): void; toggle(enabled: boolean): void };
    badges: { toggle(enabled: boolean): void };
    /** devs: hash -> clan tag */
    presence: { game: string; roster: Set<string>; devs: Map<string, string>; receive(data: unknown): void };
    /** absent on older exes */
    apiBase?: string;
    api: { base: string; down: boolean; available(): Promise<boolean> };
    bindShoot(): void;
    /** absent on older exes */
    hostFeatures?: string[];
    /** this PC has a dev token, the token itself never leaves the host */
    dev?: boolean;
    matchmaker: { showFilters(): Promise<void> };
    nukeCounter: { showOptions(): Promise<void> };
    hudEditor: { edit(): void };
    kuteIcons: { customize(): void; refresh(): void };
    userscriptManager: { open(): void };
    swapperManager: { open(): void };
}

interface KrunkerGameActivity {
    mode: string;
    map: string | null;
    custom: boolean;
    /** "FRA:4c2f8", same as ?game= */
    id?: string;
    /** own display name, not the account name */
    user?: string;
}

interface KrunkerSound {
    play(soundName: string, volume?: number, loop?: boolean): any;
}

declare var chrome: { webview: WebViewBridge };
/** called by krunker's own exit button */
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
declare var openServerWindow: (tab: number) => void;
declare var switchChat: (element: Element | null) => void;
declare var changeCont: (name: string, index: number, value: any) => void;
