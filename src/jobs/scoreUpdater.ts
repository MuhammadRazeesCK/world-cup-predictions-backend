import db from '../db';
import { getFixtureScore } from '../services/footballAPI';
import { calculatePoints } from '../services/scoring';

/** Fuzzy-match ESPN team name against our DB team name (handles "Côte d'Ivoire" vs "Ivory Coast" etc.) */
function teamsMatch(espnName: string | null, dbName: string): boolean {
    if (!espnName) return false;
    const a = espnName.toLowerCase();
    const b = dbName.toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
}

/** Resolve goals for our fixture's home/away from ESPN data, handling team order mismatches */
function resolveGoals(
    espnHomeGoals: number | null, espnAwayGoals: number | null,
    espnHomeTeam: string | null, espnAwayTeam: string | null,
    dbHomeTeam: string, dbAwayTeam: string,
): { homeGoals: number | null; awayGoals: number | null } {
    // If ESPN home matches our home, assignment is correct
    if (teamsMatch(espnHomeTeam, dbHomeTeam)) {
        return { homeGoals: espnHomeGoals, awayGoals: espnAwayGoals };
    }
    // If ESPN home matches our away, teams are swapped — flip the scores
    if (teamsMatch(espnHomeTeam, dbAwayTeam)) {
        return { homeGoals: espnAwayGoals, awayGoals: espnHomeGoals };
    }
    // No name match — fall back to ESPN order as-is
    return { homeGoals: espnHomeGoals, awayGoals: espnAwayGoals };
}

async function updateCompletedMatches(): Promise<void> {
    try {
        // Find live matches that have an external API fixture ID
        const liveMatches = await db('fixtures')
            .where({ status: 'live' })
            .whereNotNull('api_fixture_id')
            .select('*');

        for (const match of liveMatches) {
            try {
                const externalScore = await getFixtureScore(match.api_fixture_id);

                if (!externalScore) continue;

                // Resolve scores accounting for possible ESPN home/away mismatch
                const { homeGoals, awayGoals } = resolveGoals(
                    externalScore.homeGoals, externalScore.awayGoals,
                    externalScore.espnHomeTeam, externalScore.espnAwayTeam,
                    match.home_team, match.away_team,
                );

                // Resolve penalty shootout scores with the same flip logic
                const { homeGoals: penHome, awayGoals: penAway } = resolveGoals(
                    externalScore.shootoutHomeGoals, externalScore.shootoutAwayGoals,
                    externalScore.espnHomeTeam, externalScore.espnAwayTeam,
                    match.home_team, match.away_team,
                );
                const hasPenaltyScore = penHome !== null && penAway !== null && penHome !== penAway;

                // Update to live if API shows it live
                if (externalScore.status === 'MATCH_LIVE') {
                    await db('fixtures').where({ id: match.id }).update({
                        status: 'live',
                        home_score: homeGoals,
                        away_score: awayGoals,
                        updated_at: new Date(),
                    });
                }

                // Process completed match
                if (
                    externalScore.status === 'MATCH_FINISHED' &&
                    homeGoals !== null &&
                    awayGoals !== null
                ) {
                    // Update fixture to completed
                    await db('fixtures').where({ id: match.id }).update({
                        status: 'completed',
                        home_score: homeGoals,
                        away_score: awayGoals,
                        ...(hasPenaltyScore && {
                            penalty_home_score: penHome,
                            penalty_away_score: penAway,
                        }),
                        updated_at: new Date(),
                    });

                    // Calculate points — use auto-detected penalty score if available
                    const actualPenalty = hasPenaltyScore
                        ? { home: penHome!, away: penAway! }
                        : (match.penalty_enabled && match.penalty_home_score !== null && match.penalty_away_score !== null)
                            ? { home: match.penalty_home_score, away: match.penalty_away_score }
                            : null;

                    // Calculate points for all predictions on this fixture
                    const predictions = await db('predictions')
                        .where({ fixture_id: match.id, result: null })
                        .select('*');

                    for (const pred of predictions) {
                        const predictedPenalty = (pred.penalty_home_goals !== null && pred.penalty_away_goals !== null)
                            ? { home: pred.penalty_home_goals, away: pred.penalty_away_goals } : null;
                        const { points, resultType } = calculatePoints(
                            { home: pred.predicted_home_goals, away: pred.predicted_away_goals },
                            { home: homeGoals, away: awayGoals },
                            match.penalty_enabled,
                            predictedPenalty,
                            actualPenalty,
                        );

                        await db('predictions').where({ id: pred.id }).update({
                            points,
                            result: resultType,
                            updated_at: new Date(),
                        });
                    }

                    console.log(
                        `Match ${match.match_number} (${match.home_team} vs ${match.away_team}) completed. ` +
                        `Score: ${homeGoals}-${awayGoals}. ` +
                        `Calculated points for ${predictions.length} predictions.`
                    );
                }
            } catch (matchErr) {
                console.error(`Error processing match ${match.id}:`, matchErr);
            }
        }

        // Also mark fixtures as "live" when kickoff time has passed but status is still "scheduled"
        const now = new Date();
        await db('fixtures')
            .where({ status: 'scheduled' })
            .where('kickoff_time', '<=', now)
            .update({ status: 'live', updated_at: now });

    } catch (err: any) {
        // Silently skip if DB is not yet available (e.g., local dev without a DB)
        if (err?.message?.includes('Unable to acquire a connection')) {
            return;
        }
        console.error('Score updater error:', err);
    }
}

const POLL_INTERVAL_LIVE = 30 * 1000;        // 30s when a match is live
const POLL_INTERVAL_IDLE = 10 * 60 * 1000;  // 10 min when no live matches

export function startScoreUpdater(): void {
    console.log('Score updater started (adaptive polling: 30s live / 10min idle)');

    async function run() {
        await updateCompletedMatches();

        // Check if any matches are currently live to decide next interval
        let hasLive = false;
        try {
            const liveCount = await db('fixtures').where({ status: 'live' }).count('id as count').first();
            hasLive = Number(liveCount?.count ?? 0) > 0;
        } catch {
            // If DB is unavailable, fall back to idle interval
        }

        const interval = hasLive ? POLL_INTERVAL_LIVE : POLL_INTERVAL_IDLE;
        setTimeout(run, interval);
    }

    run();
}
