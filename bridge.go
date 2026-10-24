package main

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	appName            = "termchat"
	version            = "0.1.0"
	defaultBasePort    = 8765
	defaultPortSpan    = 10
	defaultTimeout     = 300.0
	defaultConnectWait = 30.0
	maxBody            = 16 * 1024 * 1024
	largePrompt        = 100_000
)

var (
	sites       = []string{"gemini", "copilot", "deepseek"}
	siteOrigins = map[string]string{
		"gemini":   "https://gemini.google.com",
		"copilot":  "https://copilot.microsoft.com",
		"deepseek": "https://chat.deepseek.com",
	}
	allowedOrigins = map[string]bool{
		"https://gemini.google.com":     true,
		"https://copilot.microsoft.com": true,
		"https://chat.deepseek.com":     true,
	}

	webFiles = map[string]struct {
		name        string
		contentType string
	}{
		"/":            {"index.html", "text/html; charset=utf-8"},
		"/index.html":  {"index.html", "text/html; charset=utf-8"},
		"/style.css":   {"style.css", "text/css; charset=utf-8"},
		"/markdown.js": {"markdown.js", "text/javascript; charset=utf-8"},
		"/app.js":      {"app.js", "text/javascript; charset=utf-8"},
	}
)

//go:embed public
var publicFS embed.FS

// Job is one prompt travelling between a client and a browser tab.
type Job struct {
	Site       string
	Prompt     string
	NewChat    bool
	Inspect    bool
	Timeout    float64
	ID         string
	Text       string
	Markdown   *string
	Error      *string
	Meta       map[string]any
	State      string
	Assigned   bool
	AssignedAt time.Time
	Seq        int
	FinishedAt time.Time
	LastSeen   time.Time
}

func newJob(site, prompt string, newChat, inspect bool, timeout float64) *Job {
	return &Job{
		Site:    site,
		Prompt:  prompt,
		NewChat: newChat,
		Inspect: inspect,
		Timeout: timeout,
		ID:      randomID(),
		State:   "pending",
	}
}

func randomID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return fmt.Sprintf("%x", buf)
}

type pageLogEntry struct {
	at      time.Time
	jobID   string
	message string
}

// Bridge is the job queue shared by the HTTP handlers and the CLI.
type Bridge struct {
	mu      sync.Mutex
	changed chan struct{}

	verbose    bool
	token      string
	mode       string
	pendingTTL time.Duration

	pending []*Job
	active  map[string]*Job
	jobs    map[string]*Job

	pings            int
	lastPing         time.Time
	polls            map[string]bool
	polledAt         map[string]time.Time
	extensionVersion string
	pageLog          []pageLogEntry
}

type bridgeOptions struct {
	Verbose    bool
	Token      string
	Mode       string
	PendingTTL time.Duration
}

func newBridge(opts bridgeOptions) *Bridge {
	ttl := opts.PendingTTL
	if ttl <= 0 {
		ttl = 15 * time.Second
	}
	return &Bridge{
		changed:    make(chan struct{}),
		verbose:    opts.Verbose,
		token:      opts.Token,
		mode:       opts.Mode,
		pendingTTL: ttl,
		active:     make(map[string]*Job),
		jobs:       make(map[string]*Job),
		polls:      make(map[string]bool),
		polledAt:   make(map[string]time.Time),
	}
}

// broadcastLocked wakes every waiter. The caller holds b.mu.
func (b *Bridge) broadcastLocked() {
	close(b.changed)
	b.changed = make(chan struct{})
}

// waitLocked waits for a change or a timeout. The caller holds b.mu; the lock
// is released while waiting and held again on return.
func (b *Bridge) waitLocked(duration time.Duration) {
	if duration <= 0 {
		return
	}
	changed := b.changed
	b.mu.Unlock()
	timer := time.NewTimer(duration)
	select {
	case <-changed:
	case <-timer.C:
	}
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	b.mu.Lock()
}

func (b *Bridge) logf(format string, args ...any) {
	if b.verbose || b.mode == "server" {
		fmt.Fprintf(os.Stderr, format, args...)
	}
}

