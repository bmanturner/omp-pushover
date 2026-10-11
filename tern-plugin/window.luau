--!strict
-- Controls for the omp-pushover extension: palette commands that edit its
-- state file (~/.config/omp-pushover/state.json, shared with omp) and a
-- status-line segment showing the mode. Times are Unix seconds.
--
-- Arms name panes by the id omp reads from $TERN_PANE. A window's pane ids
-- are its own (Tern renumbers them for Lua, and they need not equal
-- $TERN_PANE), so this plugin finds a pane's $TERN_PANE in `tern ls`, which
-- lists those ids, by the pane's title and directory.

type State = {
	mode: string,
	away_until: number?,
	snooze_until: number?,
	armed: { string },
	last_error: string?,
}

-- A pane as `tern ls --json` lists it; `shown` when it is the focused pane of
-- the shown tab.
type Block = { key: string, title: string, cwd: string?, shown: boolean }

local HOME = tern.getenv("HOME")
local DIR = if HOME then HOME .. "/.config/omp-pushover" else nil
local PATH = if DIR then DIR .. "/state.json" else nil
local REFRESH_MS = 15000
local MAX_STATE_BYTES = 16384
local CLI_TIMEOUT_MS = 5000
local NEXT_MODE = { auto = "always", always = "off", off = "auto" }
local CYCLE = "plugin.omp-pushover.cycle"

-- Tern's command-line tool; the window's PATH is short, so look in the usual places.
local function find_cli(): string?
	local candidates = { "/Applications/Tern.app/Contents/MacOS/tern" }
	if HOME then
		table.insert(candidates, HOME .. "/Applications/Tern.app/Contents/MacOS/tern")
		table.insert(candidates, HOME .. "/.local/bin/tern")
	end
	table.insert(candidates, "/opt/homebrew/bin/tern")
	table.insert(candidates, "/usr/local/bin/tern")
	for _, path in candidates do
		local ok, found = pcall(tern.fs.exists, path)
		if ok and found then
			return path
		end
	end
	return nil
end
local TERN_CLI = find_cli()

local cached: State = { mode = "auto", armed = {} }
local armed_set: { [string]: boolean } = {}
-- The file text `cached` was read from, so an unchanged file is not decoded again.
local last_text: string? = nil
-- This window's pane id -> the armed key ("pane:<$TERN_PANE>") of that pane.
local window_armed: { [number]: string } = {}
-- Whether window_armed has been rebuilt from `tern ls` since this VM loaded.
local synced = false
-- Built when the state or its text changes; the formatter only picks one.
local shown_text = ""
local segment_plain: { StatusSegment }? = nil
local segment_armed: { StatusSegment }? = nil
local tick: TimerHandle? = nil

local function parse_state(text: string): State
	local s: State = { mode = "auto", armed = {} }
	local ok, raw = pcall(tern.json.decode, text)
	if not ok or type(raw) ~= "table" then
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

-- The file's text, or "" when it is missing or unreadable (the defaults).
local function read_text(): string
	if PATH == nil then
		return ""
	end
	local ok, text = pcall(tern.fs.read, PATH :: string, MAX_STATE_BYTES)
	return if ok then text else ""
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

local function pane_key(id: number): string
	return "pane:" .. string.format("%.0f", id)
end

-- Rereads the state file. Rebuilds the segments, and with `notify` refreshes
-- the status line, only when the file or the shown text changed.
local function refresh(notify: boolean)
	local text = read_text()
	local changed = text ~= last_text
	if changed then
		last_text = text
		cached = parse_state(text)
		armed_set = {}
		for _, k in cached.armed do
			armed_set[k] = true
		end
		local mapped: { [string]: boolean } = {}
		for id, key in window_armed do
			if armed_set[key] then
				mapped[key] = true
			else
				window_armed[id] = nil
			end
		end
		-- Another window may have armed one of this window's panes.
		for _, k in cached.armed do
			if string.sub(k, 1, 5) == "pane:" and not mapped[k] then
				synced = false
			end
		end
	end
	local now = os.time()
	local shown = status_text(cached, now)
	if not changed and shown == shown_text then
		return
	end
	shown_text = shown
	local eff = effective(cached, now)
	local tone: string? = nil
	if cached.last_error then
		tone = "error"
	elseif eff == "off" or eff == "snooze" then
		tone = "muted"
	end
	segment_plain = { { text = shown, tone = tone, command = CYCLE } }
	segment_armed = { { text = shown .. " · armed", tone = tone, command = CYCLE } }
	if notify then
		tern.chrome.refresh()
	end
