const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DAY_STARTS_AT_HOUR = 4;
const TURN_OFF_MS = 1000 * 60 * 3;

////////////////////////////////////////// controller interface

let win = null;
let viewDir = null;
let firstTimeInitDone = false;

function injectFunction(destWindow, func, value) {
	func = func.toString();
	func = func.slice(func.indexOf("{") + 1, func.lastIndexOf("}"));
	func = `((function(value){ ${func} })(${JSON.stringify(value)}))`;
	destWindow.webContents.executeJavaScript(func);
}

function initialize(currentWin, viewDirectory) {
	viewDir = viewDirectory;
	if (!firstTimeInitDone) {
		firstTimeInit();
		firstTimeInitDone = true;
	}
	win = currentWin;
	injectFunction(win, timeLogControl, timeLogHTML);
	win.webContents.insertCSS(timeLogCSS);
	setTimeout(() => updateState({}), 300);
	startMonitor();
}

function uninitialize() {
	stopMonitor();
	if (afkWindow !== undefined && !afkWindow.isDestroyed()) {
		afkWindow.close();
	}
	if (simpleWindow !== undefined && !simpleWindow.isDestroyed()) {
		simpleWindow.close();
	}
}

ipcMain.on('work-log', (event, value) => {
	onCommand(value);
});

exports.initialize = initialize;
exports.uninitialize = uninitialize;

/////////////////////////////////////////// Main logic

function toTime(ms) {
	let min = Math.round(ms / 1000 / 60);
	let sign = min < 0 ? '-' : '';
	min = Math.abs(min);
	let h = Math.floor(min / 60);
	min -= 60 * h;
	if (min < 10) min = '0' + min;
	return sign + h + ':' + min;
}

function getDay(t) {
	let date = new Date(t || Date.now());
	date.setSeconds(date.getSeconds() - 60 * 60 * DAY_STARTS_AT_HOUR);
	return date.toDateString();
}

let state;

const stateFiles = [
	path.join(app.getPath('userData'), 'work-log-state1.json'),
	path.join(app.getPath('userData'), 'work-log-state2.json'),
	path.join(app.getPath('userData'), 'work-log-state3.json')
];

const logFile = path.join(app.getPath('logs'), 'work-log.log');

function log(time, text) {
	let s = state.mode;
	if (state.isBreak) {
		s += ', break';
	}
	if (state.afk) {
		s += ', AFK';
	}
	if (state.lock) {
		s += ', lock';
	}
	s += `, ${toTime(state.done)}/${toTime(state.mode == 'home' ? state.homeTodo : state.officeTodo)}>${toTime(state.overtime)}`;
	let line = `${(new Date(time)).toLocaleString('en-GB')}   ${text} (${s})\n`;
	let fd = fs.openSync(logFile, 'a');
	fs.writeSync(fd, line);
	fs.closeSync(fd);
	console.log(line);
}

function loadStateFrom(file) {
	try {
		let text = fs.readFileSync(file, 'utf-8').trim();
		let hash = text.substring(text.length - 40);
		let json = text.substring(0, text.length - 40).trim();
		let algo = crypto.createHash('sha1');
		algo.update(json);
		if (algo.digest('hex').toLowerCase() != hash.toLowerCase() && hash != '----------------------------------------') {
			return null;
		}
		return JSON.parse(json);
	} catch (ex) {
		return null;
	}
}

function writeStateToFile(file, state) {
	let json = JSON.stringify(state, null, 4).trim();
	let algo = crypto.createHash('sha1');
	algo.update(json);
	let hash = algo.digest('hex');
	fs.writeFileSync(file, json + '\n' + hash);
}

function loadState() {
	let bestState = null;
	for (let file of stateFiles) {
		let loaded = loadStateFrom(file);
		if (loaded === null) {
			continue;
		} else if (bestState === null || loaded.lastUpdate > bestState.lastUpdate) {
			bestState = loaded;
		}
	}
	if (bestState === null) {
		state = {
			day: getDay(),
			mode: 'office',
			isBreak: false,
			afk: false,
			lock: false,
			done: 0,
			homeTodo: (7 * 60 + 30) * 60 * 1000,
			officeTodo: 8 * 60 * 60 * 1000,
			overtime: 0,
			lastUpdate: Date.now(),
		};
		log(Date.now(), `!!!!!! LOST CURRENT STATE`);
	} else {
		state = bestState;
	}
	log(Date.now(), `Application startup.`);
	updateState({}, true);
}

function writeState() {
	for (let file of stateFiles) {
		writeStateToFile(file, state);
	}
}

