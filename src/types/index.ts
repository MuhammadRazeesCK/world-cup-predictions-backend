// TypeScript interfaces matching the database schema and API spec

export interface User {
    id: string;
    email: string;
    username: string;
    password_hash: string;
    role: 'user' | 'admin';
    created_at: Date;
    last_login: Date | null;
    is_active: boolean;
}

export interface Session {
    id: string;
    user_id: string;
    token_hash: string;
    expires_at: Date;
    is_revoked: boolean;
    created_at: Date;
    ip_address: string | null;
    user_agent: string | null;
}

export type FixtureStage = 'group' | 'round16' | 'qf' | 'sf' | 'final';
export type FixtureStatus = 'scheduled' | 'live' | 'completed';

export interface Fixture {
    id: string;
    match_number: number;
    home_team: string;
    away_team: string;
    kickoff_time: Date;
    stage: FixtureStage;
    status: FixtureStatus;
    home_score: number | null;
    away_score: number | null;
    prediction_closes_at: Date;
    api_fixture_id: number | null;
    created_at: Date;
    updated_at: Date;
}

export type PredictionResult = 'exact' | 'winner' | 'wrong' | 'draw_correct';

export interface Prediction {
    id: string;
    user_id: string;
    fixture_id: string;
    predicted_home_goals: number;
    predicted_away_goals: number;
    points: number | null;
    result: PredictionResult | null;
    predicted_at: Date;
    updated_at: Date;
}

export interface AdminLog {
    id: string;
    admin_id: string;
    action: string;
    details: Record<string, unknown>;
    created_at: Date;
}

export interface LeaderboardEntry {
    rank: number;
    user_id: string;
    username: string;
    total_points: number;
    total_predictions: number;
    completed_predictions: number;
    exact_predictions: number;
    winner_predictions: number;
    accuracy_percentage: number;
}

// Express augmentation for authenticated requests (not used directly — req.user comes from middleware/auth.ts declaration)
export interface AuthenticatedRequestUser {
    id: string;
    email: string;
    username: string;
    role: 'user' | 'admin';
}

// Scoring
export interface ScoringResult {
    points: number;
    resultType: PredictionResult;
}

// External API
export interface FootballAPIScore {
    status: string;
    homeGoals: number | null;
    awayGoals: number | null;
    espnHomeTeam: string | null;
    espnAwayTeam: string | null;
    shootoutHomeGoals: number | null;
    shootoutAwayGoals: number | null;
}
