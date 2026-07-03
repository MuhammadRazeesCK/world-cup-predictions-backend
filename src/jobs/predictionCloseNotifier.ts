import { DateTime } from 'luxon';
import db from '../db';
import { sendWhatsAppMessage } from '../services/whatsapp';

const GROUP_ID = process.env.WHATSAPP_GROUP_ID ?? '';

const STAGE_LABELS: Record<string, string> = {
    group: 'Group Stage',
    round32: 'Round of 32',
    round16: 'Round of 16',
    qf: 'Quarter-final',
    sf: 'Semi-final',
    third_place: '3rd Place',
    final: 'Final',
};

function formatKickoff(kickoffTime: Date): string {
    return DateTime.fromJSDate(kickoffTime)
        .setZone('Asia/Kolkata')
        .toFormat("d MMM, h:mm a 'IST'");
}

function formatPredictionLine(pred: any, homeTeam: string, awayTeam: string): string {
    let line = `👤 *${pred.username}*: ${homeTeam} ${pred.predicted_home_goals}–${pred.predicted_away_goals} ${awayTeam}`;
    if (pred.penalty_home_goals !== null && pred.penalty_away_goals !== null) {
        line += ` _(pen: ${pred.penalty_home_goals}–${pred.penalty_away_goals})_`;
    }
    return line;
}

async function notifyFixture(fixture: any): Promise<void> {
    const predictions = await db('predictions')
        .join('users', 'predictions.user_id', 'users.id')
        .where('predictions.fixture_id', fixture.id)
        .select(
            'predictions.predicted_home_goals',
            'predictions.predicted_away_goals',
            'predictions.penalty_home_goals',
            'predictions.penalty_away_goals',
            'users.username',
        )
        .orderBy('users.username', 'asc');

    const stageLabel = STAGE_LABELS[fixture.stage] ?? fixture.stage;
    const kickoffStr = formatKickoff(fixture.kickoff_time);

    let msg = `🏆 *World Cup 2026 — Predictions Locked!*\n\n`;
    msg += `⚽ *${fixture.home_team} vs ${fixture.away_team}*\n`;
    msg += `🗓 ${stageLabel} • Match #${fixture.match_number}\n`;
    msg += `⏰ Kickoff: ${kickoffStr}\n\n`;

    if (predictions.length === 0) {
        msg += `_No predictions submitted._`;
    } else {
        msg += predictions
            .map((p: any) => formatPredictionLine(p, fixture.home_team, fixture.away_team))
            .join('\n');
        msg += `\n\n_${predictions.length} prediction${predictions.length !== 1 ? 's' : ''} locked in. Good luck! 🤞_`;
    }

    const sent = await sendWhatsAppMessage(GROUP_ID, msg);
    if (sent) {
        await db('fixtures')
            .where({ id: fixture.id })
            .update({ whatsapp_notified_at: new Date() });
        console.log(`WhatsApp: predictions summary sent for match #${fixture.match_number} (${fixture.home_team} vs ${fixture.away_team})`);
    }
}

export function startPredictionCloseNotifier(): void {
    if (process.env.WHATSAPP_ENABLED !== 'true') return;
    if (!GROUP_ID) {
        console.warn('WhatsApp: WHATSAPP_GROUP_ID not set — prediction notifier disabled');
        return;
    }

    console.log('WhatsApp prediction close notifier started ✓');

    setInterval(async () => {
        try {
            const now = DateTime.now().toJSDate();
            // Only look at fixtures kicking off within the next 2h (i.e. prediction just closed)
            const kickoffCutoff = DateTime.now().minus({ hours: 2 }).toJSDate();

            const fixtures = await db('fixtures')
                .where('prediction_closes_at', '<=', now)
                .where('kickoff_time', '>=', kickoffCutoff)
                .whereNull('whatsapp_notified_at')
                .whereIn('status', ['scheduled', 'live'])
                .select('*');

            for (const fixture of fixtures) {
                await notifyFixture(fixture);
            }
        } catch (err) {
            console.error('Prediction close notifier error:', err);
        }
    }, 60_000); // check every minute
}
