import axios from 'axios';
import { FootballAPIScore } from '../types';

interface CacheEntry {
    data: FootballAPIScore;
    timestamp: number;
}

const scoreCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';

export async function getFixtureScore(espnEventId: number): Promise<FootballAPIScore | null> {
    const cacheKey = String(espnEventId);
    const cached = scoreCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
    }

    try {
        const response = await axios.get(`${ESPN_BASE}/summary`, {
            params: { event: espnEventId },
            timeout: 10000,
        });

        // ESPN summary returns header.competitions[0]
        const comp = response.data?.header?.competitions?.[0];
        if (!comp) return null;

        const state: string = comp.status?.type?.state ?? 'pre'; // "pre" | "in" | "post"
        const competitors: any[] = comp.competitors ?? [];
        const home = competitors.find((c: any) => c.homeAway === 'home');
        const away = competitors.find((c: any) => c.homeAway === 'away');

        const homeGoals = home ? parseInt(home.score, 10) : null;
        const awayGoals = away ? parseInt(away.score, 10) : null;
        const shootoutHomeGoals = home?.shootoutScore != null ? parseInt(home.shootoutScore, 10) : null;
        const shootoutAwayGoals = away?.shootoutScore != null ? parseInt(away.shootoutScore, 10) : null;

        const result: FootballAPIScore = {
            status: state === 'post'
                ? 'MATCH_FINISHED'
                : state === 'in'
                    ? 'MATCH_LIVE'
                    : 'MATCH_SCHEDULED',
            homeGoals: isNaN(homeGoals as number) ? null : homeGoals,
            awayGoals: isNaN(awayGoals as number) ? null : awayGoals,
            espnHomeTeam: home?.team?.displayName ?? null,
            espnAwayTeam: away?.team?.displayName ?? null,
            shootoutHomeGoals: (shootoutHomeGoals !== null && !isNaN(shootoutHomeGoals)) ? shootoutHomeGoals : null,
            shootoutAwayGoals: (shootoutAwayGoals !== null && !isNaN(shootoutAwayGoals)) ? shootoutAwayGoals : null,
        };

        scoreCache.set(cacheKey, { data: result, timestamp: Date.now() });
        return result;
    } catch (err) {
        console.error(`ESPN: Failed to fetch score for event ${espnEventId}:`, err);
        return null;
    }
}
