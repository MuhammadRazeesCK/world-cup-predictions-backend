import axios from 'axios';
import { FootballAPIScore } from '../types';

interface CacheEntry {
    data: FootballAPIScore;
    timestamp: number;
}

const scoreCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

// Status mappings from api-football.com
const FINISHED_STATUSES = ['FT', 'AET', 'PEN'];
const LIVE_STATUSES = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'];

export async function getFixtureScore(apiFixtureId: number): Promise<FootballAPIScore | null> {
    const cacheKey = String(apiFixtureId);
    const cached = scoreCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.data;
    }

    const apiKey = process.env.API_FOOTBALL_KEY;
    const baseUrl = process.env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';

    if (!apiKey) {
        console.warn('API_FOOTBALL_KEY not configured');
        return null;
    }

    try {
        const response = await axios.get(`${baseUrl}/fixtures`, {
            headers: {
                'x-rapidapi-key': apiKey,
                'x-rapidapi-host': 'v3.football.api-sports.io',
            },
            params: { id: apiFixtureId },
            timeout: 10000,
        });

        const fixture = response.data?.response?.[0];
        if (!fixture) return null;

        const status = fixture.fixture?.status?.short;
        const homeGoals = fixture.goals?.home;
        const awayGoals = fixture.goals?.away;

        const result: FootballAPIScore = {
            status: FINISHED_STATUSES.includes(status)
                ? 'MATCH_FINISHED'
                : LIVE_STATUSES.includes(status)
                    ? 'MATCH_LIVE'
                    : 'MATCH_SCHEDULED',
            homeGoals: homeGoals ?? null,
            awayGoals: awayGoals ?? null,
        };

        scoreCache.set(cacheKey, { data: result, timestamp: Date.now() });
        return result;
    } catch (err) {
        console.error(`Failed to fetch score for fixture ${apiFixtureId}:`, err);
        return null;
    }
}
