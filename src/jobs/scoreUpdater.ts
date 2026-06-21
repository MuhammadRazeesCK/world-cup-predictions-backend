import db from '../db';
import { getFixtureScore } from '../services/footballAPI';
import { calculatePoints } from '../services/scoring';

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

                // Update to live if API shows it live
                if (externalScore.status === 'MATCH_LIVE') {
                    await db('fixtures').where({ id: match.id }).update({
                        status: 'live',
                        home_score: externalScore.homeGoals,
                        away_score: externalScore.awayGoals,
                        updated_at: new Date(),
                    });
                }

                // Process completed match
                if (
                    externalScore.status === 'MATCH_FINISHED' &&
                    externalScore.homeGoals !== null &&
                    externalScore.awayGoals !== null
                ) {
                    // Update fixture to completed
                    await db('fixtures').where({ id: match.id }).update({
                        status: 'completed',
                        home_score: externalScore.homeGoals,
                        away_score: externalScore.awayGoals,
                        updated_at: new Date(),
                    });

                    // Calculate points for all predictions on this fixture
                    const predictions = await db('predictions')
                        .where({ fixture_id: match.id, result: null })
                        .select('*');

                    for (const pred of predictions) {
                        const { points, resultType } = calculatePoints(
                            { home: pred.predicted_home_goals, away: pred.predicted_away_goals },
                            { home: externalScore.homeGoals, away: externalScore.awayGoals }
                        );

                        await db('predictions').where({ id: pred.id }).update({
                            points,
                            result: resultType,
                            updated_at: new Date(),
                        });
                    }

                    console.log(
                        `Match ${match.match_number} (${match.home_team} vs ${match.away_team}) completed. ` +
                        `Score: ${externalScore.homeGoals}-${externalScore.awayGoals}. ` +
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

export function startScoreUpdater(): void {
    console.log('Score updater started (polling every 30s)');
    // Run immediately on start, then every 30 seconds
    updateCompletedMatches();
    setInterval(updateCompletedMatches, 30 * 1000);
}
