const API = '/api';

const uid = localStorage.getItem('uid') || (() => {
    const id = 'u' + Math.random().toString(36).slice(2, 11);
    localStorage.setItem('uid', id);
    return id;
})();

let currentGame = null;
let gameTimer = null;
let session = { id: null, difficulty: 1, params: null };
let queue = Promise.resolve();

const STATE = {
    cards: {},
    math: {},
    colors: {}
};

const COLORS = ['red', 'green', 'blue', 'yellow'];

const COLOR_HEX = {
    red: '#ef4444',
    green: '#22c55e',
    blue: '#3b82f6',
    yellow: '#eab308'
};

const CARD_EMOJIS = [
    { emoji: '🍎', bg: '#fee2e2' },
    { emoji: '🍊', bg: '#ffedd5' },
    { emoji: '🍋', bg: '#fef9c3' },
    { emoji: '🍇', bg: '#f3e8ff' },
    { emoji: '🍓', bg: '#fce7f3' },
    { emoji: '🥝', bg: '#dcfce7' },
    { emoji: '🍑', bg: '#fff1f2' },
    { emoji: '🫐', bg: '#dbeafe' }
];

function localParams(type, d) {
    if (type === 'cards') {
        return { pairs: 8, time_limit: Math.max(40, 80 - Math.floor(d * 8)) };
    }
    if (type === 'math') {
        const ops = d >= 2 ? ['+', '-', 'x'] : ['+', '-'];
        return { max_num: Math.floor(10 + d * 10), ops, problems: 10, time_limit: 60 };
    }
    return { start_length: 2 + Math.floor(d), show_ms: Math.max(300, 700 - Math.floor(d * 80)), levels: 7 };
}

function post(path, body) {
    return fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(r => {
        if (!r.ok) throw new Error(r.status);
        return r.json();
    });
}

async function startSession(type) {
    await queue;
    queue = Promise.resolve();
    try {
        const d = await post('/session/start', { user_uid: uid, game_type: type });
        localStorage.setItem('diff', d.difficulty);
        session = { id: d.session_id, difficulty: d.difficulty, params: d.params };
    } catch (e) {
        const diff = parseFloat(localStorage.getItem('diff') || '1');
        session = { id: null, difficulty: diff, params: localParams(type, diff) };
    }
}

function sendAttempt(isCorrect, reactionTime) {
    if (!session.id) return;
    const body = { session_id: session.id, is_correct: isCorrect, reaction_time: +reactionTime.toFixed(3) };
    queue = queue.then(() => post('/attempt', body)).catch(() => {});
}

function finishSession(score, maxScore, won) {
    const sid = session.id;
    if (!sid) return Promise.resolve(null);
    const body = { session_id: sid, score, max_score: maxScore, won };
    queue = queue.then(() => post('/session/finish', body)).then(d => {
        localStorage.setItem('diff', d.new_difficulty);
        return d;
    }).catch(() => null);
    return queue;
}

function plural(n, forms) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return forms[0];
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
    return forms[2];
}

async function loadStats() {
    try {
        const r = await fetch(`${API}/stats/${uid}`);
        const d = await r.json();
        document.getElementById('totalGames').textContent = d.total_games;
        document.getElementById('gamesLabel').textContent = plural(d.total_games, ['игра', 'игры', 'игр']);
        document.getElementById('accuracy').textContent = Math.round(d.accuracy) + '%';
        document.getElementById('streak').textContent = d.streak;
        document.getElementById('streakLabel').textContent = plural(d.streak, ['победа', 'победы', 'побед']);
        document.getElementById('level').textContent = d.difficulty.toFixed(1);
        localStorage.setItem('diff', d.difficulty);
    } catch (e) {
        document.getElementById('level').textContent = parseFloat(localStorage.getItem('diff') || '1').toFixed(1);
    }
}

function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function stopGame() {
    if (gameTimer) clearInterval(gameTimer);
    gameTimer = null;
    currentGame = null;
}

function goHome() {
    stopGame();
    show('home');
    loadStats();
}

let starting = false;

async function play(type) {
    if (starting) return;
    starting = true;
    stopGame();
    try {
        await startSession(type);
    } finally {
        starting = false;
    }
    currentGame = type;
    if (type === 'cards') initCards();
    else if (type === 'math') initMath();
    else initColors();
}

function replay() {
    const type = STATE.lastGame;
    if (type) play(type);
}

