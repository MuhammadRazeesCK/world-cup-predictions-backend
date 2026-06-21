import { ScoringResult } from '../types';

type GoalCount = { home: number; away: number };
type Winner = 'W' | 'D' | 'L';

function getWinner(home: number, away: number): Winner {
    if (home > away) return 'W';
    if (away > home) return 'L';
    return 'D';
}

export function calculatePoints(
    predicted: GoalCount,
    actual: GoalCount
): ScoringResult {
    // Exact score match — highest reward
    if (predicted.home === actual.home && predicted.away === actual.away) {
        return { points: 8, resultType: 'exact' };
    }

    // Correct winner (including draw)
    if (getWinner(predicted.home, predicted.away) === getWinner(actual.home, actual.away)) {
        return { points: 3, resultType: 'winner' };
    }

    return { points: 0, resultType: 'wrong' };
}
