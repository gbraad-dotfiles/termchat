package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf8"
)

const mainUsage = "usage: termchat [-h] [-f PATH] [--new | --continue] [--inspect] " +
	"[--check] [-i] [--timeout SECONDS] [--wait SECONDS] [--json | --plain | " +
	"--markdown] [--server URL | --local] [--port PORT] [--bind ADDR] " +
	"[--token TOKEN] [-v] site [prompt ...]"

const serveUsage = "usage: termchat serve [-h] [--bind ADDR] [--port PORT] " +
	"[--token TOKEN] [-v]"

type options struct {
	site         string
	prompt       []string
	files        []string
	newFlag      bool
	continueChat bool
	inspect      bool
	check        bool
	interactive  bool
	timeout      *float64
	wait         *float64
	jsonMode     bool
	plain        bool
	markdown     bool
	server       *string
	local        bool
	port         *int
	bind         *string
	token        *string
	verbose      bool
}

type serveOptions struct {
	bind    *string
	port    *int
	token   *string
	verbose bool
}

func main() {
	code := run(os.Args[1:])
	ACTIVITY.Clear()
	os.Exit(code)
}

func printMainHelp() {
	fmt.Println(mainUsage)
	fmt.Println()
	fmt.Println("Talk to Gemini, Copilot or DeepSeek chat from the terminal through")
	fmt.Println("your logged-in browser.")
	fmt.Println()
	fmt.Println("positional arguments:")
	fmt.Println("  site              gemini, copilot or deepseek")
	fmt.Println("  prompt            prompt text; use '-' or pipe stdin to read it")
	fmt.Println()
	fmt.Println("options:")
	fmt.Println("  -h, --help        show this help message and exit")
	fmt.Println("  -f, --file PATH   include a file's contents in the prompt (repeatable)")
	fmt.Println("  --new             start a new chat")
	fmt.Println("  --continue        use the chat already open in the tab")
	fmt.Println("  --inspect         print what the extension sees on the page")
	fmt.Println("  --check           wait for the extension and report how far it gets")
	fmt.Println("  -i, --interactive read prompts in a small REPL")
	fmt.Println("  --timeout SECONDS seconds to wait for an answer")
	fmt.Println("  --wait SECONDS    seconds to wait for the browser extension")
	fmt.Println("  --json            print a JSON object instead of the answer text")
	fmt.Println("  --plain           print the answer as plain text")
	fmt.Println("  --markdown        render Markdown styling even when piped")
	fmt.Println("  --server URL      submit to a running 'termchat serve'")
	fmt.Println("  --local           always start a private bridge")
	fmt.Println("  --port PORT       base port")
	fmt.Println("  --bind ADDR       address to listen on")
	fmt.Println("  --token TOKEN     require this token from the extension")
	fmt.Println("  -v, --verbose     log bridge traffic")
}

func printServeHelp() {
	fmt.Println(serveUsage)
	fmt.Println()
	fmt.Println("Run one persistent bridge that the browser extension and any number")
	fmt.Println("of termchat clients can share.")
	fmt.Println()
	fmt.Println("options:")
	fmt.Println("  -h, --help      show this help message and exit")
	fmt.Println("  --bind ADDR     address to listen on (default 127.0.0.1)")
	fmt.Println("  --port PORT     port to listen on (default 8765)")
	fmt.Println("  --token TOKEN   require this token from extensions and clients")
	fmt.Println("  -v, --verbose   log bridge traffic")
}

