package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"time"
)

// RemoteError is a failure reported by, or while reaching, a termchat server.
type RemoteError struct {
	message string
}

func (e *RemoteError) Error() string { return e.message }

// RemoteClient talks to a persistent `termchat serve` process.
type RemoteClient struct {
	URL   string
	Token string
}

func (c *RemoteClient) call(path, method string, body any, timeout time.Duration) (map[string]any, error) {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, &RemoteError{err.Error()}
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, c.URL+path, reader)
	if err != nil {
		return nil, &RemoteError{fmt.Sprintf("cannot reach %s: %v", c.URL, err)}
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		request.Header.Set("X-Termchat-Token", c.Token)
	}
	client := &http.Client{Timeout: timeout}
	response, err := client.Do(request)
	if err != nil {
		return nil, &RemoteError{fmt.Sprintf("cannot reach %s: %v", c.URL, err)}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, &RemoteError{fmt.Sprintf("cannot reach %s: %v", c.URL, err)}
	}
	if response.StatusCode >= 400 {
		detail := ""
		var payload any
		if len(raw) > 0 && json.Unmarshal(raw, &payload) == nil {
			if object, ok := payload.(map[string]any); ok {
				detail = pyStringOrEmpty(object["error"])
			}
		}
		if detail == "" {
			detail = fmt.Sprintf("HTTP %d", response.StatusCode)
		}
		return nil, &RemoteError{detail}
	}
	if len(raw) == 0 {
		return nil, nil
	}
	var payload any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, &RemoteError{fmt.Sprintf("invalid response from %s", c.URL)}
	}
	object, ok := payload.(map[string]any)
	if !ok {
		return nil, nil
	}
	return object, nil
}

func (c *RemoteClient) ping() (map[string]any, error) {
	return c.call("/v1/ping?probe=client", http.MethodGet, nil, 1500*time.Millisecond)
}

func (c *RemoteClient) submit(job *Job) (string, error) {
	payload, err := c.call("/v1/request", http.MethodPost, map[string]any{
		"site":     job.Site,
		"prompt":   job.Prompt,
		"new_chat": job.NewChat,
		"inspect":  job.Inspect,
		"timeout":  job.Timeout,
	}, 10*time.Second)
	if err != nil {
		return "", err
	}
	if len(payload) == 0 || !truthy(payload["id"]) {
		return "", &RemoteError{"server did not return a job id"}
	}
	return pyString(payload["id"]), nil
}

func (c *RemoteClient) state(jobID string, after int, wait float64) (map[string]any, error) {
	path := fmt.Sprintf("/v1/state/%s?after=%d&wait=%s",
		jobID, after, strconv.FormatFloat(wait, 'g', -1, 64))
	payload, err := c.call(path, http.MethodGet, nil, secondsToDuration(wait+5))
	if err != nil {
		return nil, err
	}
	if len(payload) == 0 {
		return nil, &RemoteError{"server returned no job state"}
	}
	return payload, nil
}

func (c *RemoteClient) cancel(jobID string) {
	_, _ = c.call("/v1/request/"+jobID+"/cancel", http.MethodPost,
		map[string]any{}, 3*time.Second)
}

func normalizeServerURL(value string, defaultPort int) string {
	if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	host := "127.0.0.1"
	port := defaultPort
	if parsed, err := url.Parse(value); err == nil {
		if parsed.Hostname() != "" {
			host = parsed.Hostname()
		}
		if parsed.Port() != "" {
			if parsedPort, err := strconv.Atoi(parsed.Port()); err == nil {
				port = parsedPort
			}
		}
	}
	hostpart := host
	if strings.Contains(host, ":") {
		hostpart = "[" + host + "]"
	}
	return fmt.Sprintf("http://%s:%d", hostpart, port)
}

// detectServer returns the local persistent server's URL, ignoring ephemeral
// bridges.
func detectServer(basePort int) string {
	remote := &RemoteClient{URL: fmt.Sprintf("http://127.0.0.1:%d", basePort)}
	payload, err := remote.ping()
	if err != nil || payload == nil {
		return ""
	}
	if payload["app"] == appName && payload["mode"] == "server" {
		return remote.URL
	}
	return ""
}

