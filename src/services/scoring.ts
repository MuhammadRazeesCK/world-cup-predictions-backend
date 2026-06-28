import { ScoringResult } from '../types';

type GoalCount = { home: number; away: number };
type PenaltyScore = { home: number; away: number } | null | undefined;

function getMatchWinner(home: number, away: number): 'home' | 'away' | 'draw' {
    if (home > away) return 'home';
    if (away > home) return 'away';
    return 'draw';
}

export function calculatePoints(
    predicted: GoalCount,
    actual: GoalCount,
    penaltyEnabled: boolean = false,
    predictedPenalty: PenaltyScore = null,
    actualPenalty: PenaltyScore = null,
): ScoringResult {
    const actualGoalWinner   = getMatchWinner(actual.home, actual.away);
    const predictedGoalWinner = getMatchWinner(predicted.home, predicted.away);

    // Penalties apply when: fixture is penalty-enabled, actual result is a draw,
    // and the admin has set the penalty score
    const penaltiesPlayed =
        penaltyEnabled &&
        actualGoalWinner === 'draw' &&
        actualPenalty != null &&
        actualPenalty.home !== actualPenalty.away;

    // Effective match winner considering penalties
    const actualEffectiveWinner = penaltiesPlayed
        ? (actualPenalty!.home > actualPenalty!.away ? 'home' : 'away')
        : actualGoalWinner;

    const predictedPenaltyValid =
        predictedPenalty != null &&
        predictedPenalty.home !== predictedPenalty.away;
    const predictedEffectiveWinner =
        penaltyEnabled && predictedGoalWinner === 'draw' && predictedPenaltyValid
            ? (predictedPenalty!.home > predictedPenalty!.away ? 'home' : 'away')
            : predictedGoalWinner;

    // --- Exact: correct match scoreline AND correct penalty score (if applicable) ---
    const matchScoreExact = predicted.home === actual.home && predicted.away === actual.away;
    const penScoreExact   = !penaltiesPlayed ||
        (predictedPenaltyValid &&
         predictedPenalty!.home === actualPenalty!.home &&
         predictedPenalty!.away === actualPenalty!.away);

    if (matchScoreExact && penScoreExact) {
        return { points: 8, resultType: 'exact' };
    }

    // --- Winner: correct overall winning team ---
    if (predictedEffectiveWinner === actualEffectiveWinner) {
        return { points: 3, resultType: 'winner' };
    }

    return { points: 0, resultType: 'wrong' };
}