func (b *Bridge) note(jobID, message string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pageLog = append(b.pageLog, pageLogEntry{time.Now(), jobID, message})
	if len(b.pageLog) > 40 {
		b.pageLog = b.pageLog[len(b.pageLog)-40:]
	}
	b.logf("[page %s] %s\n", shortID(jobID), message)
}

func (b *Bridge) submit(job *Job) {
	b.mu.Lock()
	defer b.mu.Unlock()
	job.LastSeen = time.Now()
	b.jobs[job.ID] = job
	b.pending = append(b.pending, job)
	b.pruneLocked()
	b.broadcastLocked()
	b.logf("[job %s] queued site=%s chars=%d new_chat=%t\n",
		shortID(job.ID), job.Site, len(job.Prompt), job.NewChat)
}

func (b *Bridge) removePendingLocked(jobID string) {
	pending := b.pending[:0]
	for _, job := range b.pending {
		if job.ID != jobID {
			pending = append(pending, job)
		}
	}
	b.pending = pending
}

// pruneLocked drops abandoned and old finished jobs.
func (b *Bridge) pruneLocked() {
	now := time.Now()
	for id, job := range b.jobs {
		switch {
		case job.State == "pending" && b.mode == "server" &&
			now.Sub(job.LastSeen) > b.pendingTTL:
			b.removePendingLocked(id)
			delete(b.jobs, id)
		case job.State == "done" && now.Sub(job.FinishedAt) > time.Hour:
			delete(b.jobs, id)
		}
	}
	if extra := len(b.jobs) - 500; extra > 0 {
		type finished struct {
			at time.Time
			id string
		}
		done := make([]finished, 0, len(b.jobs))
		for id, job := range b.jobs {
			if job.State == "done" {
				done = append(done, finished{job.FinishedAt, id})
			}
		}
		sort.Slice(done, func(i, j int) bool {
			if done[i].at.Equal(done[j].at) {
				return done[i].id < done[j].id
			}
			return done[i].at.Before(done[j].at)
		})
		if extra > len(done) {
			extra = len(done)
		}
		for _, entry := range done[:extra] {
			delete(b.jobs, entry.id)
		}
	}
}

func (b *Bridge) take(site string, wait float64) *Job {
	deadline := time.Now().Add(secondsToDuration(maxFloat(wait, 0)))
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked()
	for {
		for _, job := range b.pending {
			if job.Site != site {
				continue
			}
			b.removePendingLocked(job.ID)
			job.Assigned = true
			job.State = "running"
			job.AssignedAt = time.Now()
			job.Seq++
			b.active[job.ID] = job
			b.broadcastLocked()
			b.logf("[job %s] picked up by %s tab\n", shortID(job.ID), site)
			return job
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil
		}
		b.waitLocked(remaining)
		b.pruneLocked()
	}
}

type jobUpdate struct {
	Text     *string
	Markdown *string
	Error    *string
	Meta     map[string]any
	State    *string
}

func (b *Bridge) update(jobID string, change jobUpdate) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	job := b.active[jobID]
	if job == nil {
		return false
	}
	if change.Text != nil {
		job.Text = *change.Text
	}
	if change.Markdown != nil {
		job.Markdown = change.Markdown
	}
	if change.Error != nil {
		job.Error = change.Error
	}
	if change.Meta != nil {
		job.Meta = change.Meta
	}
	if change.State != nil {
		job.State = *change.State
	}
	job.Seq++
	if change.State != nil && *change.State == "done" {
		job.FinishedAt = time.Now()
		delete(b.active, jobID)
		errorText := "-"
		if job.Error != nil && *job.Error != "" {
			errorText = *job.Error
		}
		b.logf("[job %s] done error=%s chars=%d\n",
			shortID(jobID), errorText, len(job.Text))
	}
	b.broadcastLocked()
	return true
}

type jobSnapshot struct {
	ID          string         `json:"id"`
	Site        string         `json:"site"`
	State       string         `json:"state"`
	Text        string         `json:"text"`
	Markdown    *string        `json:"markdown"`
	Error       *string        `json:"error"`
	Meta        map[string]any `json:"meta"`
	Inspect     bool           `json:"inspect"`
	Seq         int            `json:"seq"`
	QueuedAhead int            `json:"queued_ahead"`
}