func parseOptions(argv []string) (*options, string) {
	opts := &options{}
	positional := make([]string, 0, len(argv))
	endOfFlags := false

	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		if endOfFlags {
			positional = append(positional, arg)
			continue
		}
		if arg == "--" {
			endOfFlags = true
			continue
		}
		if arg == "-" || !strings.HasPrefix(arg, "-") {
			positional = append(positional, arg)
			continue
		}
		if !strings.HasPrefix(arg, "--") && strings.HasPrefix(arg, "-f") && len(arg) > 2 {
			opts.files = append(opts.files, arg[2:])
			continue
		}

		name := arg
		inline := ""
		hasInline := false
		if strings.HasPrefix(arg, "--") {
			if equals := strings.IndexByte(arg, '='); equals >= 0 {
				name, inline, hasInline = arg[:equals], arg[equals+1:], true
			}
		}

		value := func() (string, string) {
			if hasInline {
				return inline, ""
			}
			i++
			if i >= len(argv) {
				return "", fmt.Sprintf("argument %s: expected one argument", name)
			}
			return argv[i], ""
		}

		switch name {
		case "-h", "--help":
			return nil, "help"
		case "-f", "--file":
			path, err := value()
			if err != "" {
				return nil, err
			}
			opts.files = append(opts.files, path)
		case "--timeout":
			raw, err := value()
			if err != "" {
				return nil, err
			}
			parsed, parseErr := strconv.ParseFloat(raw, 64)
			if parseErr != nil {
				return nil, fmt.Sprintf("argument --timeout: invalid float value: '%s'", raw)
			}
			opts.timeout = &parsed
		case "--wait":
			raw, err := value()
			if err != "" {
				return nil, err
			}
			parsed, parseErr := strconv.ParseFloat(raw, 64)
			if parseErr != nil {
				return nil, fmt.Sprintf("argument --wait: invalid float value: '%s'", raw)
			}
			opts.wait = &parsed
		case "--server":
			raw, err := value()
			if err != "" {
				return nil, err
			}
			opts.server = &raw
		case "--port":
			raw, err := value()
			if err != "" {
				return nil, err
			}
			parsed, parseErr := strconv.Atoi(raw)
			if parseErr != nil {
				return nil, fmt.Sprintf("argument --port: invalid int value: '%s'", raw)
			}
			opts.port = &parsed
		case "--bind":
			raw, err := value()
			if err != "" {
				return nil, err
			}
			opts.bind = &raw
		case "--token":
			raw, err := value()
			if err != "" {
				return nil, err
			}
			opts.token = &raw
		case "--new":
			if hasInline {
				return nil, fmt.Sprintf("argument --new: ignored explicit argument '%s'", inline)
			}
			opts.newFlag = true
		case "--continue":
			if hasInline {
				return nil, fmt.Sprintf("argument --continue: ignored explicit argument '%s'", inline)
			}
			opts.continueChat = true
		case "--inspect":
			opts.inspect = true
		case "--check":
			opts.check = true
		case "-i", "--interactive":
			opts.interactive = true
		case "--json":
			opts.jsonMode = true
		case "--plain":
			opts.plain = true
		case "--markdown":
			opts.markdown = true
		case "--local":
			opts.local = true
		case "-v", "--verbose":
			opts.verbose = true
		default:
			return nil, fmt.Sprintf("unrecognized arguments: %s", arg)
		}
	}

	if len(positional) == 0 {
		return nil, "the following arguments are required: site"
	}
	opts.site = positional[0]
	if !isSite(opts.site) {
		return nil, fmt.Sprintf(
			"argument site: invalid choice: '%s' (choose from 'gemini', 'copilot', 'deepseek')",
			opts.site)
	}
	opts.prompt = append([]string(nil), positional[1:]...)
	return opts, ""
}

func parseServeOptions(argv []string) (*serveOptions, string) {
	opts := &serveOptions{}
	for i := 0; i < len(argv); i++ {
		arg := argv[i]
		name := arg
		inline := ""
		hasInline := false
		if strings.HasPrefix(arg, "--") {
			if equals := strings.IndexByte(arg, '='); equals >= 0 {
				name, inline, hasInline = arg[:equals], arg[equals+1:], true
			}
		}
		value := func() (string, string) {
			if hasInline {
				return inline, ""
			}
			i++
			if i >= len(argv) {
				return "", fmt.Sprintf("argument %s: expected one argument", name)
			}
			return argv[i], ""
		}
		switch name {
		case "-h", "--help":
			return nil, "help"
		case "--bind":
			raw, err := value()
			if err != "" {
				return nil, err
			}
			opts.bind = &raw
		case "--port":
			raw, err := value()
			if err != "" {
				return nil, err
			}
			parsed, parseErr := strconv.Atoi(raw)
			if parseErr != nil {
				return nil, fmt.Sprintf("argument --port: invalid int value: '%s'", raw)
			}
			opts.port = &parsed
		case "--token":
			raw, err := value()
			if err != "" {
				return nil, err
			}
			opts.token = &raw
		case "-v", "--verbose":
			opts.verbose = true
		default:
			return nil, fmt.Sprintf("unrecognized arguments: %s", arg)
		}
	}
	return opts, ""
}

func configPath() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			home = "."
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "terminal-chat", "config.json")
}