function startTimer(seconds, elId, onEnd) {
    let left = seconds;
    document.getElementById(elId).textContent = left;
    gameTimer = setInterval(() => {
        left--;
        document.getElementById(elId).textContent = left;
        if (left <= 0) onEnd();
    }, 1000);
    return () => seconds - left;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function initCards() {
    show('cardsGame');
    const { pairs, time_limit } = session.params;
    const picked = shuffle([...CARD_EMOJIS]).slice(0, pairs);
    const cards = shuffle([...picked, ...picked]);

    STATE.cards = { flipped: [], matched: 0, total: pairs, moves: 0, turnStart: performance.now(), done: false };

    const grid = document.getElementById('cardsGrid');
    grid.innerHTML = '';
    cards.forEach(item => {
        const card = document.createElement('div');
        card.className = 'memory-card';
        card.innerHTML = `
            <div class="memory-card-inner">
                <div class="memory-card-front"></div>
                <div class="memory-card-back" style="background: ${item.bg}">
                    <span class="card-emoji">${item.emoji}</span>
                </div>
            </div>
        `;
        card.onclick = () => flipCard(card, item.emoji);
        grid.appendChild(card);
    });

    document.getElementById('cardsPairs').textContent = `0/${pairs}`;
    STATE.cards.elapsed = startTimer(time_limit, 'cardsTime', () => endCards(false));
}

function flipCard(card, emoji) {
    const s = STATE.cards;
    if (s.done || card.classList.contains('flipped') || s.flipped.length >= 2) return;

    card.classList.add('flipped');
    s.flipped.push({ card, emoji });
    if (s.flipped.length < 2) return;

    const [a, b] = s.flipped;
    const ok = a.emoji === b.emoji;
    s.moves++;
    sendAttempt(ok, (performance.now() - s.turnStart) / 1000);

    setTimeout(() => {
        if (s.done || currentGame !== 'cards') return;
        if (ok) {
            a.card.classList.add('matched');
            b.card.classList.add('matched');
            s.matched++;
            document.getElementById('cardsPairs').textContent = `${s.matched}/${s.total}`;
        } else {
            a.card.classList.remove('flipped');
            b.card.classList.remove('flipped');
        }
        s.flipped = [];
        s.turnStart = performance.now();
        if (s.matched === s.total) endCards(true);
    }, ok ? 300 : 800);
}

function endCards(won) {
    const s = STATE.cards;
    if (s.done) return;
    s.done = true;
    const time = s.elapsed();
    clearInterval(gameTimer);
    showResult('cards', won, s.matched, s.total, {
        title: won ? 'Отлично!' : 'Время вышло',
        sub: 'Найди пару',
        stats: [
            ['Найдено пар', `${s.matched}/${s.total}`],
            ['Ходов', s.moves],
            ['Время', `${time} сек`]
        ]
    });
}

function initMath() {
    show('mathGame');
    const { problems, time_limit } = session.params;
    STATE.math = { current: null, answer: '', score: 0, answered: 0, total: problems, shownAt: 0, done: false };

    const keypad = document.getElementById('mathKeypad');
    keypad.innerHTML = '';
    const addKey = (label, cls, fn) => {
        const btn = document.createElement('button');
        btn.className = 'math-key' + (cls ? ' ' + cls : '');
        btn.textContent = label;
        btn.onclick = fn;
        keypad.appendChild(btn);
    };
    for (let i = 1; i <= 9; i++) addKey(i, '', () => inputMath(i));
    addKey('C', 'clear', clearMath);
    addKey('0', '', () => inputMath(0));
    addKey('OK', 'submit', checkMath);

    document.getElementById('mathScore').textContent = '0';
    document.getElementById('mathTotal').textContent = problems;
    document.getElementById('mathFeedback').textContent = '';
    generateMathProblem();
    STATE.math.elapsed = startTimer(time_limit, 'mathTime', endMath);
}

function generateMathProblem() {
    const { max_num, ops } = session.params;
    const op = ops[Math.floor(Math.random() * ops.length)];
    let a, b, answer;

    if (op === '+') {
        a = 1 + Math.floor(Math.random() * max_num);
        b = 1 + Math.floor(Math.random() * max_num);
        answer = a + b;
    } else if (op === '-') {
        a = 2 + Math.floor(Math.random() * (max_num - 1));
        b = 1 + Math.floor(Math.random() * (a - 1));
        answer = a - b;
    } else {
        a = 2 + Math.floor(Math.random() * 9);
        b = 2 + Math.floor(Math.random() * 9);
        answer = a * b;
    }

    STATE.math.current = { answer };
    STATE.math.answer = '';
    STATE.math.shownAt = performance.now();
    document.getElementById('mathProblem').textContent = `${a} ${op} ${b} = ?`;
    document.getElementById('mathInput').textContent = '';
}

function inputMath(num) {
    if (STATE.math.done || STATE.math.answer.length >= 4) return;
    STATE.math.answer += num;
    document.getElementById('mathInput').textContent = STATE.math.answer;
}

function clearMath() {
    STATE.math.answer = '';
    document.getElementById('mathInput').textContent = '';
}

function checkMath() {
    const s = STATE.math;
    if (s.done || !s.answer) return;

    const ok = parseInt(s.answer, 10) === s.current.answer;
    sendAttempt(ok, (performance.now() - s.shownAt) / 1000);
    s.answered++;
    if (ok) s.score++;

    document.getElementById('mathScore').textContent = s.score;
    const fb = document.getElementById('mathFeedback');
    fb.textContent = ok ? 'Верно' : `Неверно, ответ ${s.current.answer}`;
    fb.className = 'math-feedback ' + (ok ? 'ok' : 'bad');

    if (s.answered >= s.total) endMath();
    else generateMathProblem();
}

function endMath() {
    const s = STATE.math;
    if (s.done) return;
    s.done = true;
    const time = s.elapsed();
    clearInterval(gameTimer);
    const won = s.score >= Math.ceil(s.total * 0.7);
    const accuracy = s.answered ? Math.round(s.score / s.answered * 100) : 0;
    showResult('math', won, s.score, s.total, {
        title: s.score >= 9 ? 'Отлично!' : won ? 'Хорошо!' : 'Попробуй ещё',
        sub: 'Математические цепочки',
        stats: [
            ['Правильных ответов', `${s.score}/${s.total}`],
            ['Точность', `${accuracy}%`],
            ['Время', `${time} сек`]
        ]
    });
}

function initColors() {
    show('colorsGame');
    STATE.colors = { sequence: [], input: [], level: 1, phase: 'show', lastClick: 0, done: false };
    document.getElementById('colorsLevel').textContent = '1';
    document.getElementById('colorsDisplay').innerHTML = '';
    setTimeout(startColorsRound, 500);
}

function setColorButtons(enabled) {
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.disabled = !enabled;
        btn.style.opacity = enabled ? '1' : '0.5';
        btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
    });
}