function updateState(newState, firstUpdate, now, day) {
	now = now || Date.now();
	day = day || getDay(now);
	if (day != state.day) {
		state.day = day;
		state.isBreak = false;
		state.afk = false;
		let overtimeAdd;
		if (state.mode == 'home') {
			overtimeAdd = state.done - state.homeTodo;
			log(state.lastUpdate, `Day ended after ${toTime(state.done)} of ${toTime(state.homeTodo)}.`);
		} else {
			overtimeAdd = state.done - state.officeTodo;
			log(state.lastUpdate, `Day ended after ${toTime(state.done)} of ${toTime(state.officeTodo)}.`);
		}
		log(state.lastUpdate, `Overtime update ${toTime(overtimeAdd)}.`);
		state.overtime += overtimeAdd;
		state.done = 0;
		state.lastUpdate = now;
		log(now, '============== STARTING A DAY ==============');
	} else if (firstUpdate && now - state.lastUpdate > TURN_OFF_MS) {
		log(state.lastUpdate + TURN_OFF_MS, 'Power Off detected');
		updateState({ lock: true }, false, state.lastUpdate + TURN_OFF_MS, state.day);
		newState = { ...newState, lock: false };
	}
	let countAsWork = !state.isBreak && (state.mode == 'office' || state.afk || !state.lock);
	if (countAsWork) {
		let timeSpan = now - state.lastUpdate;
		state.done += timeSpan;
	}

	if (newState.mode !== undefined && state.mode != newState.mode) {
		log(now, `Changed mode from "${state.mode}" to "${newState.mode}"`);
		state.mode = newState.mode;
	}
	if (newState.isBreak !== undefined && state.isBreak != newState.isBreak) {
		log(now, newState.isBreak ? 'Start of break' : 'End of break');
		state.isBreak = newState.isBreak;
	}
	if (newState.afk !== undefined && state.afk != newState.afk) {
		log(now, newState.afk ? 'Start of work away from keyboard' : 'End of work away from keyboard');
		state.afk = newState.afk;
	}
	if (newState.lock !== undefined && state.lock != newState.lock) {
		log(now, newState.lock ? 'Locked screen' : 'Unlocked screen');
		state.lock = newState.lock;
	}
	if (newState.homeTodo !== undefined && state.homeTodo != newState.homeTodo) {
		log(now, `Changed time to do at home from ${toTime(state.homeTodo)} to ${toTime(newState.homeTodo)}`);
		state.homeTodo = newState.homeTodo;
	}
	if (newState.officeTodo !== undefined && state.officeTodo != newState.officeTodo) {
		log(now, `Changed time to do at office from ${toTime(state.officeTodo)} to ${toTime(newState.officeTodo)}`);
		state.officeTodo = newState.officeTodo;
	}
	if (newState.done !== undefined && newState.done != 0) {
		log(now, `Work done time changed by ${toTime(newState.done)}, from ${toTime(state.done)} to ${toTime(state.done + newState.done)}`);
		state.done += newState.done;
	}
	if (newState.overtime !== undefined && state.overtime != newState.overtime) {
		log(now, `Changed overtime from ${toTime(state.overtime)} to ${toTime(newState.overtime)}`);
		state.overtime = newState.overtime;
	}
	state.lastUpdate = now;
	writeState();

	let newCountAsWork = !state.isBreak && (state.mode == 'office' || state.afk || !state.lock);

	if (newCountAsWork != countAsWork || firstUpdate) {
		log(now, newCountAsWork ? `Started counting work time.` : `Ended counting work time.`);
	}

	let todo = (state.mode == 'home') ? state.homeTodo : state.officeTodo;
	if (win != null && !win.isDestroyed() && !win.webContents.isDestroyed()) {
		let guiState = {
			mode: state.mode,
			isBreak: state.isBreak,
			afk: state.afk,
			done: (state.done > todo) ? todo : state.done,
			todo: todo,
			overtime: (state.done > todo) ? state.overtime + (state.done - todo) : state.overtime,
		};
		win.webContents.send('work-log', guiState);
		if (simpleWindow !== undefined && !simpleWindow.isDestroyed()) {
			simpleWindow.webContents.send('work-log-state', state);
		}
		if (afkWindow === undefined && state.afk) {
			showAfkWindow();
		}
	}
}

let afkWindow;
let simpleWindow;

function showAfkWindow() {
	if (afkWindow !== undefined) {
		return;
	}

	afkWindow = new BrowserWindow({
		autoHideMenuBar: true,
		frame: false,
		show: false,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false
		}
	});
	//afkWindow.webContents.openDevTools();
	afkWindow.loadURL(`file://${path.join(viewDir, 'afk.html')}`);
	afkWindow.setAlwaysOnTop(true);

	let wa = screen.getPrimaryDisplay().workArea;
	afkWindow.setBounds({ x: wa.x + 100, y: wa.y + 100, width: wa.width - 200, height: wa.height - 200 });
	afkWindow.show();

	afkWindow.on('closed', event => {
		let tmp = afkWindow;
		afkWindow = undefined;
		tmp.destroy();
	});

	afkWindow.show();
}

