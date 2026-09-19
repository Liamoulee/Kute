const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const reveals = document.querySelectorAll(".reveal");

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
        { threshold: 0.14, rootMargin: "0px 0px -7% 0px" },
    );

    reveals.forEach((element, index) => {
        element.style.transitionDelay = `${Math.min(index % 4, 3) * 70}ms`;
        revealObserver.observe(element);
    });
}

const machine = document.querySelector(".hero-machine");

if (machine && !reduceMotion && window.matchMedia("(pointer: fine)").matches){
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

const lightbox = document.querySelector(".lightbox");
const lightboxStage = lightbox?.querySelector(".lightbox-stage");
const lightboxImage = lightbox?.querySelector("img");
const closeLightbox = lightbox?.querySelector(".lightbox-head button");
let zoom = 1;

const applyZoom = () => {
    lightboxImage?.style.setProperty("--zoom", zoom.toFixed(2));
};

document.querySelectorAll(".screen-card").forEach((card) => {
    card.addEventListener("click", () => {
        if (!lightbox) return;
        zoom = 1;
        applyZoom();
        lightbox.showModal();
        document.body.classList.add("lightbox-open");
    });
});

closeLightbox?.addEventListener("click", () => lightbox?.close());

lightbox?.addEventListener("click", (event) => {
    if (event.target === lightbox) lightbox.close();
});

lightbox?.addEventListener("close", () => {
    document.body.classList.remove("lightbox-open");
    zoom = 1;
    applyZoom();
});

lightboxStage?.addEventListener(
    "wheel",
    (event) => {
        event.preventDefault();
        zoom = Math.min(2.4, Math.max(0.75, zoom + (event.deltaY < 0 ? 0.12 : -0.12)));
        applyZoom();
    },
    { passive: false },
);