func (b *Bridge) snapshotLocked(job *Job) *jobSnapshot {
	ahead := 0
	if job.State == "pending" {
		now := time.Now()
		for _, other := range b.pending {
			if other.ID == job.ID {
				break
			}
			if other.Site == job.Site &&
				(b.mode != "server" || now.Sub(other.LastSeen) <= b.pendingTTL) {
				ahead++
			}
		}
	}
	return &jobSnapshot{
		ID:          job.ID,
		Site:        job.Site,
		State:       job.State,
		Text:        job.Text,
		Markdown:    job.Markdown,
		Error:       job.Error,
		Meta:        job.Meta,
		Inspect:     job.Inspect,
		Seq:         job.Seq,
		QueuedAhead: ahead,
	}
}

// snapshot returns the current job state, long-polling until seq > after,
// done, or the timeout expires.
func (b *Bridge) snapshot(jobID string, after int, wait float64) *jobSnapshot {
	deadline := time.Now().Add(secondsToDuration(maxFloat(wait, 0)))
	b.mu.Lock()
	defer b.mu.Unlock()
	job := b.jobs[jobID]
	if job == nil {
		return nil
	}
	// Any state poll is a heartbeat: a live client keeps its queued job.
	job.LastSeen = time.Now()
	b.pruneLocked()
	for job.Seq <= after && job.State != "done" {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		b.waitLocked(remaining)
		job.LastSeen = time.Now()
	}
	return b.snapshotLocked(job)
}

func (b *Bridge) cancel(jobID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	job := b.jobs[jobID]
	if job == nil || job.State == "done" {
		return false
	}
	b.removePendingLocked(jobID)
	delete(b.active, jobID)
	job.State = "done"
	message := "canceled by client"
	job.Error = &message
	job.Seq++
	job.FinishedAt = time.Now()
	b.broadcastLocked()
	return true
}

func (b *Bridge) pingPayload() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pruneLocked()
	now := time.Now()
	polls := make([]string, 0, len(b.polls))
	for site := range b.polls {
		polls = append(polls, site)
	}
	sort.Strings(polls)
	pollAges := make(map[string]float64, len(b.polledAt))
	for site, seen := range b.polledAt {
		pollAges[site] = round1(now.Sub(seen).Seconds())
	}
	logs := b.pageLog
	if len(logs) > 10 {
		logs = logs[len(logs)-10:]
	}
	recent := make([]map[string]any, 0, len(logs))
	for _, entry := range logs {
		recent = append(recent, map[string]any{
			"job":     shortID(entry.jobID),
			"age":     round1(now.Sub(entry.at).Seconds()),
			"message": entry.message,
		})
	}
	var lastPingAge any
	if !b.lastPing.IsZero() {
		lastPingAge = round1(now.Sub(b.lastPing).Seconds())
	}
	return map[string]any{
		"app":               appName,
		"version":           version,
		"sites":             append([]string(nil), sites...),
		"mode":              b.mode,
		"polls":             polls,
		"poll_ages":         pollAges,
		"pending":           len(b.pending),
		"active":            len(b.active),
		"last_ping_age":     lastPingAge,
		"extension_version": b.extensionVersion,
		"recent_logs":       recent,
	}
}