function hideAfkWindow() {
	if (afkWindow !== undefined) {
		afkWindow.close();
	}
}

function showSimpleWindow(file) {
	if (simpleWindow !== undefined) {
		simpleWindow.focus();
	} else {
		simpleWindow = new BrowserWindow({
			autoHideMenuBar: true,
			webPreferences: {
				nodeIntegration: true,
				contextIsolation: false
			}
		});
		simpleWindow.on('closed', event => {
			let tmp = simpleWindow;
			simpleWindow = undefined;
			tmp.destroy();
		});
		//simpleWindow.webContents.openDevTools();
	}
	simpleWindow.loadURL(`file://${path.join(viewDir, file)}`);
}

function hideSimpleWindow() {
	if (simpleWindow !== undefined) {
		simpleWindow.close();
	}
}

function onCommand(value) {
	switch (value.cmd) {
		case 'office':
		case 'home':
			updateState({ mode: value.cmd });
			break;
		case 'end-break':
			updateState({ isBreak: false });
			break;
		case 'break':
			updateState({ isBreak: true });
			break;
		case 'afk':
			showAfkWindow();
			updateState({ afk: true });
			break;
		case 'end-afk':
			updateState({ afk: false });
			hideAfkWindow();
			break;
		case 'change':
			showSimpleWindow('change.html');
			break;
		case 'history':
			showSimpleWindow('history.html');
			break;
		case 'update':
			updateState(value.state);
			break;
		case 'end-change':
			hideSimpleWindow();
			break;
		case 'get-history':
			if (simpleWindow !== undefined && !simpleWindow.isDestroyed()) {
				simpleWindow.webContents.send('work-log-history', logFile);
			}
			break;
	}
}

let changingState;
let outputBuffer;
let monitor;

function startMonitor() {

	if (monitor != undefined) {
		return;
	}

	changingState = false;
	outputBuffer = '';
	monitor = spawn('dbus-monitor', [`--session`, `type='signal',interface='org.gnome.ScreenSaver'`]);

	monitor.stdout.on('data', (data) => {
		outputBuffer += data.toString();
		let pos = outputBuffer.indexOf('\n');
		while (pos >= 0) {
			let m;
			let line = outputBuffer.substring(0, pos);
			outputBuffer = outputBuffer.substring(pos + 1);
			if (line.match(/member=ActiveChanged/)) {
				changingState = true;
			} else if (changingState && (m = line.match(/boolean\s+(true|false)/i))) {
				let value = (m[1].toLowerCase() == 'true');
				changingState = false;
				updateState({ lock: value });
			} else {
				changingState = false;
			}
			pos = outputBuffer.indexOf('\n');
		}
	});

	monitor.stderr.on('data', (data) => {
	});

	monitor.on('close', (code) => {
		console.log(`child process exited with code ${code}`);
	});

	updateState({ lock: false });
}

function stopMonitor() {
	if (monitor !== undefined) {
		monitor.kill();
		monitor = undefined;
	}
}

function firstTimeInit() {
	loadState();
	setInterval(() => updateState({}), 30 * 1000);
	startMonitor();
}

/////////////////////////////////////////// renderer site


