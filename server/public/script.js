const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const reveals = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".reveal"));

if (reduceMotion || !("IntersectionObserver" in window)){
    reveals.forEach((element) => element.classList.add("is-visible"));
}
else {
    const revealObserver = new IntersectionObserver(
        (entries, observer) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                entry.target.classList.add("is-visible");
                observer.unobserve(entry.target);
            });
        },
        { threshold: 0.1, rootMargin: "0px 0px -5% 0px" },
    );

    reveals.forEach((element, index) => {
        element.style.transitionDelay = `${Math.min(index % 4, 3) * 70}ms`;
        revealObserver.observe(element);
    });
}

const machine = document.querySelector(".hero-machine");

if (machine instanceof HTMLElement && !reduceMotion && window.matchMedia("(pointer: fine)").matches){
    machine.addEventListener("pointermove", (event) => {
        const bounds = machine.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width - 0.5;
        const y = (event.clientY - bounds.top) / bounds.height - 0.5;
        machine.style.setProperty("--mouse-x", `${x * 8}px`);
        machine.style.setProperty("--mouse-y", `${y * 8}px`);
    });

    machine.addEventListener("pointerleave", () => {
        machine.style.setProperty("--mouse-x", "0px");
        machine.style.setProperty("--mouse-y", "0px");
    });
}

document.querySelectorAll(".marquee-track").forEach((track) => {
    [...track.children].forEach((item) => {
        const copy = /** @type {HTMLElement} */ (item.cloneNode(true));
        copy.setAttribute("aria-hidden", "true");
        track.append(copy);
    });
});

let featureNumber = 0;
document.querySelectorAll(".feature-group").forEach((group) => {
    const rows = group.querySelectorAll(":scope > div");
    rows.forEach((row) => {
        featureNumber++;
        const label = row.querySelector("span");
        if (label) label.textContent = String(featureNumber).padStart(2, "0");
    });
    const count = document.querySelector(`.feature-index a[href="#${group.id}"] i`);
    if (count) count.textContent = String(rows.length);
});

const indexLinks = document.querySelectorAll(".feature-index a");
if (indexLinks.length > 0 && "IntersectionObserver" in window){
    const groupObserver = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                indexLinks.forEach((link) => link.classList.toggle("is-active", link.getAttribute("href") === `#${entry.target.id}`));
            });
        },
        { rootMargin: "-45% 0px -50% 0px" },
    );
    document.querySelectorAll(".feature-group").forEach((group) => groupObserver.observe(group));
}

const statusBox = document.querySelector("[data-status]");
const statusText = document.querySelector("[data-status-text]");
const versionLabel = document.querySelector("[data-version-label]");

/**
 * @param {number} count
 * @return {string}
 */
const formatCount = (count) => new Intl.NumberFormat("en-US").format(count);

const updateStatus = async() => {
    try {
        const response = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(String(response.status));
        /** @type {{client?: string | null, players?: {online?: number}}} */
        const health = await response.json();

        const parts = [];
        if (health.client) parts.push(`BUILD ${health.client}`);
        parts.push(`${formatCount(health.players?.online ?? 0)} ONLINE`);
        if (statusText) statusText.textContent = parts.join(" / ");
        statusBox?.classList.remove("is-offline");
        if (versionLabel && health.client) versionLabel.textContent = `[ VERSION ${health.client} ]`;
    }
    catch {
        if (statusText) statusText.textContent = "SERVER OFFLINE";
        statusBox?.classList.add("is-offline");
    }
};

updateStatus();
setInterval(() => {
    if (document.visibilityState === "visible") updateStatus();
}, 60_000);

const lightbox = /** @type {HTMLDialogElement | null} */ (document.querySelector(".lightbox"));
const stage = lightbox?.querySelector("[data-lightbox-stage]");
const titleLabel = lightbox?.querySelector("[data-lightbox-title]");
const countLabel = lightbox?.querySelector("[data-lightbox-count]");
const cards = /** @type {HTMLElement[]} */ ([...document.querySelectorAll(".screen-card[data-src]")]);

let current = 0;
let zoom = 1;
/** @type {HTMLImageElement | HTMLVideoElement | null} */
let media = null;

const applyZoom = () => {
    media?.style.setProperty("--zoom", zoom.toFixed(2));
};

