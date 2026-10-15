import type { KrunkerClient } from "../../client";
import * as check from "../../validate";
import { KrunkerArgumentError } from "../../errors";
import { unwrap } from "../client";
import type {
    ClanLeaderboardRow,
    ClanLeaderboardSort,
    Envelope,
    KrunkCupPlayerRow,
    KrunkCupTeam,
    PlayerLeaderboardRow,
    PlayerLeaderboardType,
    RaidLeaderboardRow,
    RaidSort,
} from "../types";

// ========================= //
// = Copyright (c) NullDev = //
// =  All rights reserved  = //
// ========================= //

/** map ids with a raid board (owner, 2026-10-15); not enforced, a new raid map must keep working */
export const RAID_MAPS = [18, 29, 31, 35, 43] as const;

const PLAYER_TYPES: ReadonlySet<string> = new Set([
    "player_score", "player_kills", "player_wins", "player_timeplayed", "player_funds", "player_followed",
    "player_nukes", "player_skinvalue", "player_eventcount", "player_ranked_matches",
]);

function raidSort(sort: RaidSort | undefined): RaidSort | undefined {
    if (sort === undefined) return undefined;
    if (sort !== "time" && sort !== "completions") throw new KrunkerArgumentError(`sort must be "time" or "completions", got ${String(sort)}`);
    return sort;
}

export type PlayerLeaderboardQuery = { sort?: string; season?: number };

export class PublicLeaderboardsApi {
    readonly #gapi: KrunkerClient;

    constructor(gapi: KrunkerClient){
        this.#gapi = gapi;
    }

    /** GET /leaderboards/:type, 100 rows */
    players(type: PlayerLeaderboardType, query: PlayerLeaderboardQuery = {}): Promise<PlayerLeaderboardRow[]> {
        if (!PLAYER_TYPES.has(type)) throw new KrunkerArgumentError(`unknown leaderboard type ${String(type)}`);
        return unwrap(this.#gapi.get<Envelope<PlayerLeaderboardRow[]>>(`/leaderboards/${type}`, {
            route: "public.leaderboards.players",
            query: { sort: query.sort, season: check.optionalInt(query.season, "season", 0) },
        }));
    }

    /** GET /leaderboards/player_clan, 100 rows */
    clans(sort: ClanLeaderboardSort = "score"): Promise<ClanLeaderboardRow[]> {
        if (sort !== "score" && sort !== "members") throw new KrunkerArgumentError(`sort must be "score" or "members", got ${String(sort)}`);
        return unwrap(this.#gapi.get<Envelope<ClanLeaderboardRow[]>>("/leaderboards/player_clan", { route: "public.leaderboards.clans", query: { sort } }));
    }

    /** GET /leaderboards/raids/:mapId, 100 rows, 400 "invalid raid map ID" for a map without raids (31 has them) */
    raids(mapId: number, sort?: RaidSort): Promise<RaidLeaderboardRow[]> {
        return unwrap(this.#gapi.get<Envelope<RaidLeaderboardRow[]>>(`/leaderboards/raids/${check.int(mapId, "mapId", 0)}`, {
            route: "public.leaderboards.raids",
            query: { sort: raidSort(sort) },
        }));
    }

    /** GET /leaderboards/raids/:mapId/monthly, month is required, data is null for a month without runs */
    async raidsMonthly(mapId: number, month: number, sort?: RaidSort): Promise<RaidLeaderboardRow[]> {
        const rows = await unwrap(this.#gapi.get<Envelope<RaidLeaderboardRow[] | null>>(`/leaderboards/raids/${check.int(mapId, "mapId", 0)}/monthly`, {
            route: "public.leaderboards.raidsMonthly",
            query: { month: check.int(month, "month", 1, 12), sort: raidSort(sort) },
        }));
        return rows ?? [];
    }

    /** GET /leaderboards/krunkcup/teams */
    krunkCupTeams(): Promise<KrunkCupTeam[]> {
        return unwrap(this.#gapi.get<Envelope<KrunkCupTeam[]>>("/leaderboards/krunkcup/teams", { route: "public.leaderboards.krunkCupTeams" }));
    }

    /** GET /leaderboards/krunkcup/teams/:id/contributors */
    krunkCupContributors(teamId: number): Promise<KrunkCupPlayerRow[]> {
        return unwrap(this.#gapi.get<Envelope<KrunkCupPlayerRow[]>>(`/leaderboards/krunkcup/teams/${check.int(teamId, "teamId", 0)}/contributors`, { route: "public.leaderboards.krunkCupContributors" }));
    }

    /** GET /leaderboards/krunkcup/players */
    krunkCupPlayers(limit?: number): Promise<KrunkCupPlayerRow[]> {
        return unwrap(this.#gapi.get<Envelope<KrunkCupPlayerRow[]>>("/leaderboards/krunkcup/players", {
            route: "public.leaderboards.krunkCupPlayers",
            query: { limit: check.optionalInt(limit, "limit", 1) },
        }));
    }
}
