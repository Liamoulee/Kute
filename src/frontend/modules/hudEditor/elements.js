/**
 * HUD widgets in panel order. Ids taken from live FFA, deposit and hardpoint lobbies, a missing one is skipped.
 *
 * @typedef {object} HudElement
 * @property {string} key Stored in the layout setting, never changes
 * @property {string} name Shown in the panel and on the outline
 * @property {string} group Panel group, consecutive entries of one group form a section
 * @property {string} selector What gets moved
 * @property {string} [rule] Narrower selector for the CSS rule
 * @property {string} [setting] Krunker setting that hides it (localStorage kro_setngss_<setting>)
 * @property {string} [clientSetting] Kute setting that hides it, for our own widgets
 * @property {string} [display] Game's display value, used to measure it while hidden
 * @property {[number, number]} [size] Fallback size when it was empty at snapshot time
 * @property {string} [note] Shown next to the name in the panel
 */

/** @type {HudElement[]} */
export const HUD_ELEMENTS = [
    { key: "timer", name: "Timer", group: "Match", selector: "#timerHolder", size: [188, 77] },
    { key: "matchInfo", name: "Mode and map", group: "Match", selector: "#matchInfo", size: [110, 50] },
    { key: "teamScores", name: "Team scores", group: "Match", selector: "#teamScores", display: "block", size: [220, 40], note: "team modes" },
    { key: "rounds", name: "Rounds", group: "Match", selector: "#roundsDisplay", display: "inline-block", size: [200, 60], note: "round based" },
    { key: "zoneCount", name: "Zone count", group: "Match", selector: "#scoreZoneCount", display: "inline-block", size: [57, 43], note: "hardpoint" },
    { key: "lives", name: "Lives", group: "Match", selector: "#livesCount", display: "inline-block", size: [57, 43], note: "LMS, infected" },
    { key: "gameMessage", name: "Match message", group: "Match", selector: "#gameMessage", size: [400, 30] },
    { key: "roundMessage", name: "Round message", group: "Match", selector: "#roundMessage", size: [400, 30] },
    { key: "challenge", name: "Challenge banner", group: "Match", selector: "#chalDisplay", size: [300, 30] },

    { key: "fps", name: "FPS", group: "Stats", selector: "#fpsDisplay", setting: "showFPS", display: "block", size: [72, 23] },
    { key: "ping", name: "Ping", group: "Stats", selector: "#pingDisplay", setting: "showPing", display: "block", size: [72, 23] },
    { key: "kills", name: "Kills", group: "Stats", selector: "#killCount", setting: "showKillC", display: "inline-block", size: [57, 43] },
    { key: "deaths", name: "Deaths", group: "Stats", selector: "#deathCount", setting: "showDeaths", display: "inline-block", size: [57, 43] },
    { key: "streak", name: "Streak", group: "Stats", selector: "#streakCount", setting: "showStreak", display: "inline-block", size: [57, 43] },
    { key: "kd", name: "K/D", group: "Stats", selector: "#kdCount", setting: "showKD", display: "inline-block", size: [77, 43] },
    { key: "score", name: "Score", group: "Stats", selector: "#scoreCount", setting: "showScore", display: "inline-block", size: [57, 43] },
    { key: "speedRun", name: "Parkour timer", group: "Stats", selector: "#speedRunHolder", display: "block", size: [200, 60], note: "parkour" },

    { key: "leaderboard", name: "Leaderboard", group: "Feed", selector: "#leaderboardHolder", size: [327, 54] },
    { key: "centerLeader", name: "Center leaderboard", group: "Feed", selector: "#centerLeaderDisplay", display: "block", size: [300, 120], note: "comp" },
    { key: "killFeed", name: "Kill feed", group: "Feed", selector: "#killFeed", setting: "showKills", display: "inline-grid", size: [240, 120] },
    // chatHolder is also the menu chat, only move the in-game one
    { key: "chat", name: "Chat", group: "Feed", selector: "#chatHolder", rule: "#uiBase.onGame #chatHolder", size: [386, 248] },

    { key: "weapons", name: "Weapons", group: "Combat", selector: "#weapHolder", size: [127, 203] },
    { key: "ammo", name: "Ammo", group: "Combat", selector: "#ammoHolder", size: [148, 63] },
    { key: "perks", name: "Perks", group: "Combat", selector: "#perkHolder", size: [65, 40] },
    { key: "krTag", name: "Deposit coins", group: "Combat", selector: "#krTagHolder", size: [71, 65], note: "deposit" },
    { key: "giftTag", name: "Gift drops", group: "Combat", selector: "#giftTagHolder", size: [65, 65] },
    { key: "powerUps", name: "Powerups", group: "Combat", selector: "#powerUpHolder", size: [65, 65] },
    { key: "killStreak", name: "Kill streak", group: "Combat", selector: "#killStreakHolder", size: [65, 65] },

    { key: "player", name: "Health and class", group: "Player", selector: "#bottomLeftPlayer", size: [376, 90] },
    { key: "zPerks", name: "Class perks", group: "Player", selector: "#zPerksHolder", size: [65, 40] },

    { key: "nuke", name: "Nuke counter", group: "Kute", selector: "#kuteNukeCounter", clientSetting: "nukeCounter", display: "flex", size: [90, 56] },
    { key: "spotify", name: "Spotify", group: "Kute", selector: "#kuteSpotifyOverlay", clientSetting: "spotifyOverlay", display: "flex", size: [320, 82] },
];

/**
 * Reads a krunker setting straight from localStorage, without touching game code.
 *
 * @param {string} key
 * @return {boolean}
 */
export function gameSettingOn(key){
    try {
        return window.localStorage.getItem(`kro_setngss_${key}`) !== "false";
    }
    catch {
        return true;
    }
}