/**
 * @param {number} index
 */
const show = (index) => {
    if (!lightbox || !stage || cards.length === 0) return;
    current = (index + cards.length) % cards.length;
    const card = cards[current];
    const src = card.dataset.src ?? "";

    media?.remove();
    if (src.endsWith(".mp4")){
        const video = document.createElement("video");
        video.src = src;
        if (card.dataset.poster) video.poster = card.dataset.poster;
        video.autoplay = true;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.controls = true;
        media = video;
    }
    else {
        const image = document.createElement("img");
        image.src = src;
        image.alt = card.querySelector("img")?.alt ?? "";
        media = image;
    }
    stage.prepend(media);

    zoom = 1;
    applyZoom();
    if (titleLabel) titleLabel.textContent = (card.dataset.title ?? "").toUpperCase();
    if (countLabel) countLabel.textContent = `${current + 1} / ${cards.length}`;
};

cards.forEach((card, index) => {
    card.addEventListener("click", () => {
        if (!lightbox) return;
        show(index);
        lightbox.showModal();
        document.body.classList.add("lightbox-open");
    });
});

lightbox?.querySelector("[data-lightbox-close]")?.addEventListener("click", () => lightbox.close());
lightbox?.querySelector("[data-lightbox-prev]")?.addEventListener("click", () => show(current - 1));
lightbox?.querySelector("[data-lightbox-next]")?.addEventListener("click", () => show(current + 1));

lightbox?.addEventListener("click", (event) => {
    if (event.target === lightbox) lightbox.close();
});

lightbox?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") show(current - 1);
    else if (event.key === "ArrowRight") show(current + 1);
});

lightbox?.addEventListener("close", () => {
    document.body.classList.remove("lightbox-open");
    media?.remove();
    media = null;
});

stage?.addEventListener(
    "wheel",
    (event) => {
        if (!(media instanceof HTMLImageElement)) return;
        const wheel = /** @type {WheelEvent} */ (event);
        wheel.preventDefault();
        // zooms towards the pointer, the stage does not scroll
        const bounds = media.getBoundingClientRect();
        const x = Math.min(100, Math.max(0, ((wheel.clientX - bounds.left) / bounds.width) * 100));
        const y = Math.min(100, Math.max(0, ((wheel.clientY - bounds.top) / bounds.height) * 100));
        if (zoom === 1) media.style.transformOrigin = `${x}% ${y}%`;
        zoom = Math.min(3, Math.max(1, zoom + (wheel.deltaY < 0 ? 0.2 : -0.2)));
        applyZoom();
    },
    { passive: false },
);

const greeter = () => {
    const W = 38;
    /**
     * @param {string} s
     * @return {string}
     */
    const center = (s) => {
        const pad = Math.max(0, W - s.length);
        const l = Math.floor(pad / 2);
        return " ".repeat(l) + s + " ".repeat(pad - l);
    };

    const padRight = (/** @type {string | any[]} */ s, /** @type {number} */ w) => s + " ".repeat(Math.max(0, w - s.length - 2));
    const padLeft = (/** @type {string | any[]} */ s, /** @type {number} */ w) => " ".repeat(Math.max(0, w - s.length)) + s;

    const welcome = center("★ Hellow curious cat! ★");
    const leftW = Math.floor(W / 2);
    const rightW = W - leftW;
    const bugLeft = padRight("  Stay fresh & cute!", leftW);
    const bugRight = padLeft("You are loved  ", rightW);

    const baseFont = "font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.25;";

    console.log(
        `%c${welcome}%c\n%c${bugLeft}%c${bugRight}`,
        `${baseFont}color: #1a1a1a;background: #83fffc;font-weight:bold;padding:6px 0;border:1px solid #83fffc;border-bottom:none;border-radius:6px 6px 0 0;`,
        `${baseFont}border:none;background:transparent;padding:0;`,
        `${baseFont}color: #fff;background: #1a1a1a;padding:6px 0;border:1px solid #83fffc;border-top:none;border-right:none;border-radius:0 0 0 6px;`,
        `${baseFont}color: #83fffc;background: #1a1a1a;font-weight:bold;padding:6px 0;border:1px solid #83fffc;border-top:none;border-left:none;border-radius:0 0 6px 0;`,
    );
};

(() => greeter())();
