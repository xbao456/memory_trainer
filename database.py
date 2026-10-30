import sqlite3
import sys
import os

if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

DB_PATH = os.path.join(BASE_DIR, 'memory_trainer.db')

MIN_DIFFICULTY = 0.5
MAX_DIFFICULTY = 5.0
WINDOW = 10

GAME_TYPES = [
    ('cards', 'Найди пару', 1.5, 4.0),
    ('math', 'Математические цепочки', 3.0, 8.0),
    ('colors', 'Цветовая память', 0.8, 2.0),
]


def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def init_db():
    conn = get_connection()
    cur = conn.cursor()

    cur.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_uid TEXT NOT NULL UNIQUE,
            difficulty REAL NOT NULL DEFAULT 1.0
                CHECK (difficulty BETWEEN 0.5 AND 5.0),
            created_at TIMESTAMP NOT NULL DEFAULT (datetime('now', 'localtime')),
            last_active TIMESTAMP NOT NULL DEFAULT (datetime('now', 'localtime'))
        )
    ''')

    cur.execute('''
        CREATE TABLE IF NOT EXISTS game_types (
            code TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            fast_time REAL NOT NULL,
            slow_time REAL NOT NULL
        )
    ''')

    cur.execute('''
        CREATE TABLE IF NOT EXISTS game_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            game_type TEXT NOT NULL REFERENCES game_types(code),
            difficulty REAL NOT NULL,
            started_at TIMESTAMP NOT NULL DEFAULT (datetime('now', 'localtime')),
            ended_at TIMESTAMP,
            score INTEGER NOT NULL DEFAULT 0,
            max_score INTEGER NOT NULL DEFAULT 0,
            won INTEGER CHECK (won IN (0, 1))
        )
    ''')

    cur.execute('''
        CREATE TABLE IF NOT EXISTS attempts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
            is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
            reaction_time REAL NOT NULL CHECK (reaction_time >= 0),
            created_at TIMESTAMP NOT NULL DEFAULT (datetime('now', 'localtime'))
        )
    ''')

    cur.execute('CREATE INDEX IF NOT EXISTS idx_sessions_user ON game_sessions(user_id)')
    cur.execute('CREATE INDEX IF NOT EXISTS idx_attempts_session ON attempts(session_id)')

    cur.executemany(
        'INSERT OR IGNORE INTO game_types (code, title, fast_time, slow_time) VALUES (?, ?, ?, ?)',
        GAME_TYPES
    )

    conn.commit()
    conn.close()


def get_or_create_user(conn, user_uid):
    row = conn.execute('SELECT id, difficulty FROM users WHERE user_uid = ?', (user_uid,)).fetchone()
    if row:
        conn.execute("UPDATE users SET last_active = datetime('now', 'localtime') WHERE id = ?", (row['id'],))
        return row['id'], row['difficulty']
    cur = conn.execute('INSERT INTO users (user_uid) VALUES (?)', (user_uid,))
    return cur.lastrowid, 1.0


def game_type_exists(game_type):
    conn = get_connection()
    row = conn.execute('SELECT 1 FROM game_types WHERE code = ?', (game_type,)).fetchone()
    conn.close()
    return row is not None


def get_user_stats(user_uid):
    conn = get_connection()
    user_id, difficulty = get_or_create_user(conn, user_uid)

    games = conn.execute('''
        SELECT COUNT(*) AS total, COALESCE(SUM(won), 0) AS wins
        FROM game_sessions
        WHERE user_id = ? AND ended_at IS NOT NULL
    ''', (user_id,)).fetchone()

    moves = conn.execute('''
        SELECT AVG(a.is_correct) AS accuracy, AVG(a.reaction_time) AS avg_rt
        FROM attempts a
        JOIN game_sessions s ON s.id = a.session_id
        WHERE s.user_id = ?
    ''', (user_id,)).fetchone()

    results = conn.execute('''
        SELECT won FROM game_sessions
        WHERE user_id = ? AND ended_at IS NOT NULL
        ORDER BY id DESC
    ''', (user_id,)).fetchall()

    streak = 0
    for r in results:
        if not r['won']:
            break
        streak += 1

    conn.commit()
    conn.close()

    return {
        'difficulty': difficulty,
        'total_games': games['total'],
        'wins': games['wins'],
        'accuracy': round((moves['accuracy'] or 0) * 100, 1),
        'avg_reaction_time': round(moves['avg_rt'] or 0, 2),
        'streak': streak,
    }


def start_session(user_uid, game_type):
    conn = get_connection()
    user_id, difficulty = get_or_create_user(conn, user_uid)
    cur = conn.execute(
        'INSERT INTO game_sessions (user_id, game_type, difficulty) VALUES (?, ?, ?)',
        (user_id, game_type, difficulty)
    )
    session_id = cur.lastrowid
    conn.commit()
    conn.close()
    return session_id, difficulty


def add_attempt(session_id, is_correct, reaction_time):
    conn = get_connection()
    row = conn.execute('SELECT ended_at FROM game_sessions WHERE id = ?', (session_id,)).fetchone()
    if row is None or row['ended_at'] is not None:
        conn.close()
        return False
    conn.execute(
        'INSERT INTO attempts (session_id, is_correct, reaction_time) VALUES (?, ?, ?)',
        (session_id, int(is_correct), reaction_time)
    )
    conn.commit()
    conn.close()
    return True


def calc_difficulty(current, accuracy, avg_rt, fast_time, slow_time):
    if accuracy >= 0.8 and avg_rt <= fast_time:
        step = 0.3
    elif accuracy >= 0.7 and avg_rt < slow_time:
        step = 0.1
    elif accuracy < 0.5 or avg_rt >= slow_time:
        step = -0.3
    else:
        step = 0.0
    return round(min(MAX_DIFFICULTY, max(MIN_DIFFICULTY, current + step)), 1)


def finish_session(session_id, score, max_score, won):
    conn = get_connection()
    session = conn.execute('''
        SELECT s.id, s.user_id, s.game_type, s.ended_at, u.difficulty, g.fast_time, g.slow_time
        FROM game_sessions s
        JOIN users u ON u.id = s.user_id
        JOIN game_types g ON g.code = s.game_type
        WHERE s.id = ?
    ''', (session_id,)).fetchone()

    if session is None or session['ended_at'] is not None:
        conn.close()
        return None

    conn.execute('''
        UPDATE game_sessions
        SET ended_at = datetime('now', 'localtime'), score = ?, max_score = ?, won = ?
        WHERE id = ?
    ''', (score, max_score, int(won), session_id))

    recent = conn.execute('''
        SELECT a.is_correct, a.reaction_time
        FROM attempts a
        JOIN game_sessions s ON s.id = a.session_id
        WHERE s.user_id = ? AND s.game_type = ?
        ORDER BY a.id DESC
        LIMIT ?
    ''', (session['user_id'], session['game_type'], WINDOW)).fetchall()

    old = session['difficulty']
    new = old
    accuracy = 0.0
    avg_rt = 0.0

    if len(recent) >= 5:
        accuracy = sum(r['is_correct'] for r in recent) / len(recent)
        avg_rt = sum(r['reaction_time'] for r in recent) / len(recent)
        new = calc_difficulty(old, accuracy, avg_rt, session['fast_time'], session['slow_time'])
        conn.execute('UPDATE users SET difficulty = ? WHERE id = ?', (new, session['user_id']))

    conn.commit()
    conn.close()

    return {
        'old_difficulty': old,
        'new_difficulty': new,
        'window_accuracy': round(accuracy * 100, 1),
        'window_reaction_time': round(avg_rt, 2),
        'attempts_in_window': len(recent),
    }


def get_user_history(user_uid, limit=50):
    conn = get_connection()
    user_id, _ = get_or_create_user(conn, user_uid)
    rows = conn.execute('''
        SELECT s.id, s.game_type, g.title, s.difficulty, s.score, s.max_score, s.won,
               s.started_at, s.ended_at,
               COUNT(a.id) AS attempts,
               ROUND(AVG(a.reaction_time), 2) AS avg_reaction_time
        FROM game_sessions s
        JOIN game_types g ON g.code = s.game_type
        LEFT JOIN attempts a ON a.session_id = s.id
        WHERE s.user_id = ? AND s.ended_at IS NOT NULL
        GROUP BY s.id
        ORDER BY s.id DESC
        LIMIT ?
    ''', (user_id, limit)).fetchall()
    conn.commit()
    conn.close()
    return [dict(r) for r in rows]


init_db()