func checkRemote(remote *RemoteClient, site string, wait float64, verbose bool) int {
	deadline := time.Now().Add(secondsToDuration(maxFloat(wait, 0)))
	lastError := ""
	lastAge := math.NaN()
	staleWarned := false
	for {
		info, err := remote.ping()
		if err != nil {
			lastError = err.Error()
			info = nil
		}
		if info != nil {
			polls := stringList(info["polls"])
			ages := floatMap(info["poll_ages"])
			fresh := make(map[string]bool)
			if ages != nil {
				for key, value := range ages {
					if value <= 10 {
						fresh[key] = true
					}
				}
			} else {
				for _, key := range polls {
					fresh[key] = true
				}
			}
			extensionVersion := pyStringOrEmpty(info["extension_version"])
			var age any
			if raw, ok := info["last_ping_age"]; ok {
				if number, ok := raw.(float64); ok {
					lastAge = number
				}
			}
			if verbose {
				shownAges := "-"
				keys := make([]string, 0, len(ages))
				for key := range ages {
					keys = append(keys, key)
				}
				sort.Strings(keys)
				if len(keys) > 0 {
					parts := make([]string, 0, len(keys))
					for _, key := range keys {
						parts = append(parts, fmt.Sprintf("%s=%gs", key, ages[key]))
					}
					shownAges = strings.Join(parts, ", ")
				}
				pollsShown := strings.Join(polls, ",")
				if pollsShown == "" {
					pollsShown = "-"
				}
				extensionShown := extensionVersion
				if extensionShown == "" {
					extensionShown = "-"
				}
				ageShown := "-"
				if !math.IsNaN(lastAge) {
					age = lastAge
					ageShown = fmt.Sprintf("%vs ago", age)
				}
				fmt.Fprintf(os.Stderr,
					"termchat: server %s: pending=%v active=%v polls=%s "+
						"poll_ages=%s extension=%s last_ping=%s\n",
					remote.URL, info["pending"], info["active"], pollsShown,
					shownAges, extensionShown, ageShown)
				for _, entry := range objectList(info["recent_logs"]) {
					jobShown := pyStringDefault(entry["job"], "?")
					entryAge := pyStringDefault(entry["age"], "?")
					message := pyStringDefault(entry["message"], "")
					fmt.Fprintf(os.Stderr, "termchat: page %s %ss ago: %s\n",
						jobShown, entryAge, message)
				}
			}
			if fresh[site] {
				label := ""
				if extensionVersion != "" {
					label = fmt.Sprintf(" (extension %s)", extensionVersion)
				}
				fmt.Fprintf(os.Stderr,
					"termchat: the extension is polling for %s. The server is reachable%s.\n",
					site, label)
				return 0
			}
			if len(fresh) > 0 {
				label := ""
				if extensionVersion != "" {
					label = fmt.Sprintf(" (extension %s)", extensionVersion)
				}
				freshNames := make([]string, 0, len(fresh))
				for key := range fresh {
					freshNames = append(freshNames, key)
				}
				sort.Strings(freshNames)
				fmt.Fprintf(os.Stderr,
					"termchat: the extension is polling for %s, but no tab for %s is "+
						"connected%s.\n",
					strings.Join(freshNames, ", "), site, label)
				return 1
			}
			if len(ages) > 0 && !staleWarned {
				staleWarned = true
				minimum := math.Inf(1)
				for _, value := range ages {
					minimum = math.Min(minimum, value)
				}
				fmt.Fprintf(os.Stderr,
					"termchat: the extension last polled %.0fs ago; its worker is not "+
						"running now.\n", minimum)
			}
			lastError = ""
		}
		if !time.Now().Before(deadline) {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}

	if lastError != "" {
		fmt.Fprintf(os.Stderr, "termchat: %s\n", lastError)
		fmt.Fprintln(os.Stderr,
			"termchat: is 'termchat serve' running and reachable from this machine?")
	} else if staleWarned {
		fmt.Fprintln(os.Stderr,
			"termchat: no recent job poll. The extension reached the server, but "+
				"its worker is not running now.")
	} else if !math.IsNaN(lastAge) && lastAge < 15 {
		fmt.Fprintf(os.Stderr,
			"termchat: the extension is reaching the server, but no chat tab is "+
				"polling for %s. Reload the %s tab.\n", site, site)
	} else {
		fmt.Fprintln(os.Stderr,
			"termchat: nothing reached the server recently. If the browser runs on "+
				"another machine, set the extension Options host to this machine (not "+
				"127.0.0.1), allow the permission, then reload the chat tab.")
	}
	return 1
}

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		if strings, ok := value.([]string); ok {
			return strings
		}
		return nil
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func floatMap(value any) map[string]float64 {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	result := make(map[string]float64, len(object))
	for key, raw := range object {
		if number, ok := raw.(float64); ok {
			result[key] = number
		}
	}
	return result
}

func objectList(value any) []map[string]any {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if object, ok := item.(map[string]any); ok {
			result = append(result, object)
		}
	}
	return result
}

