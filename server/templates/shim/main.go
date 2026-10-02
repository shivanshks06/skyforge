// skyforge-shim: runs the application and, if it only listens on loopback (localhost),
// forwards the container's external address on the same port to it, so load balancer
// health checks and traffic can reach apps hard-coded to bind 127.0.0.1 or ::1.
//
// Usage: skyforge-shim <port> <command> [args...]
package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: skyforge-shim <port> <command> [args...]")
		os.Exit(2)
	}
	port := os.Args[1]
	cmd := exec.Command(os.Args[2], os.Args[3:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "skyforge-shim:", err)
		os.Exit(127)
	}

	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP, syscall.SIGQUIT)
	go func() {
		for sig := range signals {
			_ = cmd.Process.Signal(sig)
		}
	}()
	go bridge(port)

	err := cmd.Wait()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			os.Exit(128 + int(status.Signal()))
		}
		os.Exit(exitErr.ExitCode())
	}
	if err != nil {
		os.Exit(1)
	}
}

func bridge(port string) {
	deadline := time.Now().Add(15 * time.Minute)
	for time.Now().Before(deadline) {
		upstream := ""
		for _, host := range []string{"127.0.0.1", "::1"} {
			address := net.JoinHostPort(host, port)
			if conn, err := net.DialTimeout("tcp", address, time.Second); err == nil {
				conn.Close()
				upstream = address
				break
			}
		}
		if upstream == "" {
			time.Sleep(time.Second)
			continue
		}
		// The app is listening on loopback. Binding an external address fails with
		// EADDRINUSE when it already listens on all interfaces, which is the normal case.
		for _, ip := range externalAddresses() {
			listener, err := net.Listen("tcp", net.JoinHostPort(ip, port))
			if err != nil {
				return
			}
			fmt.Fprintf(os.Stderr, "skyforge-shim: app listens on %s only; forwarding %s:%s to it\n", upstream, ip, port)
			go serve(listener, upstream)
		}
		return
	}
}

func externalAddresses() []string {
	var result []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return result
	}
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() && ipNet.IP.To4() != nil {
			result = append(result, ipNet.IP.String())
		}
	}
	return result
}

func serve(listener net.Listener, upstream string) {
	for {
		client, err := listener.Accept()
		if err != nil {
			return
		}
		go func() {
			defer client.Close()
			server, err := net.DialTimeout("tcp", upstream, 5*time.Second)
			if err != nil {
				return
			}
			defer server.Close()
			done := make(chan struct{}, 2)
			go func() { _, _ = io.Copy(server, client); done <- struct{}{} }()
			go func() { _, _ = io.Copy(client, server); done <- struct{}{} }()
			<-done
		}()
	}
}
