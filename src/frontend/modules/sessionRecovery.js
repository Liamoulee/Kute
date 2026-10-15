// frvr sdk bugs since season 10, chrome too: no login after an in-page logout, no lobby on the load after it

const REFRESH_KEY = "__FRVR_auth_refresh_token";
const TOKEN_KEY = "krunker_token";
const HANG_RELOADS_KEY = "kute_hang_reloads";
// in a row without a lobby in between, more is not this bug
const MAX_HANG_RELOADS = 2;
// a normal load has its lobby within a second of the anonymous frvr login, a false alarm costs one page load
const HANG_MS = 1500;
const GIVE_UP_MS = 90000;
const POLL_MS = 1000;

// not location.reload(), rejoining the ?game= lobby every time fills it ("Game is Full")
export function restart(){
    location.assign("https://krunker.io/");
}

let holdUntil = 0;

/**
 * a logout the account manager asked for is no reason to leave the page
 *
 * @param {number} ms
 */
export function holdRestart(ms){
    holdUntil = Date.now() + ms;
}

/**
 * @return {boolean}
 */
function hasFrvrSession(){
    return localStorage.getItem(REFRESH_KEY) !== null || document.cookie.includes(`${REFRESH_KEY}=`);
}

/**
 * @return {boolean}
 */
function hasLobby(){
    try {
        return Boolean(window.getGameActivity?.()?.id);
    }
    catch {
        return false;
    }
}

/**
 * @param {boolean} mayHang
 */
function watchForHang(mayHang){
    const start = Date.now();
    let sessionSince = 0;
    const timer = setInterval(() => {
        if (hasLobby()){
            sessionStorage.removeItem(HANG_RELOADS_KEY);
            clearInterval(timer);
            return;
        }
        if (Date.now() - start > GIVE_UP_MS){
            clearInterval(timer);
            return;
        }
        if (!mayHang || !hasFrvrSession()) return;
        if (sessionSince === 0) sessionSince = Date.now();
        if (Date.now() - sessionSince < HANG_MS) return;
        clearInterval(timer);

        const reloads = Number(sessionStorage.getItem(HANG_RELOADS_KEY) ?? 0);
        if (reloads >= MAX_HANG_RELOADS) return;
        sessionStorage.setItem(HANG_RELOADS_KEY, String(reloads + 1));
        console.log("[kute] session: no lobby after the frvr login, reloading");
        restart();
    }, POLL_MS);
}

function watchForLogout(){
    let signedIn = localStorage.getItem(TOKEN_KEY) !== null;
    let loggedOut = false;
    setInterval(() => {
        if (loggedOut){
            // never out of a running match
            if (!document.pointerLockElement) restart();
            return;
        }
        const now = localStorage.getItem(TOKEN_KEY) !== null;
        if (signedIn && !now && Date.now() > holdUntil){
            loggedOut = true;
            console.log("[kute] session: logged out, reloading");
        }
        signedIn = now;
    }, POLL_MS);
}

// social.html and the other pages never get a lobby
if (location.hostname === "krunker.io" && location.pathname === "/"){
    watchForHang(!hasFrvrSession());
    watchForLogout();
}
