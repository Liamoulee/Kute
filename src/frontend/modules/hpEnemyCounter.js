/**
 * Shows how many objective points the enemy team just gained next to the score counters in comp matches.
 */
class HpEnemyCounter {
    constructor(){
        /** @type {HTMLDivElement} */
        this.numberDisplay = document.createElement("div");
        this.numberDisplay.id = "hpEnemyCounter";
        this.numberDisplay.classList.add("statIcon");
        this.numberDisplay.style.cssText = "inline-block; transform: translate(0, -2.7px);";
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
         * Sets up the display once a comp match is detected.
         *
         * @param {MessageEvent} event
         */
        this.gameUpdateListener = (event) => {
            if (event.data === "game-updated"){
                setTimeout(() => {
                    if (window.checkCompMode()){
                        window.chrome.webview.removeEventListener("message", this.gameUpdateListener);

                        this.setupDisplay();
                    }
                }, 2000);
            }
        };
        window.kute.settings.toggleHpEnemyCounter = (enabled) => this.toggle(enabled);
        this.toggle(true);
    }
    /**
     * @param {boolean} enabled
     */
    toggle(enabled){
        if (enabled){
            window.chrome.webview.addEventListener("message", this.gameUpdateListener);
            if (window.checkCompMode()){
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

    /**
     * Compares the enemy score against the last seen value and shows the difference briefly.
     */
    processTeamScores = () => {
        const {pointCounter} = this;
        if (!pointCounter) return;
        for (const team of document.querySelectorAll("#tScoreC1, #tScoreC2")){
            if (team && !team.className.includes("you")){
                const scoreElement = /** @type {HTMLElement|null} */ (team.nextElementSibling);
                if (!scoreElement) continue;
                const currentEnemyOBJ = Number.parseInt(scoreElement.innerText, 10);
                if (currentEnemyOBJ > this.enemyOBJ){
                    pointCounter.innerText = String((currentEnemyOBJ - this.enemyOBJ) / 10);
                    if (this.enemyTimeout) clearTimeout(this.enemyTimeout);
                    this.enemyTimeout = setTimeout(() => {
                        pointCounter.innerText = "0";
                        this.enemyTimeout = null;
                    }, 1600);
                }
                this.enemyOBJ = currentEnemyOBJ;
            }
        }
    };

    /**
     * Appends the counter to the top right counters and starts observing the team scores.
     */
    setupDisplay(){
        const pointCounter = getElement(".pointVal", this.numberDisplay);
        this.pointCounter = pointCounter;
        getElement(".topRightCounters").append(this.numberDisplay);

        // re-enabling must not stack a second observer
        this.observer?.disconnect();
        this.observer = new MutationObserver(this.processTeamScores);
        this.observer.observe(getElement("#teamScores"), {
            childList: true,
            subtree: true,
        });
    }
}

export default new HpEnemyCounter();