func round1(value float64) float64 {
	return math.Round(value*10) / 10
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func secondsToDuration(seconds float64) time.Duration {
	return time.Duration(seconds * float64(time.Second))
}

// --------------------------------------------------------------------------
// HTTP bridge
// --------------------------------------------------------------------------

func originAllowed(origin, host string) bool {
	if allowedOrigins[origin] {
		return true
	}
	if strings.HasPrefix(origin, "chrome-extension://") ||
		strings.HasPrefix(origin, "moz-extension://") {
		return true
	}
	// The web UI is served by this same bridge, often from another machine.
	// A browser sends Origin on its POSTs, so accept the page only when its
	// origin is this exact host:port. Foreign origins stay blocked.
	if host != "" {
		parsed, err := url.Parse(origin)
		if err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") &&
			strings.EqualFold(parsed.Host, host) {
			return true
		}
	}
	return false
}

func isLoopbackAddress(bind string) bool {
	if bind == "localhost" {
		return true
	}
	ip := net.ParseIP(bind)
	return ip != nil && ip.IsLoopback()
}

type bridgeHandler struct {
	bridge *Bridge
}

func (h *bridgeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.bridge.verbose {
		fmt.Fprintf(os.Stderr, "[bridge] %s %s %s\n", r.RemoteAddr, r.Method, r.URL.RequestURI())
	}
	switch r.Method {
	case http.MethodOptions:
		h.handleOptions(w, r)
	case http.MethodGet:
		h.handleGet(w, r)
	case http.MethodPost:
		h.handlePost(w, r)
	default:
		w.Header().Set("Allow", "GET, POST, OPTIONS")
		h.send(w, http.StatusMethodNotAllowed, map[string]any{"error": "not found"}, "")
	}
}

func (h *bridgeHandler) send(w http.ResponseWriter, status int, payload any, origin string) {
	body := []byte{}
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err == nil {
			body = encoded
		}
	}
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Add("Vary", "Origin")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Server", appName+"/"+version)
	w.WriteHeader(status)
	if len(body) > 0 && status != http.StatusNoContent {
		_, _ = w.Write(body)
	}
}

// origin returns the allowed Origin ("" when absent), or false after sending
// a 403.
func (h *bridgeHandler) origin(w http.ResponseWriter, r *http.Request) (string, bool) {
	origin := r.Header.Get("Origin")
	if origin != "" && !originAllowed(origin, r.Host) {
		h.send(w, http.StatusForbidden, map[string]any{"error": "origin not allowed"}, "")
		return "", false
	}
	return origin, true
}

func (h *bridgeHandler) serveWeb(w http.ResponseWriter, path string) {
	entry := webFiles[path]
	body, err := publicFS.ReadFile("public/" + entry.name)
	contentType := entry.contentType
	if err != nil {
		body = []byte("<!doctype html><meta charset=\"utf-8\"><title>termchat</title>" +
			"<p>The termchat web UI is missing. Expected public/index.html " +
			"next to the termchat binary.</p>")
		contentType = "text/html; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Server", appName+"/"+version)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (h *bridgeHandler) authorized(w http.ResponseWriter, r *http.Request, origin string) bool {
	token := h.bridge.token
	if token == "" {
		return true
	}
	supplied := r.Header.Get("X-Termchat-Token")
	if subtle.ConstantTimeCompare([]byte(supplied), []byte(token)) == 1 {
		return true
	}
	h.send(w, http.StatusUnauthorized, map[string]any{"error": "missing or invalid token"}, origin)
	return false
}

func (h *bridgeHandler) readJSON(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	length := 0
	if raw := r.Header.Get("Content-Length"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			return nil, false
		}
		length = parsed
	}
	if length < 0 || length > maxBody {
		return nil, false
	}
	raw := []byte("{}")
	if length > 0 {
		raw = make([]byte, length)
		if _, err := io.ReadFull(r.Body, raw); err != nil {
			return nil, false
		}
	}
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, false
	}
	object, ok := payload.(map[string]any)
	return object, ok
}

func (h *bridgeHandler) handleOptions(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin != "" && !originAllowed(origin, r.Host) {
		h.send(w, http.StatusForbidden, map[string]any{"error": "origin not allowed"}, "")
		return
	}
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Add("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Termchat-Token")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.Header().Set("Content-Length", "0")
	w.Header().Set("Server", appName+"/"+version)
	w.WriteHeader(http.StatusNoContent)
}