function timeLogControl(value) {
	if (window._timeLog) return;
	window._timeLog = true;

	const { ipcRenderer } = require('electron');

	function toPixels(frac) {
		return Math.max(0, Math.min(150, Math.round(150 * frac))) + 'px';
	}

	function toTime(ms) {
		let min = Math.round(ms / 1000 / 60);
		let sign = min < 0 ? '-' : '';
		min = Math.abs(min);
		let h = Math.floor(min / 60);
		min -= 60 * h;
		if (min < 10) min = '0' + min;
		return sign + h + ':' + min;
	}

	function onUpdate(state) {
		let { mode, isBreak, afk, done, todo, overtime } = state;
		if (isBreak) {
			for (let e of document.querySelectorAll('.work-log-buttons>button')) {
				e.style.display = 'none';
			}
			document.getElementById('work-log-end-break').style.display = '';
		} else if (afk) {
			for (let e of document.querySelectorAll('.work-log-buttons>button')) {
				e.style.display = 'none';
			}
			document.getElementById('work-log-end-afk').style.display = '';
		} else {
			for (let e of document.querySelectorAll('.work-log-buttons>button')) {
				e.style.display = '';
			}
			document.getElementById('work-log-end-break').style.display = 'none';
			document.getElementById('work-log-end-afk').style.display = 'none';
			if (mode == 'office') {
				document.getElementById('work-log-home').style.display = 'none';
			} else {
				document.getElementById('work-log-office').style.display = 'none';
			}
		}
		let total = todo + Math.abs(overtime);
		document.getElementById('work-log-bar-done').style.width = toPixels(done / total);
		document.getElementById('work-log-bar-left').style.width = toPixels((todo - done) / total);
		if (overtime > 0) {
			document.getElementById('work-log-down').style.display = 'none';
			document.getElementById('work-log-up').style.display = '';
			document.querySelector('.work-log-bar').classList.add('work-log-bar-plus');
		} else {
			document.getElementById('work-log-up').style.display = 'none';
			document.getElementById('work-log-down').style.display = '';
			document.querySelector('.work-log-bar').classList.remove('work-log-bar-plus');
		}
		document.getElementById('work-log-done').innerText = toTime(done);
		document.getElementById('work-log-todo').innerText = toTime(todo);
		document.getElementById('work-log-overtime').innerText = toTime(Math.abs(overtime));
	}

	function onCommand(cmd) {
		ipcRenderer.send('work-log', { cmd: cmd });
	}

	let div = document.createElement('div');
	div.innerHTML = value;
	document.body.appendChild(div);
	for (let e of document.querySelectorAll('.work-log-buttons>button')) {
		e.addEventListener('click', event => {
			onCommand(e.getAttribute('data-work-log-command'));
		});
	}

	ipcRenderer.on('work-log', (event, state) => {
		onUpdate(state);
	});

	ipcRenderer.send('work-log', { cmd: 'update', state: {} });
}


const timeLogHTML = `
<div class="work-log-control">
    <div class="work-log-label">
	<span id="work-log-done">3:45</span>
	/
	<span id="work-log-todo">7:30</span>
	<span id="work-log-up">▲</span>
	<span id="work-log-down">▼</span>
	<span id="work-log-overtime">1:33</span>
    </div>
    <div class="work-log-bar">
	<div id="work-log-bar-done"></div>
	<div id="work-log-bar-left"></div>
    </div>
    <div class="work-log-buttons">
	<button data-work-log-command="office" id="work-log-home">🏠&nbsp;Home</button>
	<button data-work-log-command="home" id="work-log-office">🏢&nbsp;Office</button>
	<button data-work-log-command="end-break" id="work-log-end-break">❌&nbsp;End&nbsp;Break</button>
	<button data-work-log-command="break">Break</button>
	<button data-work-log-command="afk">&nbsp;AFK&nbsp;</button>
	<button data-work-log-command="end-afk" id="work-log-end-afk">❌&nbsp;End&nbsp;AFK</button>
	<button data-work-log-command="change">Change</button>
	<button data-work-log-command="history">History</button>
    </div>
</div>
`;

const timeLogCSS = `
.work-log-control {
    position: fixed;
    top: 3px;
    left: 48px;
    width: 150px;
    height: 42px;
    background-color: #212121;
    color: white;
    z-index: 10000000;
    font-size: 12px;
    font-family: sans-serif;
}

.work-log-label {
    width: 150px;
    position: absolute;
    /*text-shadow: -1px -1px 2px #FFF8, -1px 0px 2px #FFF8, -1px 1px 2px #FFF8, 0px -1px 2px #FFF8, 0px 1px 2px #FFF8, 1px -1px 2px #FFF8, 1px 0px 2px #FFF8, 1px 1px 2px #FFF8;
    color: white;*/
    text-align: center;
    padding-top: 2px;
}

.work-log-bar {
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    justify-content: flex-start;
    align-items: stretch;
    align-content: flex-start;
    background: #690700;
    box-shadow: inset 0px 0px 3px #fff2ba60;
}

.work-log-bar-plus {
    background: #2f5317;
}

.work-log-bar>div {
    height: 19px;
    padding: 0px 0px;
    margin: 0px;
    box-shadow: inset 0px 0px 3px #fff2ba60;
}

#work-log-bar-done {
    background: #44508a;
}

#work-log-bar-left {
    background: #3d3d3d;
}

.work-log-buttons {
    display: flex;
    flex-direction: row;
    flex-wrap: nowrap;
    justify-content: left;
    align-items: left;
    align-content: flex-start;
    height: 23px;
    overflow: hidden;
    background-color: #212121;
}

.work-log-buttons:hover {
    width: fit-content;
    overflow: visible;
}

.work-log-buttons>button {
    display: block;
    margin: 1px;
    padding: 0px 1px;
    border: 1px solid #474747;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    background-color: #313131;
    color: #a7a7a7;
}

.work-log-buttons>button:hover {
    background-color: #757575;
    color: #000000;
    border: 1px solid #949494;
}
`;
