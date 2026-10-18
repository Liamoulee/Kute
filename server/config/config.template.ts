export default {
    server: {
        port: "3030",
    },
    clan_tag_colors: {},
    developers: {} as Record<string, { token: string, clan: string }>,
    krunker_api_token: "",
    krunker_api_proxy: "",
    market: {
        collector: true,
        collector_in_dev: false,
        stats_sweep_minutes: 15,
        history_sweep_hour: 4,
        timezone: "Europe/Berlin",
        key_budget_per_minute: 120,
        attest_master: "",
        attest_min_version: "0.0.0",
    },
    log_webhook: "",
};