func waitForExtension(bridge *Bridge, job *Job, timeout float64, site string) bool {
	start := time.Now()
	// A worker that was suspended after a poll leaves a recent ping behind. Its
	// keepalive alarm or the tab heartbeat will wake it, so give it one longer
	// window instead of reporting "no browser tab" while it is asleep.
	late := math.Min(math.Max(timeout, 1.0)*3.0, 90.0)
	extended := false
	warned := false
	for {
		now := time.Now()
		bridge.mu.Lock()
		assigned := job.Assigned
		asleep := !extended && late > timeout && bridge.pings > 0 &&
			now.Sub(bridge.lastPing) <= 60*time.Second
		verbose := bridge.verbose
		bridge.mu.Unlock()
		if assigned {
			ACTIVITY.Clear()
			return true
		}
		limit := timeout
		if extended {
			limit = late
		}
		if now.Sub(start).Seconds() >= limit {
			if asleep {
				extended = true
				if verbose {
					ACTIVITY.Clear()
					fmt.Fprintln(os.Stderr,
						"termchat: the extension is asleep; waiting for it to wake")
				}
				ACTIVITY.Update(
					fmt.Sprintf("%s: extension asleep, waiting for it to wake", site),
					now.Sub(start).Seconds())
				continue
			}
			ACTIVITY.Clear()
			return false
		}
		if verbose && !warned && now.Sub(start).Seconds() > 2 {
			ACTIVITY.Clear()
			fmt.Fprintf(os.Stderr,
				"termchat: waiting for the browser extension for %s\n", site)
			warned = true
		}
		ACTIVITY.Update(fmt.Sprintf("%s: waiting for the browser tab", site),
			now.Sub(start).Seconds())
		time.Sleep(100 * time.Millisecond)
	}
}