func loadConfig() map[string]any {
	data, err := os.ReadFile(configPath())
	if err != nil {
		return map[string]any{}
	}
	var payload any
	if err := json.Unmarshal(data, &payload); err != nil {
		return map[string]any{}
	}
	object, ok := payload.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return object
}

func asFloat(value any, fallback float64) float64 {
	if number, ok := asNumber(value); ok {
		return number
	}
	return fallback
}

func asInt(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case string:
		if number, err := strconv.Atoi(strings.TrimSpace(typed)); err == nil {
			return number
		}
	}
	return fallback
}

func configString(config map[string]any, key string) string {
	value, present := config[key]
	if !present {
		return ""
	}
	return pyStringOrEmpty(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func run(argv []string) int {
	if len(argv) > 0 && argv[0] == "serve" {
		return serveMain(argv[1:])
	}

	opts, parseError := parseOptions(argv)
	if parseError == "help" {
		printMainHelp()
		return 0
	}
	if parseError != "" {
		fmt.Fprintln(os.Stderr, mainUsage)
		fmt.Fprintf(os.Stderr, "termchat: error: %s\n", parseError)
		return 2
	}

	fail := func(message string) int {
		fmt.Fprintln(os.Stderr, mainUsage)
		fmt.Fprintf(os.Stderr, "termchat: error: %s\n", message)
		return 2
	}
	if opts.newFlag && opts.continueChat {
		return fail("--new and --continue are mutually exclusive")
	}
	if opts.local && opts.server != nil && *opts.server != "" {
		return fail("--server and --local are mutually exclusive")
	}
	if opts.plain && opts.markdown {
		return fail("--plain and --markdown are mutually exclusive")
	}

	config := loadConfig()
	basePort := defaultBasePort
	if opts.port != nil && *opts.port != 0 {
		basePort = *opts.port
	} else if env := os.Getenv("TERMCHAT_BASE_PORT"); env != "" {
		basePort = asInt(env, defaultBasePort)
	} else if value, present := config["base_port"]; present && truthy(value) {
		basePort = asInt(value, defaultBasePort)
	}
	span := asInt(config["port_span"], defaultPortSpan)
	if span < 1 {
		span = 1
	}
	timeout := defaultTimeout
	if opts.timeout != nil {
		timeout = *opts.timeout
	} else {
		timeout = asFloat(config["timeout"], defaultTimeout)
	}
	wait := defaultConnectWait
	if opts.wait != nil {
		wait = *opts.wait
	} else {
		wait = asFloat(config["connect_wait"], defaultConnectWait)
	}
	bind := "127.0.0.1"
	if opts.bind != nil && *opts.bind != "" {
		bind = *opts.bind
	} else if env := os.Getenv("TERMCHAT_BIND"); env != "" {
		bind = env
	} else if configured := configString(config, "bind"); configured != "" {
		bind = configured
	}
	token := ""
	if opts.token != nil {
		token = *opts.token
	} else if env := os.Getenv("TERMCHAT_TOKEN"); env != "" {
		token = env
	} else {
		token = configString(config, "token")
	}

	var remote *RemoteClient
	if !opts.local {
		configuredServer := ""
		if opts.server != nil {
			configuredServer = *opts.server
		}
		if configuredServer == "" {
			configuredServer = os.Getenv("TERMCHAT_SERVER")
		}
		if configuredServer == "" {
			configuredServer = configString(config, "server")
		}
		if configuredServer != "" {
			remote = &RemoteClient{
				URL:   normalizeServerURL(configuredServer, basePort),
				Token: token,
			}
		} else if detected := detectServer(basePort); detected != "" {
			remote = &RemoteClient{URL: detected, Token: token}
			if opts.verbose {
				fmt.Fprintf(os.Stderr, "termchat: using server %s\n", detected)
			}
		}
	}

	prompt := ""
	if !opts.check {
		gathered, err := gatherPrompt(opts, isTerminal(os.Stdin))
		if err != nil {
			fmt.Fprintf(os.Stderr, "termchat: %s\n", err)
			return 3
		}
		prompt = gathered
	}

	if !opts.interactive && !opts.inspect && !opts.check &&
		strings.TrimSpace(prompt) == "" {
		fmt.Fprintln(os.Stderr, mainUsage)
		fmt.Fprintln(os.Stderr,
			"termchat: give a prompt, pipe one in, or use -i/--inspect")
		return 3
	}

	if length := utf8.RuneCountInString(prompt); length > largePrompt {
		fmt.Fprintf(os.Stderr,
			"termchat: prompt is large (%s characters); the site may truncate it\n",
			formatCommas(length))
	}

	_, noColor := os.LookupEnv("NO_COLOR")
	styled := !opts.jsonMode && !opts.inspect && !opts.plain &&
		(opts.markdown || isTerminal(os.Stdout))
	color := styled && !noColor
	stream := !opts.jsonMode && !styled && isTerminal(os.Stdout)
	// Progress feedback only when a person is looking at a terminal. Piped
	// output remains quiet for scripts, tests and other commands.
	ACTIVITY.Enabled = isTerminal(os.Stderr) && !opts.jsonMode
	ACTIVITY.Color = color

	if remote != nil {
		if opts.check {
			return checkRemote(remote, opts.site, wait, opts.verbose)
		}
		if opts.interactive {
			return interactive(nil, opts, timeout, wait, stream, remote,
				styled, color, "")
		}
		job := newJob(opts.site, prompt, !opts.continueChat, opts.inspect, timeout)
		return runRemote(remote, job, timeout, wait, stream, opts.jsonMode,
			styled, color)
	}

	bridge := newBridge(bridgeOptions{
		Verbose: opts.verbose,
		Token:   token,
		Mode:    "ephemeral",
	})
	server, port, err := startBridge(bridge, basePort, span, bind)
	if err != nil {
		fmt.Fprintf(os.Stderr, "termchat: %s\n", err)
		return 1
	}
	defer server.Close()
	if opts.verbose {
		fmt.Fprintf(os.Stderr, "termchat: bridge listening on http://%s:%d\n", bind, port)
		if !isLoopbackAddress(bind) && token == "" {
			fmt.Fprintf(os.Stderr,
				"termchat: no token; anyone who can reach http://%s:%d can use the bridge\n",
				bind, port)
		}
	}
	bridgeHint := fmt.Sprintf("%s:%d", bind, port)
	if bind == "0.0.0.0" || bind == "::" {
		bridgeHint = fmt.Sprintf("port %d", port)
	}

	if opts.check {
		return checkBridge(bridge, bind, port, wait, opts.site)
	}
	if opts.interactive {
		return interactive(bridge, opts, timeout, wait, stream, nil, styled, color,
			bridgeHint)
	}
	job := newJob(opts.site, prompt, !opts.continueChat, opts.inspect, timeout)
	return runJob(bridge, job, timeout, wait, stream, opts.jsonMode, bridgeHint,
		styled, color)
}

func serveMain(argv []string) int {
	opts, parseError := parseServeOptions(argv)
	if parseError == "help" {
		printServeHelp()
		return 0
	}
	if parseError != "" {
		fmt.Fprintln(os.Stderr, serveUsage)
		fmt.Fprintf(os.Stderr, "termchat: error: %s\n", parseError)
		return 2
	}

	config := loadConfig()
	port := defaultBasePort
	if opts.port != nil && *opts.port != 0 {
		port = *opts.port
	} else if env := os.Getenv("TERMCHAT_BASE_PORT"); env != "" {
		port = asInt(env, defaultBasePort)
	} else if value, present := config["base_port"]; present && truthy(value) {
		port = asInt(value, defaultBasePort)
	}
	bind := "127.0.0.1"
	if opts.bind != nil && *opts.bind != "" {
		bind = *opts.bind
	} else if env := os.Getenv("TERMCHAT_BIND"); env != "" {
		bind = env
	} else if configured := configString(config, "bind"); configured != "" {
		bind = configured
	}
	token := ""
	if opts.token != nil {
		token = *opts.token
	} else if env := os.Getenv("TERMCHAT_TOKEN"); env != "" {
		token = env
	} else {
		token = configString(config, "token")
	}
	pendingTTL := 15.0
	if env := os.Getenv("TERMCHAT_PENDING_TTL"); env != "" {
		pendingTTL = asFloat(env, 15.0)
	} else if value, present := config["pending_ttl"]; present && truthy(value) {
		pendingTTL = asFloat(value, 15.0)
	}
	if pendingTTL < 1.0 {
		pendingTTL = 1.0
	}

	bridge := newBridge(bridgeOptions{
		Verbose:    opts.verbose,
		Token:      token,
		Mode:       "server",
		PendingTTL: secondsToDuration(pendingTTL),
	})

	listener, err := net.Listen("tcp", net.JoinHostPort(bind, strconv.Itoa(port)))
	if err != nil {
		fmt.Fprintf(os.Stderr, "termchat: cannot listen on %s:%d: %v\n", bind, port, err)
		fmt.Fprintln(os.Stderr, "termchat: is another server already using that port?")
		return 1
	}
	server := &http.Server{Handler: &bridgeHandler{bridge: bridge}}
	fmt.Fprintf(os.Stderr, "termchat: server listening on http://%s:%d\n", bind, port)
	webHost := bind
	if isLoopbackAddress(bind) {
		webHost = "127.0.0.1"
	}
	fmt.Fprintf(os.Stderr, "termchat: web UI at http://%s:%d/\n", webHost, port)
	if !isLoopbackAddress(bind) && token == "" {
		fmt.Fprintf(os.Stderr,
			"termchat: no token; anyone who can reach http://%s:%d can submit jobs\n",
			bind, port)
	}

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- server.Serve(listener)
	}()

	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(interrupt)

	select {
	case <-interrupt:
		fmt.Fprintln(os.Stderr)
		_ = server.Close()
	case err := <-serveErr:
		if err != nil && err != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "termchat: %v\n", err)
			return 1
		}
	}
	return 0
}

