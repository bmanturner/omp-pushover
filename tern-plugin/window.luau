--!strict
-- Controls for the omp-pushover extension: palette commands that edit its
-- state file (~/.config/omp-pushover/state.json, shared with omp) and a
-- status-line segment showing the mode. Times are Unix seconds.

type State = {
	mode: string,
	away_until: number?,
	snooze_until: number?,
	armed: { string },
	last_error: string?,
}

local HOME = tern.getenv("HOME")
local DIR = if HOME then HOME .. "/.config/omp-pushover" else nil
local PATH = if DIR then DIR .. "/state.json" else nil
local REFRESH_MS = 15000
local NEXT_MODE = { auto = "always", always = "off", off = "auto" }

local cached: State? = nil
local tick: TimerHandle? = nil

local function read_state(): State
	local s: State = { mode = "auto", armed = {} }
	if PATH == nil then
		return s
	end
	local ok, text = pcall(tern.fs.read, PATH :: string, 65536)
	if not ok then
		return s
	end
	local okd, raw = pcall(tern.json.decode, text)
	if not okd or type(raw) ~= "table" then
		return s
	end
	if raw.mode == "auto" or raw.mode == "always" or raw.mode == "off" then
		s.mode = raw.mode
	end
	if type(raw.away_until) == "number" then
		s.away_until = raw.away_until
	end
	if type(raw.snooze_until) == "number" then
		s.snooze_until = raw.snooze_until
	end
	if type(raw.last_error) == "string" then
		s.last_error = raw.last_error
	end
	if type(raw.armed) == "table" then
		for _, k in raw.armed do
			if type(k) == "string" then
				table.insert(s.armed, k)
			end
		end
	end
	return s
end

local function write_state(s: State)
	tern.fs.mkdir(DIR :: string)
	tern.fs.write(
		PATH :: string,
		tern.json.encode({
			mode = s.mode,
			away_until = s.away_until or tern.json.null,
			snooze_until = s.snooze_until or tern.json.null,
			armed = tern.json.array(s.armed),
			last_error = s.last_error or tern.json.null,
		}, true)
	)
end

local function effective(s: State, now: number): string
	if s.snooze_until and s.snooze_until > now then
		return "snooze"
	end
	if s.away_until and s.away_until > now then
		return "away"
	end
	return s.mode
end

local function remaining(sec: number): string
	if sec >= 3600 then
		return string.format("%dh%02dm", sec // 3600, (sec % 3600) // 60)
	end
	return string.format("%dm", math.max(1, sec // 60))
end

local function status_text(s: State, now: number): string
	local eff = effective(s, now)
	if eff == "snooze" then
		return "push: snoozed " .. remaining((s.snooze_until :: number) - now)
	elseif eff == "away" then
		return "push: away " .. remaining((s.away_until :: number) - now)
	end
	return "push: " .. eff
end

local function pane_key(pane: number): string
	return "pane:" .. string.format("%.0f", pane)
end

local function refresh_cache()
	cached = if PATH then read_state() else nil
	tern.chrome.refresh()
end

-- One timer at a time; the state file may change from omp at any moment.
local function schedule()
	if tick ~= nil then
		return
	end
	tick = tern.timer(REFRESH_MS, function(_cx: WindowCx?)
		tick = nil
		refresh_cache()
		schedule()
	end)
end

-- Runs `change` on the current state, saves it and reports the new mode.
local function update(cx: WindowCx, change: (State) -> ())
	if PATH == nil then
		cx:toast("error", "omp-pushover: HOME is not set")
		return
	end
	local s = read_state()
	change(s)
	local ok, err = pcall(write_state, s)
	if not ok then
		cx:toast("error", "omp-pushover: could not save state", tostring(err))
		return
	end
	refresh_cache()
	cx:toast("success", status_text(s, os.time()))
end

local function set_mode(mode: string): (State) -> ()
	return function(s: State)
		s.mode = mode
		s.away_until = nil
		s.snooze_until = nil
	end
end

for _, mode in { "auto", "always", "off" } do
	tern.command({
		id = mode,
		title = "Phone push: " .. string.upper(string.sub(mode, 1, 1)) .. string.sub(mode, 2),
		group = "Phone push",
		run = function(cx: WindowCx)
			update(cx, set_mode(mode))
		end,
	})
end

tern.command({
	id = "away",
	title = "Phone push: Away for 4 hours",
	group = "Phone push",
	run = function(cx: WindowCx)
		update(cx, function(s: State)
			s.away_until = os.time() + 4 * 3600
			s.snooze_until = nil
		end)
	end,
})

tern.command({
	id = "snooze",
	title = "Phone push: Snooze for 1 hour",
	group = "Phone push",
	run = function(cx: WindowCx)
		update(cx, function(s: State)
			s.snooze_until = os.time() + 3600
			s.away_until = nil
		end)
	end,
})

tern.command({
	id = "arm",
	title = "Phone push: Notify me when this agent finishes",
	group = "Phone push",
	run = function(cx: WindowCx)
		local pane = cx.session:focused()
		if pane == nil then
			cx:toast("error", "No focused pane")
			return
		end
		local key = pane_key(pane)
		update(cx, function(s: State)
			if not table.find(s.armed, key) then
				table.insert(s.armed, key)
			end
		end)
	end,
})

tern.command({
	id = "cycle",
	title = "Phone push: Cycle mode",
	group = "Phone push",
	run = function(cx: WindowCx)
		local s = read_state()
		update(cx, set_mode(NEXT_MODE[s.mode] or "auto"))
	end,
})

-- Pure: answers from the cache the timer and commands fill.
tern.chrome.status(function(pane: StatusPaneInfo): { StatusSegment }?
	local s = cached
	if s == nil then
		return nil
	end
	local now = os.time()
	local text = status_text(s, now)
	if table.find(s.armed, pane_key(pane.pane)) then
		text ..= " · armed"
	end
	local eff = effective(s, now)
	local tone: string? = nil
	if s.last_error then
		tone = "error"
	elseif eff == "off" or eff == "snooze" then
		tone = "muted"
	end
	return { { text = text, tone = tone, command = "plugin.omp-pushover.cycle" } }
end)

-- A reload need not emit window_start, so start here too.
tern.on("window_start", function(_cx: WindowCx)
	refresh_cache()
	schedule()
end)
cached = if PATH then read_state() else nil
schedule()