func (h *bridgeHandler) handleGet(w http.ResponseWriter, r *http.Request) {
	origin, ok := h.origin(w, r)
	if !ok {
		return
	}
	path := r.URL.Path
	if _, known := webFiles[path]; known {
		h.serveWeb(w, path)
		return
	}
	query := r.URL.Query()
	if path == "/v1/ping" {
		if query.Get("probe") != "client" {
			h.bridge.mu.Lock()
			h.bridge.pings++
			h.bridge.lastPing = time.Now()
			h.bridge.broadcastLocked()
			h.bridge.mu.Unlock()
		}
		h.send(w, http.StatusOK, h.bridge.pingPayload(), origin)
		return
	}
	if !h.authorized(w, r, origin) {
		return
	}
	if strings.HasPrefix(path, "/v1/state/") {
		jobID := strings.Trim(strings.TrimPrefix(path, "/v1/state/"), "/")
		after := -1
		if raw := query.Get("after"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil {
				after = parsed
			}
		}
		wait := 0.0
		if raw := query.Get("wait"); raw != "" {
			if parsed, err := strconv.ParseFloat(raw, 64); err == nil {
				wait = parsed
			}
		}
		wait = math.Min(math.Max(wait, 0), 25)
		snap := h.bridge.snapshot(jobID, after, wait)
		if snap == nil {
			h.send(w, http.StatusNotFound, map[string]any{"error": "unknown job"}, origin)
		} else {
			h.send(w, http.StatusOK, snap, origin)
		}
		return
	}
	if path == "/v1/job" {
		site := query.Get("site")
		if !isSite(site) {
			h.send(w, http.StatusBadRequest, map[string]any{"error": "unknown site"}, origin)
			return
		}
		extensionVersion := query.Get("version")
		if len(extensionVersion) > 40 {
			extensionVersion = extensionVersion[:40]
		}
		h.bridge.mu.Lock()
		h.bridge.polls[site] = true
		h.bridge.polledAt[site] = time.Now()
		if extensionVersion != "" {
			h.bridge.extensionVersion = extensionVersion
		}
		h.bridge.broadcastLocked()
		h.bridge.mu.Unlock()

		wait := 2.0
		if raw := query.Get("wait"); raw != "" {
			if parsed, err := strconv.ParseFloat(raw, 64); err == nil {
				wait = parsed
			}
		}
		job := h.bridge.take(site, math.Min(math.Max(wait, 0), 25))
		if job == nil {
			h.send(w, http.StatusNoContent, nil, origin)
			return
		}
		h.send(w, http.StatusOK, map[string]any{
			"id":         job.ID,
			"site":       site,
			"prompt":     job.Prompt,
			"new_chat":   job.NewChat,
			"inspect":    job.Inspect,
			"timeout_ms": int(job.Timeout * 1000),
			"version":    version,
		}, origin)
		return
	}
	h.send(w, http.StatusNotFound, map[string]any{"error": "not found"}, origin)
}

func splitPath(path string) []string {
	return strings.FieldsFunc(path, func(r rune) bool { return r == '/' })
}