func interactive(
	bridge *Bridge,
	opts *options,
	timeout, wait float64,
	stream bool,
	remote *RemoteClient,
	styled, color bool,
	bridgeHint string,
) int {
	site := opts.site
	newChat := !opts.continueChat
	fmt.Fprintf(os.Stderr,
		"termchat %s: type a message (:help for commands, :quit to exit)\n", site)

	reader := bufio.NewReader(os.Stdin)
	readLine := func(prompt string) (string, bool) {
		fmt.Fprint(os.Stdout, prompt)
		line, err := reader.ReadString('\n')
		if err != nil && line == "" {
			return "", false
		}
		line = strings.TrimSuffix(line, "\n")
		line = strings.TrimSuffix(line, "\r")
		return line, true
	}

	for {
		line, ok := readLine(site + "> ")
		if !ok {
			fmt.Fprintln(os.Stderr)
			return 0
		}
		if strings.HasSuffix(line, "\\") {
			chunks := []string{line[:len(line)-1]}
			for {
				more, ok := readLine("...> ")
				if !ok {
					fmt.Fprintln(os.Stderr)
					return 0
				}
				if strings.HasSuffix(more, "\\") {
					chunks = append(chunks, more[:len(more)-1])
				} else {
					chunks = append(chunks, more)
					break
				}
			}
			line = strings.Join(chunks, "\n")
		}

		command := strings.TrimSpace(line)
		if command == "" {
			continue
		}
		switch command {
		case ":quit", ":q", ":exit":
			return 0
		case ":help":
			fmt.Fprint(os.Stderr,
				"  :new       start the next message in a new chat\n"+
					"  :continue  keep using the open chat\n"+
					"  :inspect   dump what the extension can see on the page\n"+
					"  :quit      exit\n")
			continue
		case ":new":
			newChat = true
			fmt.Fprintln(os.Stderr, "termchat: next message starts a new chat")
			continue
		case ":continue", ":cont":
			newChat = false
			fmt.Fprintln(os.Stderr, "termchat: next message continues the open chat")
			continue
		case ":inspect":
			job := newJob(site, "", false, true, timeout)
			if remote != nil {
				runRemote(remote, job, timeout, wait, false, true, false, color)
			} else {
				runJob(bridge, job, timeout, wait, false, true, bridgeHint, false, color)
			}
			continue
		}

		job := newJob(site, line, newChat, false, timeout)
		newChat = false
		if remote != nil {
			runRemote(remote, job, timeout, wait, stream, opts.jsonMode, styled, color)
		} else {
			runJob(bridge, job, timeout, wait, stream, opts.jsonMode, bridgeHint,
				styled, color)
		}
	}
}

func isTerminal(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func formatCommas(number int) string {
	text := strconv.Itoa(number)
	negative := strings.HasPrefix(text, "-")
	if negative {
		text = text[1:]
	}
	var out strings.Builder
	for index, digit := range text {
		if index > 0 && (len(text)-index)%3 == 0 {
			out.WriteByte(',')
		}
		out.WriteRune(digit)
	}
	if negative {
		return "-" + out.String()
	}
	return out.String()
}
