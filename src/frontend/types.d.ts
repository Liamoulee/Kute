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

interface RecoveryInfo {
    mode: "safe" | "test" | "result" | "offer";
    canFind?: boolean;
    kind?: "startup" | "play";
    step?: number;
    suspects?: number;
    minutes?: number;
    ranFine?: boolean;
    verdict?: "culprit" | "notTheSetup";
    culprits?: { label: string; fixable: boolean }[];
    tests?: { crashed: number; ranFine: number };
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
    /** the exe's os, absent on windows exes older than the linux port */
    platform?: "windows" | "linux";
    /** who holds the fps limit, "viz" = chromium (patch 08), absent or "hook" = the present hook with the busy wait fallback */
    frameLimiter?: "viz" | "hook";
    /** restart-only settings as this process was started with, by setting id. a stored value that differs needs a restart */
    running?: Record<string, boolean>;
    /** this PC has a dev token, the token itself never leaves the host */
    dev?: boolean;
    matchmaker: { showFilters(): Promise<void> };
    hotkeys: { edit(): void };
    chatLogs?: { open(): void; toggle(): void };
    accounts?: { loginSlot(index: number): void };
    settingsTransfer: { exportFile(): void; importFile(): void };
    diagnostics: { open(): void };
    /** safe mode, a crash test or its result, absent otherwise and on older exes */
    recovery?: RecoveryInfo;
    nukeCounter: { showOptions(): Promise<void> };
    customSky: { showOptions(): Promise<void> };
    hudEditor: { edit(): void; apply(): void };
    kuteIcons: { customize(): void; refresh(): void };
    /** masterChanged is set once the manager module loaded */
    userscriptManager: { open(): void; masterChanged?: (on: boolean) => void };
    swapperManager: { open(): void };
    customCss: { open(): void };
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
declare var exportSettings: (asString?: boolean) => any;
declare var importSettings: () => any;
declare var importSettingsPopup: () => any;
declare var openRankedMenu: () => void;
declare var openHostWindow: (custom: boolean, mode: number) => void;
declare var createPrivateRoom: () => void;
declare var setSetting: (key: string, value: any) => void;
declare var loginOrRegister: () => void;
declare var logoutAcc: () => void;
declare var FRVR: { auth: { isLoggedIn: () => boolean, loginAsAnonymous: () => Promise<unknown>, logout: () => unknown, getCurrentPlatform: () => string } } | undefined;
declare var playSelect: (volume?: number) => void;
declare var openServerWindow: (tab: number) => void;
declare var switchChat: (element: Element | null) => void;
declare var changeCont: (name: string, index: number, value: any) => void;
