//go:build !linux

package main

import (
	"os"
	"strconv"
)

func terminalColumns() int {
	if value := os.Getenv("COLUMNS"); value != "" {
		if columns, err := strconv.Atoi(value); err == nil && columns > 0 {
			return columns
		}
	}
	return 80
}
