import { kute } from "../../client.js";

kute.userscriptManager = {
    open: () => {
        import("./userscripts.js").then((module) => module.open()).catch((error) => console.error("[kute] userscript manager:", error));
    },
};
kute.swapperManager = {
    open: () => {
        import("./swapper.js").then((module) => module.open()).catch((error) => console.error("[kute] swapper manager:", error));
    },
};
