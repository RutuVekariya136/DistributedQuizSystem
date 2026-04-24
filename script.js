const socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: Infinity });

const views = {
    login: document.getElementById('login-screen'),
    lobby: document.getElementById('lobby-screen'),
    quiz: document.getElementById('quiz-screen'),
    intermission: document.getElementById('intermission-screen'),
    results: document.getElementById('results-screen')
};

function switchView(target) {
    Object.values(views).forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); });
    target.classList.remove('hidden');
    target.classList.add('active');
}

function showToast(msg, type = 'success') {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerText = msg;
    c.appendChild(t);
    setTimeout(() => t.remove(), 5000);
}

// ── State ──
let myName = '';
let myRoomCode = '';
let currentQuestionIndex = -1;
let optionBtns = [];
let answerSubmitted = false;

// ── Persist for reconnect ──
function saveSession() {
    if (myName && myRoomCode) {
        sessionStorage.setItem('qp_name', myName);
        sessionStorage.setItem('qp_room', myRoomCode);
    }
}

// ── Heartbeat ──
socket.on('ping', (ts) => socket.emit('pong', ts));

// ── Anti-Cheat: Tab Switch Detection ──
document.addEventListener('visibilitychange', () => {
    if (document.hidden && myRoomCode) {
        // Only flag if quiz is active or in lobby
        socket.emit('tab_switch', { roomCode: myRoomCode });
        const warning = document.getElementById('tab-warning');
        if (warning) {
            warning.style.display = 'block';
            // Vibrate if mobile
            if (navigator.vibrate) navigator.vibrate(200);
            
            // Auto hide only after returning and waiting 3s
        }
    } else if (!document.hidden) {
        setTimeout(() => {
            const warning = document.getElementById('tab-warning');
            if (warning) warning.style.display = 'none';
        }, 3000);
    }
});

// ── Join ──
document.getElementById('join-btn').addEventListener('click', attemptJoin);
document.getElementById('username').addEventListener('keypress', e => { if (e.key === 'Enter') document.getElementById('roomcode').focus(); });
document.getElementById('roomcode').addEventListener('keypress', e => { if (e.key === 'Enter') attemptJoin(); });

function attemptJoin() {
    const name = document.getElementById('username').value.trim();
    const code = document.getElementById('roomcode').value.trim().toUpperCase();
    if (!name) return showToast('Please enter your name.', 'error');
    if (!code || code.length < 4) return showToast('Please enter the room code.', 'error');
    myName = name;
    myRoomCode = code;
    saveSession();
    socket.emit('join_room', { name, roomCode: code });
}

// ── Socket reconnect → re-join automatically ──
socket.on('connect', () => {
    const name = myName || sessionStorage.getItem('qp_name');
    const code = myRoomCode || sessionStorage.getItem('qp_room');
    if (name && code && views.login.classList.contains('hidden')) {
        myName = name;
        myRoomCode = code;
        socket.emit('join_room', { name, roomCode: code });
    }
});

// ── Lobby ──
socket.on('joined', (data) => {
    myRoomCode = data.roomCode;
    saveSession();
    document.getElementById('room-code-display').innerText = `Room Code: ${data.roomCode}`;
    document.getElementById('lobby-title').innerHTML = data.quizTitle ?
        `${data.quizTitle}` : 'Get Ready';
    switchView(views.lobby);
});

socket.on('user_list', (users) => {
    const ul = document.getElementById('users-waiting');
    ul.innerHTML = '';
    document.getElementById('user-count').innerText = users.length;
    users.forEach(u => {
        const li = document.createElement('li');
        li.className = 'rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300 ring-1 ring-inset ring-white/5 flex items-center gap-2';
        li.innerHTML = `
            <span class="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
            ${u}${u === myName ? ' <span class="text-[10px] text-indigo-400 font-bold uppercase">(You)</span>' : ''}
        `;
        ul.appendChild(li);
    });
});

socket.on('error_message', msg => showToast(msg, 'error'));

socket.on('quiz_reset', () => {
    answerSubmitted = false;
    currentQuestionIndex = -1;
    if (myName) switchView(views.lobby);
});

socket.on('quiz_starting', data => {
    document.getElementById('lobby-title').innerHTML = `Starting: <span style="color:var(--primary)">${data.title}</span>`;
    showToast('The quiz is starting...');
    
    // Show countdown overlay
    const overlay = document.getElementById('start-countdown-overlay');
    const numberEl = document.getElementById('start-countdown-number');
    if (overlay && numberEl) {
        overlay.classList.remove('hidden');
        numberEl.innerText = data.countdown || 5;
    }
});

socket.on('countdown_tick', count => {
    const numberEl = document.getElementById('start-countdown-number');
    if (numberEl) {
        numberEl.innerText = count;
        // Visual feedback for each tick
        numberEl.style.transform = 'scale(1.2)';
        setTimeout(() => numberEl.style.transform = 'scale(1)', 200);
    }
    if (count <= 0) {
        const overlay = document.getElementById('start-countdown-overlay');
        if (overlay) overlay.classList.add('hidden');
    }
});