func (h *bridgeHandler) handlePost(w http.ResponseWriter, r *http.Request) {
	origin, ok := h.origin(w, r)
	if !ok {
		return
	}
	if !h.authorized(w, r, origin) {
		return
	}
	path := r.URL.Path
	parts := splitPath(path)
	if path == "/v1/request" {
		payload, ok := h.readJSON(w, r)
		if !ok {
			h.send(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"}, origin)
			return
		}
		site := pyStringOrEmpty(payload["site"])
		if !isSite(site) {
			h.send(w, http.StatusBadRequest, map[string]any{"error": "unknown site"}, origin)
			return
		}
		prompt, ok := payload["prompt"].(string)
		if !ok {
			h.send(w, http.StatusBadRequest, map[string]any{"error": "prompt must be a string"}, origin)
			return
		}
		timeout := defaultTimeout
		if raw, present := payload["timeout"]; present && truthy(raw) {
			if parsed, ok := asNumber(raw); ok {
				timeout = parsed
			}
		}
		newChat := true
		if raw, present := payload["new_chat"]; present {
			newChat = truthy(raw)
		}
		job := newJob(site, prompt, newChat, truthy(payload["inspect"]), maxFloat(1.0, timeout))
		h.bridge.submit(job)
		h.send(w, http.StatusOK, map[string]any{"id": job.ID, "site": site}, origin)
		return
	}
	if len(parts) == 4 && parts[0] == "v1" && parts[1] == "request" && parts[3] == "cancel" {
		if !h.bridge.cancel(parts[2]) {
			h.send(w, http.StatusNotFound, map[string]any{"error": "unknown or finished job"}, origin)
			return
		}
		h.send(w, http.StatusOK, map[string]any{"ok": true}, origin)
		return
	}
	if len(parts) == 4 && parts[0] == "v1" && parts[1] == "job" &&
		(parts[3] == "progress" || parts[3] == "done" || parts[3] == "log") {
		jobID, action := parts[2], parts[3]
		payload, ok := h.readJSON(w, r)
		if !ok {
			h.send(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"}, origin)
			return
		}
		if action == "log" {
			h.bridge.note(jobID,
				fieldString(payload, "level", "info")+": "+
					fieldString(payload, "message", ""))
			h.send(w, http.StatusOK, map[string]any{"ok": true}, origin)
			return
		}
		var applied bool
		if action == "progress" {
			text := fieldString(payload, "text", "")
			applied = h.bridge.update(jobID, jobUpdate{Text: &text})
		} else {
			text := fieldString(payload, "text", "")
			change := jobUpdate{Text: &text, State: stringPointer("done")}
			if markdown, ok := payload["markdown"].(string); ok {
				change.Markdown = &markdown
			}
			if raw, present := payload["error"]; present && truthy(raw) {
				message := pyString(raw)
				change.Error = &message
			}
			if meta, ok := payload["meta"].(map[string]any); ok && len(meta) > 0 {
				change.Meta = meta
			}
			applied = h.bridge.update(jobID, change)
		}
		if !applied {
			h.send(w, http.StatusNotFound, map[string]any{"error": "unknown or finished job"}, origin)
			return
		}
		h.send(w, http.StatusOK, map[string]any{"ok": true}, origin)
		return
	}
	h.send(w, http.StatusNotFound, map[string]any{"error": "not found"}, origin)
}

func isSite(site string) bool {
	for _, known := range sites {
		if site == known {
			return true
		}
	}
	return false
}

// startBridge binds the first free port and serves the bridge in the
// background.
func startBridge(bridge *Bridge, basePort, span int, bind string) (*http.Server, int, error) {
	for port := basePort; port < basePort+span; port++ {
		listener, err := net.Listen("tcp", net.JoinHostPort(bind, strconv.Itoa(port)))
		if err != nil {
			continue
		}
		server := &http.Server{Handler: &bridgeHandler{bridge: bridge}}
		go func() {
			_ = server.Serve(listener)
		}()
		return server, port, nil
	}
	return nil, 0, fmt.Errorf("could not bind %s port in %d..%d",
		bind, basePort, basePort+span-1)
}

// --------------------------------------------------------------------------
// JSON value helpers
// --------------------------------------------------------------------------

func truthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0
	case int:
		return typed != 0
	case []any:
		return len(typed) > 0
	case map[string]any:
		return len(typed) > 0
	default:
		return true
	}
}

func asNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil
	case bool:
		if typed {
			return 1, true
		}
		return 0, true
	default:
		return 0, false
	}
}

// pyString mirrors str(value) for the JSON types the bridge sees.
func pyString(value any) string {
	switch typed := value.(type) {
	case nil:
		return "None"
	case string:
		return typed
	case bool:
		if typed {
			return "True"
		}
		return "False"
	case float64:
		return strconv.FormatFloat(typed, 'g', -1, 64)
	default:
		return fmt.Sprint(value)
	}
}

func pyStringOrEmpty(value any) string {
	if !truthy(value) {
		return ""
	}
	return pyString(value)
}

func pyStringDefault(value any, fallback string) string {
	if value == nil {
		return fallback
	}
	return pyString(value)
}

// fieldString mirrors payload.get(key, fallback): a missing key uses the
// fallback, while a present JSON null becomes "None".
func fieldString(payload map[string]any, key, fallback string) string {
	value, present := payload[key]
	if !present {
		return fallback
	}
	return pyString(value)
}

func stringPointer(value string) *string {
	return &value
}
