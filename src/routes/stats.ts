import { Router, Request, Response } from 'express';
import axios from 'axios';
import { authenticateToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/adminAuth';
import db from '../db';

const router = Router();

const ESPN_CORE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world';
const ESPN_SITE = 'https://site.web.api.espn.com/apis/v2/sports/soccer/fifa.world';

// 5-minute in-memory cache
let cache: { data: TournamentStats; cachedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface PlayerLeader {
    rank: number;
    value: number;
    displayValue: string;
    name: string;
    shortName: string;
    country: string;
    flagUrl: string | null;
    headshotUrl: string | null;
}

interface StatCategory {
    name: string;
    displayName: string;
    leaders: PlayerLeader[];
}

interface GroupEntry {
    rank: number;
    team: string;
    flagUrl: string | null;
    played: number;
    wins: number;
    draws: number;
    losses: number;
    gf: number;
    ga: number;
    gd: string;
    points: number;
    advanced: boolean;
}

interface Group {
    name: string;
    entries: GroupEntry[];
}

interface TournamentStats {
    categories: StatCategory[];
    groups: Group[];
    fetchedAt: string;
}

async function fetchJson(url: string): Promise<any> {
    try {
        const { data } = await axios.get(url, { timeout: 5000 });
        return data;
    } catch {
        return null;
    }
}

async function resolveAthleteRef(ref: string): Promise<{ name: string; shortName: string; country: string; flagUrl: string | null; headshotUrl: string | null }> {
    const data = await fetchJson(ref);
    if (!data) return { name: '?', shortName: '?', country: '?', flagUrl: null, headshotUrl: null };

    const name = data.displayName ?? data.fullName ?? '?';
    const shortName = data.shortName ?? name;
    const country = data.citizenship ?? data.citizenshipCountry?.displayName ?? '?';

    // Only use headshot if ESPN explicitly provides it — don't guess CDN URLs
    // (ESPN soccer headshots only exist for a small subset of players)
    const headshotUrl = data.headshot?.href ?? null;

    let flagUrl: string | null = null;
    if (data.flag?.href) flagUrl = data.flag.href;
    else if (data.citizenship) {
        const code = (data.citizenship as string).toLowerCase().replace(/\s+/g, '-');
        flagUrl = `https://a.espncdn.com/i/teamlogos/countries/500/${code}.png`;
    }

    return { name, shortName, country, flagUrl, headshotUrl };
}

async function buildLeaders(): Promise<StatCategory[]> {
    const data = await fetchJson(`${ESPN_CORE}/seasons/2026/types/0/leaders?limit=10&lang=en`);
    if (!data) return [];

    // Category display names we want (de-duplicate — ESPN returns goalsLeaders + goals both)
    const WANTED: Record<string, string> = {
        goals: '⚽ Top Scorers',
        assists: '🎯 Top Assists',
        shotsOnTarget: '🎯 Shots on Target',
        yellowCards: '🟨 Yellow Cards',
        redCards: '🟥 Red Cards',
        foulsCommitted: '🦵 Fouls Committed',
        saves: '🧤 Most Saves',
    };

    const seen = new Set<string>();
    const categories: StatCategory[] = [];

    for (const cat of (data.categories ?? [])) {
        const key = cat.name as string;
        if (!WANTED[key] || seen.has(key)) continue;
        seen.add(key);

        const leaders: PlayerLeader[] = [];
        let rank = 1;

        for (const leader of (cat.leaders ?? []).slice(0, 10)) {
            const ref: string = leader.athlete?.$ref ?? '';
            if (!ref) continue;
            const athlete = await resolveAthleteRef(ref);
            leaders.push({
                rank: rank++,
                value: leader.value ?? 0,
                displayValue: leader.displayValue ?? String(leader.value ?? 0),
                ...athlete,
            });
        }

        categories.push({ name: key, displayName: WANTED[key], leaders });
    }

    return categories;
}

async function buildGroups(): Promise<Group[]> {
    const data = await fetchJson(`${ESPN_SITE}/standings?season=2026&seasontype=1`);
    if (!data) return [];

    const groups: Group[] = [];

    for (const child of (data.children ?? [])) {
        const groupName: string = child.name ?? child.abbreviation ?? 'Group';
        const entries: GroupEntry[] = [];

        for (const entry of (child.standings?.entries ?? [])) {
            const team = entry.team ?? {};
            const statsArr: any[] = entry.stats ?? [];
            const stat = (name: string) => statsArr.find((s: any) => s.name === name)?.value ?? 0;
            const statStr = (name: string) => statsArr.find((s: any) => s.name === name)?.displayValue ?? '0';

            const logoHref = (team.logos?.[0]?.href ?? null) as string | null;

            entries.push({
                rank: stat('rank') || entries.length + 1,
                team: team.displayName ?? '?',
                flagUrl: logoHref,
                played: stat('gamesPlayed'),
                wins: stat('wins'),
                draws: stat('ties'),
                losses: stat('losses'),
                gf: stat('pointsFor'),
                ga: stat('pointsAgainst'),
                gd: statStr('pointDifferential'),
                points: stat('points'),
                advanced: stat('advanced') === 1,
            });
        }

        entries.sort((a, b) => a.rank - b.rank);
        groups.push({ name: groupName, entries });
    }

    return groups;
}

// GET /api/stats/tournament — tournament leaders + group standings
router.get('/tournament', authenticateToken, async (_req: Request, res: Response): Promise<void> => {
    try {
        // Serve from cache if fresh
        if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
            res.json({ success: true, data: cache.data });
            return;
        }

        // Fetch in parallel where possible
        const [categories, groups] = await Promise.all([
            buildLeaders(),
            buildGroups(),
        ]);

        const result: TournamentStats = {
            categories,
            groups,
            fetchedAt: new Date().toISOString(),
        };

        cache = { data: result, cachedAt: Date.now() };
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Tournament stats error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch tournament stats' });
    }
});

// GET /api/stats/bracket — knockout bracket from our own fixtures DB
router.get('/bracket', authenticateToken, async (_req: Request, res: Response): Promise<void> => {
    try {
        const stages = ['round32', 'round16', 'qf', 'sf', 'third_place', 'final'];
        const fixtures = await db('fixtures')
            .whereIn('stage', stages)
            .orderBy('kickoff_time', 'asc')
            .select('id', 'match_number', 'home_team', 'away_team', 'home_score', 'away_score',
                'penalty_home_score', 'penalty_away_score', 'penalty_enabled',
                'stage', 'status', 'kickoff_time');

        // Group by stage
        const byStage: Record<string, typeof fixtures> = {};
        for (const stage of stages) {
            byStage[stage] = fixtures.filter((f) => f.stage === stage);
        }

        res.json({ success: true, data: byStage });
    } catch (err) {
        console.error('Bracket error:', err);
        res.status(500).json({ success: false, error: 'Failed to fetch bracket' });
    }
});

// POST /api/stats/flush — admin-only cache bust, forces fresh ESPN fetch
router.post('/flush', authenticateToken, requireAdmin, (_req: Request, res: Response): void => {
    cache = null;
    res.json({ success: true, message: 'Stats cache cleared — next request will fetch fresh from ESPN' });
});

export default router;