function startColorsRound() {
    const s = STATE.colors;
    if (s.done || currentGame !== 'colors') return;
    const length = session.params.start_length + s.level - 1;
    s.sequence = Array.from({ length }, () => COLORS[Math.floor(Math.random() * 4)]);
    s.input = [];
    s.phase = 'show';
    document.getElementById('colorsMessage').textContent = 'Запомни последовательность';
    document.getElementById('colorsDisplay').innerHTML = '';
    setColorButtons(false);
    showColorSequence(0);
}

function showColorSequence(index) {
    const s = STATE.colors;
    if (s.done || currentGame !== 'colors') return;
    const showMs = session.params.show_ms;
    const display = document.getElementById('colorsDisplay');

    if (index >= s.sequence.length) {
        setTimeout(() => {
            display.innerHTML = '';
            document.getElementById('colorsMessage').textContent = 'Повтори последовательность';
            s.phase = 'input';
            s.lastClick = performance.now();
            setColorButtons(true);
        }, 400);
        return;
    }

    const color = s.sequence[index];
    display.innerHTML = '';
    const dot = document.createElement('div');
    dot.className = 'shown-color';
    dot.style.background = COLOR_HEX[color];
    display.appendChild(dot);

    const btn = document.querySelector(`.color-btn.${color}`);
    btn.classList.add('flash');
    setTimeout(() => btn.classList.remove('flash'), showMs * 0.8);

    setTimeout(() => {
        display.innerHTML = '';
        setTimeout(() => showColorSequence(index + 1), 200);
    }, showMs);
}

function inputColor(color) {
    const s = STATE.colors;
    if (s.done || s.phase !== 'input') return;

    const now = performance.now();
    const idx = s.input.length;
    const ok = s.sequence[idx] === color;
    sendAttempt(ok, (now - s.lastClick) / 1000);
    s.lastClick = now;
    s.input.push(color);

    const dot = document.createElement('div');
    dot.className = 'shown-color';
    dot.style.background = COLOR_HEX[color];
    document.getElementById('colorsDisplay').appendChild(dot);

    if (!ok) {
        endColors(false);
        return;
    }

    if (s.input.length === s.sequence.length) {
        s.phase = 'show';
        setColorButtons(false);
        if (s.level >= session.params.levels) {
            endColors(true);
            return;
        }
        s.level++;
        document.getElementById('colorsLevel').textContent = s.level;
        document.getElementById('colorsMessage').textContent = 'Правильно!';
        setTimeout(startColorsRound, 1000);
    }
}

function endColors(won) {
    const s = STATE.colors;
    if (s.done) return;
    s.done = true;
    const passed = won ? s.level : s.level - 1;
    showResult('colors', won, passed, session.params.levels, {
        title: won ? 'Отлично!' : 'Ошибка!',
        sub: 'Цветовая память',
        stats: [
            ['Пройдено уровней', `${passed}/${session.params.levels}`],
            ['Длина последней цепочки', s.sequence.length]
        ]
    });
}

async function showResult(type, won, score, maxScore, view) {
    STATE.lastGame = type;
    currentGame = null;
    const before = session.difficulty;

    show('resultScreen');
    document.getElementById('rIcon').textContent = won ? '🎉' : '💪';
    document.getElementById('rTitle').textContent = view.title;
    document.getElementById('rSub').textContent = view.sub;

    const render = rows => {
        document.getElementById('rStats').innerHTML = rows.map(([l, v]) =>
            `<div class="result-row"><span>${l}</span><span>${v}</span></div>`
        ).join('');
    };
    render(view.stats);

    const d = await finishSession(score, maxScore, won);
    if (!d) return;
    loadStats();
    if (d.attempts_in_window < 5) {
        render([...view.stats, ['Сложность', `${before.toFixed(1)} (мало данных для пересчёта)`]]);
        return;
    }
    render([
        ...view.stats,
        ['Среднее время хода', `${d.window_reaction_time} сек`],
        ['Сложность', `была ${before.toFixed(1)}, стала ${d.new_difficulty.toFixed(1)}`]
    ]);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

loadStats();