// ── Quiz ──
socket.on('new_question', (data) => {
    currentQuestionIndex = data.index;
    answerSubmitted = false;
    
    // Safety check: hide overlay
    const overlay = document.getElementById('start-countdown-overlay');
    if (overlay) overlay.classList.add('hidden');

    document.getElementById('question-progress').innerText = `Question ${data.index + 1} of ${data.total}`;
    document.getElementById('question-text').innerText = data.question;
    document.getElementById('consensus-bar').style.width = '0%';
    document.getElementById('consensus-text').innerText = `0 / 0`;

    const container = document.getElementById('options-container');
    container.innerHTML = '';
    optionBtns = [];

    data.options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = 'w-full text-left rounded-xl bg-slate-800/50 p-5 text-lg font-medium text-slate-200 border border-white/5 hover:bg-slate-800 hover:border-indigo-500/50 transition-all active:scale-[0.99] group flex justify-between items-center';
        btn.innerHTML = `
            <span>${opt}</span>
            <span class="opacity-0 group-hover:opacity-100 transition-opacity text-indigo-500 text-sm font-bold uppercase tracking-widest">Select →</span>
        `;
        btn.addEventListener('click', () => {
            if (answerSubmitted) return;
            optionBtns.forEach(b => {
                b.classList.remove('ring-2', 'ring-indigo-500', 'bg-indigo-500/10', 'border-indigo-500/20');
                b.classList.add('opacity-50');
            });
            btn.classList.add('ring-2', 'ring-indigo-500', 'bg-indigo-500/10', 'border-indigo-500/20');
            btn.classList.remove('opacity-50');
            answerSubmitted = true;
            socket.emit('submit_answer', { index: currentQuestionIndex, option: opt, roomCode: myRoomCode });
            optionBtns.forEach(b => { b.style.pointerEvents = 'none'; });
        });
        container.appendChild(btn);
        optionBtns.push(btn);
    });

    switchView(views.quiz);
});

socket.on('consensus_update', (data) => {
    if (data.total === 0) return;
    const pct = (data.committed / data.total) * 100;
    const bar = document.getElementById('consensus-bar');
    const text = document.getElementById('consensus-text');
    bar.style.width = `${pct}%`;
    bar.style.background = pct === 100 ? 'var(--success)' : 'var(--primary)';
    text.innerText = pct === 100 ? `${data.committed} / ${data.total} (Everyone Finished)` : `${data.committed} / ${data.total}`;
    if (pct === 100) text.style.color = 'var(--success)';
});

socket.on('timer_update', (timeLeft) => {
    const el = document.getElementById('timer');
    el.innerText = timeLeft;
    if (timeLeft <= 5) el.classList.add('warning');
    else el.classList.remove('warning');
});

socket.on('question_result', (data) => {
    optionBtns.forEach(btn => {
        btn.style.pointerEvents = 'none';
        const optText = btn.querySelector('span').innerText;
        if (optText === data.correct) {
            btn.classList.remove('ring-indigo-500', 'bg-indigo-500/10', 'border-indigo-500/20', 'opacity-50');
            btn.classList.add('ring-2', 'ring-emerald-500', 'bg-emerald-500/10', 'border-emerald-500/50', 'text-emerald-400');
            btn.innerHTML = `
                <span>${optText}</span>
                <span class="text-emerald-500 text-[10px] font-black uppercase tracking-[0.2em]">Correct</span>
            `;
        } else if (btn.classList.contains('ring-indigo-500')) {
            btn.classList.remove('ring-indigo-500', 'bg-indigo-500/10', 'border-indigo-500/20', 'opacity-50');
            btn.classList.add('ring-2', 'ring-rose-500/50', 'bg-rose-500/5', 'text-rose-400');
            btn.innerHTML = `
                <span>${optText}</span>
                <span class="text-rose-500 text-[10px] font-black uppercase tracking-[0.2em]">Incorrect</span>
            `;
        } else {
            btn.classList.add('opacity-30', 'grayscale');
        }
    });
});

// ── Leaderboard helper ──
function renderLeaderboard(el, results) {
    el.innerHTML = '';
    results.forEach((r, i) => {
        const li = document.createElement('li');
        const isMe = r.name === myName;
        const rankColor = i === 0 ? 'text-amber-400' : i === 1 ? 'text-slate-300' : i === 2 ? 'text-orange-400' : 'text-slate-500';
        
        li.className = `flex items-center justify-between rounded-xl bg-slate-950/50 p-4 border border-white/5 ${isMe ? 'ring-1 ring-indigo-500/50 bg-indigo-500/5' : ''}`;
        li.innerHTML = `
            <div class="flex items-center gap-4">
                <span class="text-lg font-black ${rankColor} font-mono w-6 font-bold leading-none">${i + 1}</span>
                <span class="text-sm font-bold ${isMe ? 'text-white' : 'text-slate-300'}">${r.name}${isMe ? ' <span class="ml-1 text-[10px] text-indigo-400 font-bold uppercase tracking-widest">(You)</span>' : ''}</span>
            </div>
            <span class="text-sm font-black text-white font-mono">${r.score}</span>
        `;
        el.appendChild(li);
    });
}

socket.on('intermission_state', (data) => {
    switchView(views.intermission);
    renderLeaderboard(document.getElementById('intermission-list'), data.scoreboard);
});

socket.on('quiz_ended', ({ results }) => {
    currentQuestionIndex = -1;
    sessionStorage.removeItem('qp_name');
    sessionStorage.removeItem('qp_room');
    switchView(views.results);
    renderLeaderboard(document.getElementById('final-score-list'), results);
});

// ── Reactions ──
window.sendReaction = (emoji) => {
    if (myRoomCode) socket.emit('send_reaction', emoji);
};

socket.on('receive_reaction', (data) => {
    const el = document.createElement('div');
    el.className = 'reaction-fly';
    el.innerText = data.emoji;
    el.style.left = `${10 + Math.random() * 80}vw`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
});

socket.on('streak_alert', (data) => {
    showToast(`${data.name} is on a ${data.streak}-question streak! 🎯`, 'alert');
});
