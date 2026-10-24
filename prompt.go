package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

func readFile(path string, readStdin func() string) (string, string, error) {
	if path == "-" {
		return "<stdin>", readStdin(), nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}
	prefix := data
	if len(prefix) > 8192 {
		prefix = prefix[:8192]
	}
	if strings.ContainsRune(string(prefix), '\x00') {
		return "", "", fmt.Errorf("%s: looks like a binary file", path)
	}
	text := strings.ToValidUTF8(string(data), "�")
	return path, text, nil
}

type namedFile struct {
	name string
	data string
}

func composePrompt(parts []string, files []namedFile) string {
	nonEmpty := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			nonEmpty = append(nonEmpty, part)
		}
	}
	prompt := strings.TrimSpace(strings.Join(nonEmpty, " "))
	if len(files) == 0 {
		return prompt
	}
	blocks := make([]string, 0, len(files)+1)
	for _, file := range files {
		data := file.data
		if !strings.HasSuffix(data, "\n") {
			data += "\n"
		}
		blocks = append(blocks, `<file path="`+file.name+`">`+"\n"+data+"</file>")
	}
	if prompt != "" {
		blocks = append(blocks, prompt)
	}
	return strings.Join(blocks, "\n\n")
}

func gatherPrompt(opts *options, stdinIsTTY bool) (string, error) {
	stdinUsed := false
	readStdin := func() string {
		if stdinUsed {
			return ""
		}
		stdinUsed = true
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return ""
		}
		return string(data)
	}

	files := make([]namedFile, 0, len(opts.files))
	for _, path := range opts.files {
		name, data, err := readFile(path, readStdin)
		if err != nil {
			return "", err
		}
		files = append(files, namedFile{name, data})
	}

	parts := append([]string(nil), opts.prompt...)
	if len(parts) == 1 && parts[0] == "-" {
		parts = []string{readStdin()}
	} else if len(parts) == 0 && !opts.interactive && !opts.inspect &&
		!stdinUsed && !stdinIsTTY {
		parts = []string{readStdin()}
	}

	return composePrompt(parts, files), nil
}