end

-- Reads the state again, applies `change` and saves it; reports `message`
-- (by default the new status). False when nothing was saved.
local function update(cx: WindowCx?, change: (State) -> (), message: string?): boolean
	if PATH == nil then
		return false
	end
	local s = parse_state(read_text())
	change(s)
	-- On failure the second value is the error (Luau types it as the function's result).
	local ok, err = pcall(function(): any
		write_state(s)
		return nil
	end)
	if not ok then
		if cx then
			cx:toast("error", "omp-pushover: could not save state", tostring(err))
		end
		return false
	end
	refresh(true)
	if cx then
		cx:toast("success", message or status_text(s, os.time()))
	end
	return true
end

local function is_omp(info: PaneInfo?): boolean
	return info ~= nil and info.kind == "agent" and info.program == "omp"
end

-- The focused pane, when it runs omp. Looked up by spec: cx.session:pane()
-- given the number cx.session:focused() returns finds nothing for some panes.
local function focused_omp(cx: WindowCx): (number?, PaneInfo?)
	local info = cx.session:pane("@focused")
	if info == nil or not is_omp(info) then
		return nil, nil
	end
	return info.pane, info
end

-- Every pane `tern ls --json` lists, or nil when its output does not parse.
local function parse_blocks(result: ProcessResult): { Block }?
	if result.status ~= 0 then
		return nil
	end
	local ok, raw = pcall(tern.json.decode, result.stdout)
	if not ok or type(raw) ~= "table" or type(raw.sessions) ~= "table" then
		return nil
	end
	local blocks: { Block } = {}
	for _, session in raw.sessions do
		for _, tab in (if type(session.tabs) == "table" then session.tabs else {}) do
			for _, b in (if type(tab.blocks) == "table" then tab.blocks else {}) do
				if type(b.id) == "number" and type(b.title) == "string" then
					table.insert(blocks, {
						key = pane_key(b.id),
						title = b.title,
						cwd = if type(b.cwd) == "string" then b.cwd else nil,
						shown = session.shown == true and tab.shown == true and b.focused == true,
					})
				end
			end
		end
	end
	return blocks
end

-- The armed key of the listed pane that is `info`: the only one with its title
-- and directory, or with `focused`, the one of several focused in the shown tab.
local function match_block(info: PaneInfo, blocks: { Block }, focused: boolean): string?
	local same: { Block } = {}
	for _, b in blocks do
		if b.title == info.title and (info.cwd == nil or info.cwd == "" or b.cwd == nil or b.cwd == info.cwd) then
			table.insert(same, b)
		end
	end
	if #same == 1 then
		return same[1].key
	end
	if not focused then
		return nil
	end
	local found: string? = nil
	for _, b in same do
		if b.shown then
			if found then
				return nil
			end
			found = b.key
		end
	end
	return found
end

-- Runs `tern ls --json` and calls `fn` with its panes (nil when it failed).
-- False when it could not be started.
local function list_blocks(fn: (blocks: { Block }?, cx: WindowCx?) -> ()): boolean
	if TERN_CLI == nil then
		return false
	end
	local ok = pcall(tern.process.run, { TERN_CLI :: string, "ls", "--json" }, { timeout_ms = CLI_TIMEOUT_MS }, function(result: ProcessResult, cx: WindowCx?)
		fn(parse_blocks(result), cx)
	end)
	return ok
end

local function arm(cx: WindowCx)
	local id, info = focused_omp(cx)
	if id == nil or info == nil then
		cx:toast("error", "The focused pane does not run omp")
		return
	end
	local pane = id :: number
	local pane_info = info :: PaneInfo
	local started = list_blocks(function(blocks: { Block }?, cx2: WindowCx?)
		local key = if blocks then match_block(pane_info, blocks, true) else nil
		if blocks == nil or key == nil then
			if cx2 then
				cx2:toast("error", "Could not tell which pane this is", "Run /push arm in the agent instead.")
			end
			return
		end
		local listed: { [string]: boolean } = {}
		for _, b in blocks :: { Block } do
			listed[b.key] = true
		end
		local saved = update(cx2, function(s: State)
			-- Arms of panes that are gone can never be used.
			local kept: { string } = {}
			for _, k in s.armed do
				if string.sub(k, 1, 5) ~= "pane:" or listed[k] then
					table.insert(kept, k)
				end
			end
			if not table.find(kept, key :: string) then
				table.insert(kept, key :: string)
			end
			s.armed = kept
		end, "Phone push: you will be notified when this agent finishes")
		if saved then
			window_armed[pane] = key :: string
			tern.chrome.refresh()
		end
	end)
	if not started then
		cx:toast("error", "Could not run Tern's command-line tool (tern ls)")
	end
end

-- Finds which of this window's panes the armed panes are, after a load: each
-- omp pane whose title and directory one listed pane alone has.
local function sync_armed(cx: WindowCx)
	synced = true
	local any = false
	for k in armed_set do
		if string.sub(k, 1, 5) == "pane:" then
			any = true
			break
		end
	end
	if not any then
		return
	end
	local panes = cx.session:panes()
	list_blocks(function(blocks: { Block }?, _cx: WindowCx?)
		if blocks == nil then
			return
		end
		for _, p in panes do
			if is_omp(p) then
				local key = match_block(p, blocks :: { Block }, false)
				if key and armed_set[key] then
					window_armed[p.pane] = key
				end
			end
		end
		tern.chrome.refresh()
	end)
end

-- One timer at a time; the state file may change from omp at any moment.
local function schedule()
	if tick ~= nil then
		return
	end
	tick = tern.timer(REFRESH_MS, function(cx: WindowCx?)
		tick = nil
		refresh(true)
		if not synced and cx then
			sync_armed(cx)
		end
		schedule()
	end)
end

local function set_mode(mode: string): (State) -> ()
	return function(s: State)
		s.mode = mode
		s.away_until = nil
		s.snooze_until = nil
	end
end

local function usable(_cx: WindowCx): boolean
	return PATH ~= nil
end

for _, mode in { "auto", "always", "off" } do
	tern.command({
		id = mode,
		title = "Phone push: " .. string.upper(string.sub(mode, 1, 1)) .. string.sub(mode, 2),
		group = "Phone push",
		-- Hidden when it would change nothing.
		available = function(_cx: WindowCx): boolean
			return PATH ~= nil and effective(cached, os.time()) ~= mode
		end,
		run = function(cx: WindowCx)
			update(cx, set_mode(mode))
		end,
	})
end

tern.command({
	id = "away",
	title = "Phone push: Away for 4 hours",
	group = "Phone push",
	available = usable,
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
	available = usable,
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
	-- Shown only when the focused pane runs omp and is not armed yet.
	available = function(cx: WindowCx): boolean
		if PATH == nil or TERN_CLI == nil then
			return false
		end
		local id = focused_omp(cx)
		return id ~= nil and window_armed[id :: number] == nil
	end,
	run = arm,
})

tern.command({
	id = "cycle",
	title = "Phone push: Cycle mode",
	group = "Phone push",
	available = usable,
	run = function(cx: WindowCx)
		update(cx, set_mode(NEXT_MODE[cached.mode] or "auto"))
	end,
})

-- Pure and allocation-free: refresh() builds the segments.
tern.chrome.status(function(pane: StatusPaneInfo): { StatusSegment }?
	if window_armed[pane.pane] then
		return segment_armed
	end
	return segment_plain
end)

-- A reload need not emit window_start, so a timer soon after loading also
-- finds the armed panes.
tern.on("window_start", function(cx: WindowCx)
	refresh(true)
	if not synced then
		sync_armed(cx)
	end
	schedule()
end)
refresh(false)
schedule()
tern.timer(1000, function(cx: WindowCx?)
	if cx and not synced then
		sync_armed(cx)
	end
end)
