package herdrapi

import (
	"bufio"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// connLog is what one fake-server connection saw.
type connLog struct {
	lines  []string // complete request lines, newline stripped
	sawEOF bool     // peer closed after those lines, i.e. no reuse attempt
}

// fakeServer is an in-process herdr stand-in on a real unix socket.
//
// It answers only the FIRST line of each connection, then keeps reading so a
// test can prove the client sent nothing more and closed (G10: one request per
// connection).
type fakeServer struct {
	t    *testing.T
	path string
	ln   net.Listener

	// respond returns the response line for a request line. Returning ok=false
	// means "stay silent", which is how a wedged herdr UI thread behaves.
	respond func(request string) (response string, ok bool)

	mu    sync.Mutex
	conns []*connLog
}

// newFakeServer listens on a short socket path. Paths are kept short on
// purpose: sun_path is 104 bytes on darwin.
func newFakeServer(t *testing.T, respond func(string) (string, bool)) *fakeServer {
	t.Helper()
	dir, err := os.MkdirTemp("", "hapi")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	path := filepath.Join(dir, "h.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen %s: %v", path, err)
	}
	s := &fakeServer{t: t, path: path, ln: ln, respond: respond}
	t.Cleanup(func() { _ = ln.Close() })

	go s.acceptLoop()
	return s
}

func (s *fakeServer) acceptLoop() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		log := &connLog{}
		s.mu.Lock()
		s.conns = append(s.conns, log)
		s.mu.Unlock()
		go s.serve(conn, log)
	}
}

func (s *fakeServer) serve(conn net.Conn, log *connLog) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	answered := false
	for {
		line, err := r.ReadString('\n')
		if len(line) > 0 {
			s.mu.Lock()
			log.lines = append(log.lines, trimNewline(line))
			s.mu.Unlock()
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				s.mu.Lock()
				log.sawEOF = true
				s.mu.Unlock()
			}
			return
		}
		if answered || s.respond == nil {
			continue
		}
		answered = true
		if resp, ok := s.respond(trimNewline(line)); ok {
			if _, err := io.WriteString(conn, resp+"\n"); err != nil {
				return
			}
		}
	}
}

func trimNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}

// connections returns a snapshot of every connection the server has accepted.
func (s *fakeServer) connections() []connLog {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]connLog, len(s.conns))
	for i, c := range s.conns {
		out[i] = connLog{lines: append([]string(nil), c.lines...), sawEOF: c.sawEOF}
	}
	return out
}

// requests returns the first line of every connection.
func (s *fakeServer) requests() []string {
	var out []string
	for _, c := range s.connections() {
		if len(c.lines) > 0 {
			out = append(out, c.lines[0])
		}
	}
	return out
}

// client returns a socketClient pointed at this server.
func (s *fakeServer) client(t *testing.T) *socketClient {
	t.Helper()
	c, err := New(Options{SocketPath: s.path})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return c.(*socketClient)
}
