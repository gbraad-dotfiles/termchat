//go:build linux

package main

import (
	"os"
	"strconv"
	"syscall"
	"unsafe"
)

type terminalSize struct {
	rows    uint16
	cols    uint16
	xpixels uint16
	ypixels uint16
}

func terminalColumns() int {
	if value := os.Getenv("COLUMNS"); value != "" {
		if columns, err := strconv.Atoi(value); err == nil && columns > 0 {
			return columns
		}
	}
	size := &terminalSize{}
	_, _, errno := syscall.Syscall(
		syscall.SYS_IOCTL,
		os.Stdout.Fd(),
		uintptr(syscall.TIOCGWINSZ),
		uintptr(unsafe.Pointer(size)),
	)
	if errno == 0 && size.cols > 0 {
		return int(size.cols)
	}
	return 80
}
