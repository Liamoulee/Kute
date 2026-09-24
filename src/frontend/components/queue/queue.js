// runs inside the about:blank queue popup as script text, so no imports. input comes via window.info.
// shares the game's main thread, keep it light

(() => {
    /**
     * @typedef {object} QueueInfo from externalQueue.js
     * @property {string} token krunker auth token
     * @property {string} region "na", "eu" or "as"
     * @property {boolean} allRegions
     * @property {string} sound match found sound, base64
     */

    const { info } = /** @type {Window & { info: QueueInfo }} */ (/** @type {unknown} */ (window));

    /**
     * @template {HTMLElement} [T=HTMLElement]
     * @param {string} selector
     * @return {T} part of index.html, a miss is a bug
     */
    function must(selector){
        const element = document.querySelector(selector);
        if (!element) throw new Error(`queue window: ${selector} is missing`);
        return /** @type {T} */ (element);
    }

    const MAPS = {
        sandstorm_v3: { url: "https://assets.krunker.io/img/maps/map_2.png", number: 2 },
        undergrowth: { url: "https://assets.krunker.io/img/maps/map_4.png", number: 4 },
        industry: { url: "https://assets.krunker.io/img/maps/map_11.png", number: 11 },
        site: { url: "https://assets.krunker.io/img/maps/map_14.png", number: 14 },
        bureau: { url: "https://assets.krunker.io/img/maps/map_17.png", number: 17 },
        burg_new: { url: "https://assets.krunker.io/img/maps/map_0.png", number: 0 },
        eterno_sim: { url: "https://assets.krunker.io/img/maps/map_39.png", number: 39 },
    };
    const REGION_NAMES = /** @type {Record<string, string>} */ ({ na: "North America", eu: "Europe", as: "Asia" });
    const ACCEPT_SECONDS = 60;

    const queueStatus = must("#queueStatus");
    const statusArea = must("#statusArea");
    const queueTimerDisplay = must("#queueTimerDisplay");
    const regionSelectors = must("#regionCheckboxes");
    const matchPopupOverlay = must("#matchPopupOverlay");
    const countdownTimer = must("#countDownTimer");
    const foundRegion = must("#foundRegion");
    const mapSelectorButton = must("#mapSelectorButton");
    const mapSelectorOverlay = must("#mapSelectorOverlay");
    const closeMapSelectorButton = must("#closeMapSelector");
    const mapGrid = must("#mapGrid");
    const queueButton = /** @type {HTMLButtonElement} */ (must("#queueButton"));
    const closeButton = must("#closeButton");

    let isQueued = false;
    let isConnecting = false;
    let queueStartTime = 0;
    let queueInterval = 0;
    let countdownInterval = 0;
    /** @type {WebSocket | null} */
    let queueConnection = null;
    /** @type {AudioContext | null} */
    let audioContext = null;
    /** @type {AudioBuffer | null} */
    let notificationBuffer = null;
    /** @type {AudioBufferSourceNode | null} */
    let currentSource = null;
    /** @type {Set<number>} */
    const selectedMaps = new Set();

    // stored on the game page, survives the popup
    const storage = window.opener?.localStorage ?? window.localStorage;

    function saveSettings(){
        const regions = Array.from(regionSelectors.querySelectorAll("input:checked"), (checkbox) => checkbox.id);
        storage.setItem("queue_selectedRegions", JSON.stringify(regions));
        storage.setItem("queue_newSelectedMaps", JSON.stringify(Array.from(selectedMaps)));
    }

    function loadSettings(){
        try {
            for (const regionId of JSON.parse(storage.getItem("queue_selectedRegions") ?? "[]")){
                const checkbox = /** @type {HTMLInputElement | null} */ (document.getElementById(regionId));
                if (checkbox) checkbox.checked = true;
            }
            const savedMaps = storage.getItem("queue_newSelectedMaps");
            // nothing saved = every map
            for (const number of savedMaps ? JSON.parse(savedMaps) : Object.values(MAPS).map((map) => map.number)) selectedMaps.add(Number(number));
        }
        catch {
            for (const map of Object.values(MAPS)) selectedMaps.add(map.number);
        }
    }

    /**
     * @param {number} seconds
     * @return {string} hh:mm:ss
     */
    function formatTime(seconds){
        const pad = (/** @type {number} */ value) => String(Math.floor(value)).padStart(2, "0");
        return `${pad(seconds / 3600)}:${pad((seconds % 3600) / 60)}:${pad(seconds % 60)}`;
    }

    /**
     * @param {boolean} active shows "in queue"
     * @param {string} text
     */
    function showStatus(active, text){
        queueStatus.textContent = text;
        queueStatus.classList.toggle("active", active);
        statusArea.classList.toggle("active", active);
    }

    /**
     * @param {string} [text]
     */
    function showIdle(text = "Ready"){
        isQueued = false;
        isConnecting = false;
        clearInterval(queueInterval);
        queueButton.textContent = "Start Queue";
        queueButton.classList.remove("in-queue");
        queueButton.disabled = false;
        queueTimerDisplay.textContent = "00:00:00";
        showStatus(false, text);
    }

    // decode the sound on the first "Start Queue" click, AudioContext wants a gesture anyway

    async function initializeAudio(){
        audioContext = new AudioContext();
        if (audioContext.state === "suspended") await audioContext.resume();
        const bytes = Uint8Array.from(atob(info.sound), (char) => char.charCodeAt(0));
        notificationBuffer = await audioContext.decodeAudioData(bytes.buffer);
    }

    function stopNotificationSound(){
        if (!currentSource) return;
        currentSource.stop();
        currentSource.disconnect();
        currentSource = null;
    }

    function playNotificationSound(){
        if (!notificationBuffer || audioContext?.state !== "running") return;
        stopNotificationSound();
        const source = audioContext.createBufferSource();
        source.buffer = notificationBuffer;
        source.connect(audioContext.destination);
        source.start(0);
        currentSource = source;
        source.onended = () => {
            if (currentSource === source) currentSource = null;
            source.disconnect();
        };
    }

    /**
     * @param {number} milliseconds
     */
    function showCooldown(milliseconds){
        const endTime = Date.now() + milliseconds;
        const update = () => {
            const remaining = Math.ceil((endTime - Date.now()) / 1000);
            if (remaining <= 0){
                showStatus(false, "Ready");
                queueButton.disabled = false;
                return;
            }
            showStatus(false, `Cooldown: ${formatTime(remaining)}`);
            queueButton.disabled = true;
            setTimeout(update, 1000);
        };
        update();
    }

    /**
     * @param {string} map map number
     * @param {string} region two chars, then "na", "eu" or "as"
     */
    function matchFound(map, region){
        playNotificationSound();
        matchPopupOverlay.classList.add("active");

        const mapName = Object.entries(MAPS).find(([, data]) => data.number === Number.parseInt(map, 10))?.[0] ?? "unknown";
        const regionName = REGION_NAMES[region.slice(2)] ?? region.slice(2);
        foundRegion.textContent = `${regionName}, ${mapName}`;

        const startTime = Date.now();
        clearInterval(countdownInterval);
        countdownInterval = setInterval(() => {
            const remaining = Math.max(0, ACCEPT_SECONDS - Math.floor((Date.now() - startTime) / 1000));
            countdownTimer.textContent = formatTime(remaining);
            if (remaining <= 0){
                clearInterval(countdownInterval);
                matchPopupOverlay.classList.remove("active");
            }
        }, 1000);

        showIdle();
    }

    function startQueue(){
        const regions = Array.from(/** @type {NodeListOf<HTMLInputElement>} */ (regionSelectors.querySelectorAll("input:checked")), (input) => input.value);
        if (regions.length === 0 || selectedMaps.size === 0){
            showIdle(regions.length === 0 ? "Select at least one region" : "Select at least one map");
            return;
        }

        const url = `wss://gamefrontend.svc.krunker.io/v1/matchmaking/queue?token=${info.token}&maps=${Array.from(selectedMaps).join(",")}&regions=${regions.join(",")}`;
        /** @type {WebSocket} */
        let connection;
        try {
            connection = new WebSocket(url);
        }
        catch {
            showIdle("Connection failed");
            return;
        }
        queueConnection = connection;

        connection.onerror = () => showIdle("Connection error");
        connection.onclose = () => {
            // cooldown or match found already set their text
            if (isQueued || isConnecting) showIdle();
        };
        connection.onopen = () => {
            isQueued = true;
            isConnecting = false;
            queueStartTime = Date.now();
            queueButton.textContent = "Leave Queue";
            queueButton.classList.add("in-queue");
            queueButton.disabled = false;
            showStatus(true, "In queue");
            queueTimerDisplay.textContent = formatTime(0);
            queueInterval = setInterval(() => {
                queueTimerDisplay.textContent = formatTime((Date.now() - queueStartTime) / 1000);
            }, 1000);
        };
        connection.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === "QUEUE_STATUS" && data.payload?.status === "MATCHED"){
                const found = data.payload.assignment.extensions;
                matchFound(String(found.map).trim(), String(found.region));
            }
            else if (data.type === "ERROR" && data.payload?.code === "COOLDOWN"){
                showIdle();
                connection.close();
                showCooldown(Number(data.payload.payload.cooldown));
            }
            else if (data.type === "INTERNAL_ERROR"){
                showIdle();
                connection.close();
            }
        };
    }

    /**
     * @param {number} mapNumber
     */
    function toggleMapSelection(mapNumber){
        const selected = !selectedMaps.has(mapNumber);
        if (selected) selectedMaps.add(mapNumber);
        else selectedMaps.delete(mapNumber);
        mapGrid.querySelector(`.map-item[data-map="${mapNumber}"]`)?.classList.toggle("selected", selected);

        // maps are sent on connect, changing them means requeueing
        if (isQueued) queueConnection?.close();
        saveSettings();
    }

    function buildMapGrid(){
        mapGrid.replaceChildren();
        for (const [mapName, data] of Object.entries(MAPS)){
            const item = document.createElement("div");
            item.className = "map-item";
            item.dataset.map = String(data.number);
            item.classList.toggle("selected", selectedMaps.has(data.number));
            const img = document.createElement("img");
            img.src = data.url;
            img.loading = "lazy";
            const label = document.createElement("span");
            label.textContent = mapName;
            item.append(img, label);
            item.onclick = () => toggleMapSelection(data.number);
            mapGrid.append(item);
        }
    }

    loadSettings();
    // ranked menu region beats the saved one
    const preset = /** @type {HTMLInputElement | null} */ (info.region ? document.getElementById(info.region) : null);
    if (preset) preset.checked = true;
    buildMapGrid();

    mapSelectorButton.onclick = () => mapSelectorOverlay.classList.add("active");
    closeMapSelectorButton.onclick = () => mapSelectorOverlay.classList.remove("active");
    mapSelectorOverlay.onclick = (event) => {
        if (event.target === mapSelectorOverlay) mapSelectorOverlay.classList.remove("active");
    };

    queueButton.onclick = async() => {
        if (isConnecting) return;
        if (isQueued){
            queueConnection?.close();
            return;
        }
        queueButton.disabled = true;
        isConnecting = true;
        try {
            if (!notificationBuffer) await initializeAudio();
        }
        catch {
            // queue anyway without sound
        }
        startQueue();
    };

    closeButton.onclick = () => {
        clearInterval(countdownInterval);
        matchPopupOverlay.classList.remove("active");
        stopNotificationSound();
    };

    // regions are sent on connect too
    const regionChanged = () => {
        if (isQueued) queueConnection?.close();
        saveSettings();
    };
    for (const input of regionSelectors.querySelectorAll("input")) input.onclick = regionChanged;
})();
