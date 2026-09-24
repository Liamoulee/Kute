import { kute } from "../client.js";
import { getElement, checkCompMode } from "../utils.js";

// hardpoint, comp only: points the enemy just gained, next to the score counters
class HpEnemyCounter {
    constructor(){
        /** @type {HTMLDivElement} */
        this.numberDisplay = document.createElement("div");
        this.numberDisplay.id = "hpEnemyCounter";
        this.numberDisplay.classList.add("statIcon");
        this.numberDisplay.style.cssText = "transform: translate(0, -2.7px);";
        this.numberDisplay.innerHTML = `
            <div class="greyInner" style="display: flex">
                <span style="color:white; font-size:15px; margin-right: 4px;">on</span>
                <span id="myScoreVal" class="pointVal">0</span>
            </div>`;

        /** @type {number} */
        this.enemyOBJ = 0;
        /** @type {number|null} */
        this.enemyTimeout = null;
        /** @type {MutationObserver|null} */
        this.observer = null;
        /** @type {HTMLElement|null} */
        this.pointCounter = null;
        /**
         * @param {MessageEvent} event
         */
        this.gameUpdateListener = (event) => {
            if (event.data === "game-updated"){
                setTimeout(() => {
                    if (checkCompMode()){
                        window.chrome.webview.removeEventListener("message", this.gameUpdateListener);

                        this.setupDisplay();
                    }
                }, 2000);
            }
        };
        kute.settings.toggleHpEnemyCounter = (enabled) => this.toggle(enabled);
        this.toggle(true);
    }
    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        if (enabled){
            window.chrome.webview.addEventListener("message", this.gameUpdateListener);
            if (checkCompMode()){
                window.chrome.webview.removeEventListener("message", this.gameUpdateListener);
                this.setupDisplay();
            }
        }
        else {
            window.chrome.webview.removeEventListener("message", this.gameUpdateListener);
            this.observer?.disconnect();
            this.numberDisplay.remove();
        }
    }

    processTeamScores = () => {
        const {pointCounter} = this;
        if (!pointCounter) return;
        for (const team of document.querySelectorAll("#tScoreC1, #tScoreC2")){
            if (team && !team.className.includes("you")){
                const scoreElement = /** @type {HTMLElement|null} */ (team.nextElementSibling);
                if (!scoreElement) continue;
                // not innerText, that forces layout mid match
                const currentEnemyOBJ = Number.parseInt(scoreElement.textContent ?? "", 10);
                if (Number.isNaN(currentEnemyOBJ)) continue;
                if (currentEnemyOBJ > this.enemyOBJ){
                    pointCounter.textContent = String((currentEnemyOBJ - this.enemyOBJ) / 10);
                    if (this.enemyTimeout) clearTimeout(this.enemyTimeout);
                    this.enemyTimeout = setTimeout(() => {
                        pointCounter.textContent = "0";
                        this.enemyTimeout = null;
                    }, 1600);
                }
                this.enemyOBJ = currentEnemyOBJ;
            }
        }
    };

    setupDisplay(){
        const pointCounter = getElement(".pointVal", this.numberDisplay);
        this.pointCounter = pointCounter;
        getElement(".topRightCounters").append(this.numberDisplay);

        // don't stack observers on re-enable
        this.observer?.disconnect();
        this.observer = new MutationObserver(this.processTeamScores);
        this.observer.observe(getElement("#teamScores"), {
            childList: true,
            subtree: true,
        });
    }
}

export default new HpEnemyCounter();
