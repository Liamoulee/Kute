/**
 * The HUD widgets the editor knows about, in panel order.
 *
 * Every id was read off a live match (see _docs/hud-editor-plan.md). A widget whose element is missing is skipped,
 * so a renamed id costs that one row and nothing else.
 *
 * @typedef {object} HudElement
 * @property {string} key Stored in the layout setting, never changes
 * @property {string} name Shown in the panel and on the outline
 * @property {string} group Panel group, consecutive entries of one group form a section
 * @property {string} selector What gets moved
 * @property {string} [rule] The selector the CSS rule is written with, when it has to be narrower than `selector`
 * @property {string} [setting] Krunker setting that hides it (localStorage kro_setngss_<setting>, written with setSetting)
 * @property {string} [clientSetting] Kute setting that hides it, for our own widgets
 * @property {string} [display] The display value the game gives it, needed to show it while its setting hides it
 * @property {[number, number]} [min] Placeholder size in the editor, for widgets that are empty outside a fight
 * @property {string} [note] Shown under the name in the panel
 */

/** @type {HudElement[]} */
export const HUD_ELEMENTS = [
    { key: "timer", name: "Timer", group: "Match", selector: "#timerHolder" },
    { key: "matchInfo", name: "Mode and map", group: "Match", selector: "#matchInfo" },
    { key: "teamScores", name: "Team scores", group: "Match", selector: "#teamScores", display: "block", min: [200, 40], note: "team modes" },
    { key: "rounds", name: "Rounds", group: "Match", selector: "#roundsDisplay", display: "block", min: [200, 60], note: "round based modes" },
    { key: "zoneCount", name: "Zone count", group: "Match", selector: "#scoreZoneCount", display: "inline-block", min: [57, 43], note: "hardpoint, domination" },
    { key: "lives", name: "Lives", group: "Match", selector: "#livesCount", display: "inline-block", min: [57, 43], note: "LMS, infected" },

    { key: "fps", name: "FPS", group: "Stats", selector: "#fpsDisplay", setting: "showFPS", display: "block" },
    { key: "ping", name: "Ping", group: "Stats", selector: "#pingDisplay", setting: "showPing", display: "block" },
    { key: "kills", name: "Kills", group: "Stats", selector: "#killCount", setting: "showKillC", display: "inline-block" },
    { key: "deaths", name: "Deaths", group: "Stats", selector: "#deathCount", setting: "showDeaths", display: "inline-block" },
    { key: "streak", name: "Streak", group: "Stats", selector: "#streakCount", setting: "showStreak", display: "inline-block" },
    { key: "kd", name: "K/D", group: "Stats", selector: "#kdCount", setting: "showKD", display: "inline-block" },
    { key: "score", name: "Score", group: "Stats", selector: "#scoreCount", setting: "showScore", display: "inline-block" },

    { key: "leaderboard", name: "Leaderboard", group: "Feed", selector: "#leaderboardHolder" },
    { key: "killFeed", name: "Kill feed", group: "Feed", selector: "#killFeed", setting: "showKills", display: "inline-grid", min: [240, 120] },
    // the chat holder is the menu's chat as well, so only the in game one is moved
    { key: "chat", name: "Chat", group: "Feed", selector: "#chatHolder", rule: "#uiBase.onGame #chatHolder", min: [300, 100] },

    { key: "weapons", name: "Weapons", group: "Combat", selector: "#weapHolder", min: [127, 200] },
    { key: "ammo", name: "Ammo", group: "Combat", selector: "#ammoHolder" },
    { key: "killStreak", name: "Kill streak", group: "Combat", selector: "#killStreakHolder", min: [40, 40] },
    { key: "powerUps", name: "Powerups", group: "Combat", selector: "#powerUpHolder", min: [40, 40] },

    { key: "player", name: "Health and class", group: "Player", selector: "#bottomLeftPlayer" },
    { key: "perks", name: "Perks", group: "Player", selector: "#zPerksHolder", min: [40, 40] },

    { key: "nuke", name: "Nuke counter", group: "Kute", selector: "#kuteNukeCounter", clientSetting: "nukeCounter", display: "flex" },
];

/** Krunker's master switch for the whole HUD, a row of its own in the panel. */
export const SHOW_UI_SETTING = "showUI";

/**
 * Reads a Krunker setting the way the game stores it, without asking the game for it.
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
