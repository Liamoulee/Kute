export default {
    server: {
        port: "3030",
    },
    clan_tag_colors: {},
    developers: {} as Record<string, { token: string, clan: string }>,
    krunker_api_token: "",
    market: {
        // the sweeps that fill data/market.db; off in development unless collector_in_dev is set
        collector: true,
        collector_in_dev: false,
        // the owner decided 5 was overkill, four samples an hour is plenty for hourly candles
        stats_sweep_minutes: 15,
        // hour of the daily developer history sweep in `timezone`, the owner's quiet window is 04:00 to 05:00 CEST
        history_sweep_hour: 4,
        timezone: "Europe/Berlin",
        // the share of the key's 240 a minute the sweeps may use, the rest stays for live views
        key_budget_per_minute: 120,
    },
    log_webhook: "",
};