func checkBridge(bridge *Bridge, bind string, port int, wait float64, site string) int {
	where := fmt.Sprintf("%s:%d", bind, port)
	if bind == "0.0.0.0" || bind == "::" {
		where = fmt.Sprintf("port %d", port)
	}
	fmt.Fprintf(os.Stderr,
		"termchat: listening on %s; waiting up to %gs for the extension\n", where, wait)
	deadline := time.Now().Add(secondsToDuration(wait))
	sawPing := false
	staleWarned := false
	for {
		now := time.Now()
		bridge.mu.Lock()
		polls := make([]string, 0, len(bridge.polls))
		for key := range bridge.polls {
			polls = append(polls, key)
		}
		pollAges := make(map[string]float64, len(bridge.polledAt))
		for key, seen := range bridge.polledAt {
			pollAges[key] = now.Sub(seen).Seconds()
		}
		extensionVersion := bridge.extensionVersion
		pings := bridge.pings
		bridge.mu.Unlock()

		fresh := make(map[string]bool)
		for _, key := range polls {
			if age, ok := pollAges[key]; ok && age <= 10 {
				fresh[key] = true
			}
		}
		if len(fresh) > 0 {
			label := ""
			if extensionVersion != "" {
				label = fmt.Sprintf(" (extension %s)", extensionVersion)
			}
			freshNames := make([]string, 0, len(fresh))
			for key := range fresh {
				freshNames = append(freshNames, key)
			}
			sort.Strings(freshNames)
			if fresh[site] {
				fmt.Fprintf(os.Stderr,
					"termchat: the extension is polling for %s. The bridge is reachable%s.\n",
					strings.Join(freshNames, ", "), label)
				return 0
			}
			fmt.Fprintf(os.Stderr,
				"termchat: the extension is polling for %s, but no tab for %s is "+
					"connected%s.\n",
				strings.Join(freshNames, ", "), siteOrigins[site], label)
			return 1
		}
		if len(polls) > 0 && !staleWarned {
			staleWarned = true
			minimum := 0.0
			if len(pollAges) > 0 {
				minimum = math.Inf(1)
				for _, value := range pollAges {
					minimum = math.Min(minimum, value)
				}
			}
			fmt.Fprintf(os.Stderr,
				"termchat: the extension last polled %.0fs ago; its worker "+
					"is not running now. Waiting for an alarm or a tab heartbeat.\n",
				minimum)
		}
		if pings > 0 && !sawPing {
			sawPing = true
			fmt.Fprintf(os.Stderr,
				"termchat: the extension reached the bridge; waiting for a chat tab "+
					"on %s.\n", siteOrigins[site])
		}
		if !time.Now().Before(deadline) {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}

	if staleWarned {
		fmt.Fprintln(os.Stderr,
			"termchat: no recent job poll. The extension reached the bridge, but "+
				"its worker is not running now.")
		return 1
	}
	if sawPing {
		fmt.Fprintln(os.Stderr,
			"termchat: the extension reached the bridge but never asked for a job. "+
				"Reload the chat tab.")
		return 1
	}
	fmt.Fprintln(os.Stderr,
		"termchat: nothing reached the bridge. In the extension Options, set Host "+
			"to this machine, allow the permission, and check the network path.")
	return 1
}

func runJob(
	bridge *Bridge,
	job *Job,
	timeout, wait float64,
	stream, jsonMode bool,
	bridgeHint string,
	styled, color bool,
) int {
	bridge.submit(job)
	if !waitForExtension(bridge, job, wait, job.Site) {
		where := ""
		if bridgeHint != "" {
			where = fmt.Sprintf(" (bridge on %s)", bridgeHint)
		}
		fmt.Fprintf(os.Stderr, "termchat: no browser tab picked up the job%s.\n", where)
		fmt.Fprintf(os.Stderr,
			"termchat: run 'termchat %s --check' to see whether the "+
				"extension can reach this bridge.\n", job.Site)
		return 3
	}

	deadline := time.Now().Add(secondsToDuration(timeout + 30))
	answerStart := time.Now()
	showActivity := true
	printed := ""
	var state, text string
	var markdown, errorText *string
	var meta map[string]any

	for {
		bridge.mu.Lock()
		state = job.State
		text = job.Text
		errorText = job.Error
		meta = job.Meta
		markdown = job.Markdown
		bridge.mu.Unlock()
		if state == "done" {
			break
		}
		if time.Now().After(deadline) {
			message := fmt.Sprintf("timed out after %gs waiting for the page", timeout)
			errorText = &message
			break
		}
		if stream && text != printed {
			ACTIVITY.Clear()
			printed = printDelta(text, printed, stream)
			showActivity = false
		} else if showActivity {
			label := fmt.Sprintf("%s: waiting for the page to answer", job.Site)
			if text != "" {
				label = fmt.Sprintf("%s: answering", job.Site)
			}
			ACTIVITY.Update(label, time.Since(answerStart).Seconds())
		}
		time.Sleep(200 * time.Millisecond)
	}
	ACTIVITY.Clear()

	if job.Inspect {
		printJSON(meta)
		if state == "done" && errorText == nil {
			return 0
		}
		return 1
	}

	if errorText != nil && *errorText != "" {
		if stream && printed != "" {
			fmt.Fprint(os.Stdout, "\n")
		}
		fmt.Fprintf(os.Stderr, "termchat: %s\n", *errorText)
		if path := saveDiagnostics(job); path != "" {
			fmt.Fprintf(os.Stderr, "termchat: page diagnostics saved to %s\n", path)
		}
		if jsonMode {
			printJSON(map[string]any{
				"site": job.Site, "text": text, "error": *errorText, "meta": meta,
			})
		}
		return 1
	}

	if jsonMode {
		printJSON(map[string]any{
			"site": job.Site, "text": text, "error": nil, "meta": meta,
		})
	} else {
		emitAnswer(text, markdown, printed, stream, styled, color)
	}
	return 0
}

func runRemote(
	remote *RemoteClient,
	job *Job,
	timeout, wait float64,
	stream, jsonMode bool,
	styled, color bool,
) int {
	jobID, err := remote.submit(job)
	if err != nil {
		fmt.Fprintf(os.Stderr, "termchat: %s\n", err)
		return 3
	}

	ACTIVITY.Update(fmt.Sprintf("%s: sent to %s", job.Site, remote.URL), 0)

	start := time.Now()
	deadline := start.Add(secondsToDuration(timeout + 30))
	idleSince := start
	// See waitForExtension: a suspended worker still has a recent ping.
	late := math.Min(math.Max(wait, 1.0)*3.0, 90.0)
	extended := false
	after := -1
	printed := ""
	picked := false
	var pickedAt time.Time
	showActivity := true
	state := "pending"
	text := ""
	var markdown, errorText *string
	var meta map[string]any
	var snap map[string]any

	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)
	defer signal.Stop(interrupt)

	for {
		select {
		case <-interrupt:
			remote.cancel(jobID)
			ACTIVITY.Clear()
			return 130
		default:
		}
		snap, err = remote.state(jobID, after, 2.0)
		if err != nil {
			ACTIVITY.Clear()
			if strings.Contains(err.Error(), "unknown job") {
				fmt.Fprintln(os.Stderr,
					"termchat: the server no longer has this job "+
						"(its client stopped polling).")
			} else {
				fmt.Fprintf(os.Stderr, "termchat: %s\n", err)
			}
			return 1
		}
		after = intValue(snap["seq"], after)
		if value, ok := snap["state"].(string); ok && value != "" {
			state = value
		}
		if value, ok := snap["text"].(string); ok {
			text = value
		} else {
			text = ""
		}
		if value, ok := snap["markdown"].(string); ok {
			markdown = &value
		}
		if truthy(snap["error"]) {
			value := pyString(snap["error"])
			errorText = &value
		} else {
			errorText = nil
		}
		if object, ok := snap["meta"].(map[string]any); ok && len(object) > 0 {
			meta = object
		} else {
			meta = nil
		}
		if state == "running" || state == "done" {
			if !picked {
				pickedAt = time.Now()
			}
			picked = true
		}

		queued := intValue(snap["queued_ahead"], 0)
		if queued != 0 {
			// Someone else's job is ahead of us; the connect timeout should
			// not start until our turn.
			idleSince = time.Now()
		}

		if !picked && queued == 0 {
			idle := time.Since(idleSince).Seconds()
			limit := wait
			if extended {
				limit = late
			}
			if idle > limit {
				if !extended && late > wait {
					awake := false
					if info, pingErr := remote.ping(); pingErr == nil {
						if age, ok := info["last_ping_age"].(float64); ok && age <= 60 {
							awake = true
						}
					}
					if awake {
						extended = true
						continue
					}
				}
				ACTIVITY.Clear()
				remote.cancel(jobID)
				fmt.Fprintf(os.Stderr,
					"termchat: no browser tab picked up the job (server %s).\n", remote.URL)
				fmt.Fprintf(os.Stderr,
					"termchat: run 'termchat %s --check' to see whether the "+
						"extension can reach this server.\n", job.Site)
				return 3
			}
		}

		if stream && text != printed {
			ACTIVITY.Clear()
			printed = printDelta(text, printed, stream)
			showActivity = false
		} else if showActivity {
			if picked {
				ACTIVITY.Update(fmt.Sprintf("%s: answering", job.Site),
					time.Since(pickedAt).Seconds())
			} else {
				ACTIVITY.Update(
					fmt.Sprintf("%s: sent to %s, waiting for the browser tab",
						job.Site, remote.URL),
					time.Since(idleSince).Seconds())
			}
		}
		if state == "done" {
			break
		}
		if time.Now().After(deadline) {
			ACTIVITY.Clear()
			remote.cancel(jobID)
			message := fmt.Sprintf("timed out after %gs waiting for the page", timeout)
			errorText = &message
			break
		}
	}
	ACTIVITY.Clear()

	if truthy(snap["inspect"]) {
		printJSON(meta)
		if state == "done" && errorText == nil {
			return 0
		}
		return 1
	}

	if errorText != nil && *errorText != "" {
		if stream && printed != "" {
			fmt.Fprint(os.Stdout, "\n")
		}
		fmt.Fprintf(os.Stderr, "termchat: %s\n", *errorText)
		if len(meta) > 0 {
			failed := &Job{
				Site:  job.Site,
				Error: errorText,
				Meta:  meta,
				State: "done",
			}
			if path := saveDiagnostics(failed); path != "" {
				fmt.Fprintf(os.Stderr, "termchat: page diagnostics saved to %s\n", path)
			}
		}
		if jsonMode {
			printJSON(map[string]any{
				"site": job.Site, "text": text, "error": *errorText, "meta": meta,
			})
		}
		return 1
	}

	if jsonMode {
		printJSON(map[string]any{
			"site": job.Site, "text": text, "error": nil, "meta": meta,
		})
	} else {
		emitAnswer(text, markdown, printed, stream, styled, color)
	}
	return 0
}

func intValue(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case string:
		if parsed, err := strconv.Atoi(typed); err == nil {
			return parsed
		}
	}
	return fallback
}

func printJSON(value any) {
	if value == nil {
		value = map[string]any{}
	}
	data, err := marshalIndented(value)
	if err != nil {
		return
	}
	fmt.Fprintln(os.Stdout, string(data))
}
