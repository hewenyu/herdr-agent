package bridge

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// PidFileName is the single-instance lock, kept in the state directory next to
// dedup.json and routes.json (S2 §3.1).
const PidFileName = "herdr-agent.pid"

// lockAttempts bounds the retry loop that resolves a race against another
// instance releasing its lock at the same moment: between our open and our
// flock, the file we are holding can be unlinked, and locking a deleted inode
// would let a third process create a fresh pid file and start a second bridge.
// Each retry re-opens by path, so a handful is plenty; the loop exists to
// terminate, not to wait anything out.
const lockAttempts = 5

var (
	// ErrAlreadyRunning means a live instance holds the lock. Feishu allows one
	// WebSocket connection per app_id: a second bridge does not fail loudly, it
	// takes turns stealing the connection from the first, and the user
	// experiences that as "Feishu is flaky" (G15).
	ErrAlreadyRunning = errors.New("bridge: another herdr-agent instance is already running")

	// ErrNoStateDir rejects an empty state directory rather than locking
	// "herdr-agent.pid" in the current working directory, where a second
	// instance started from elsewhere would not see it.
	ErrNoStateDir = errors.New("bridge: no state directory for the single-instance lock")
)

// InstanceLock is a held single-instance lock. Release it on shutdown.
type InstanceLock struct {
	path string

	mu       sync.Mutex
	f        *os.File
	released bool
}

// LockOption configures AcquireInstanceLock.
type LockOption func(*lockOptions)

type lockOptions struct{ log *slog.Logger }

// WithLockLogger sets where the lock reports a takeover. Nil is ignored.
func WithLockLogger(l *slog.Logger) LockOption {
	return func(o *lockOptions) {
		if l != nil {
			o.log = l
		}
	}
}

// AcquireInstanceLock takes the process-wide lock for dir, creating dir if
// needed.
//
// It must be called BEFORE any network I/O (S2 §3.1). One app_id may hold
// exactly one Feishu WebSocket connection, so two bridges fight over it and
// each disconnects the other (G15); the second one has to die before it
// connects, not after it has already knocked the first one off.
//
// The lock is an flock on the pid file, and the flock — not the recorded pid —
// is the authority. A kernel lock is released when its holder dies however it
// died, so a pid file left behind by a crash is stale by definition and is
// taken over rather than treated as fatal, which is what keeps a power cut from
// requiring manual cleanup. The pid inside is for humans and for the error
// message; a pid can be reused by an unrelated process, so trusting it would
// lock the user out of their own bridge with no way back except rm.
func AcquireInstanceLock(dir string, opts ...LockOption) (*InstanceLock, error) {
	o := lockOptions{log: slog.Default()}
	for _, opt := range opts {
		if opt != nil {
			opt(&o)
		}
	}

	if strings.TrimSpace(dir) == "" {
		return nil, ErrNoStateDir
	}
	// 0700: the state directory holds the dedup and routes stores, and reaching
	// this bridge is equivalent to shell access on this machine (G10).
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("bridge: create state directory %s: %w", dir, err)
	}
	path := filepath.Join(dir, PidFileName)

	for attempt := 0; attempt < lockAttempts; attempt++ {
		f, fresh, err := openPidFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			// Someone released (and unlinked) between our two opens. Try again
			// from the top; the O_EXCL create will win this time.
			continue
		}
		if err != nil {
			return nil, err
		}

		if err := flockNB(f); err != nil {
			holder, _ := readPid(f)
			_ = f.Close()
			if errors.Is(err, syscall.EWOULDBLOCK) {
				return nil, fmt.Errorf("%w: %s is locked by pid %s; stop it first "+
					"(a second connection would knock the first one off the Feishu socket)",
					ErrAlreadyRunning, path, pidText(holder))
			}
			return nil, fmt.Errorf("bridge: lock %s: %w", path, err)
		}

		// The file we locked must still be the file at path. If a releasing
		// instance unlinked it after we opened it, our lock is on a deleted
		// inode and protects nothing.
		same, err := stillAtPath(f, path)
		if err != nil {
			_ = f.Close()
			return nil, fmt.Errorf("bridge: verify %s: %w", path, err)
		}
		if !same {
			_ = f.Close()
			continue
		}

		if !fresh {
			prev, ok := readPid(f)
			// Nobody held the flock, so whatever wrote this is not running as a
			// bridge any more. Saying so is worth a line: a takeover means the
			// last run did not shut down cleanly.
			o.log.Warn("bridge: taking over a stale single-instance lock",
				"path", path, "previous_pid", pidText(prev),
				"previous_pid_still_alive", ok && processAlive(prev))
		}

		if err := writePid(f, os.Getpid()); err != nil {
			_ = f.Close()
			return nil, err
		}
		// Everything in the state directory is 0600 (S2 §3.1); a pid file
		// inherited from an older run may not be.
		if err := f.Chmod(0o600); err != nil && !errors.Is(err, fs.ErrNotExist) {
			o.log.Warn("bridge: could not tighten pid file permissions", "path", path, "err", err)
		}
		return &InstanceLock{path: path, f: f}, nil
	}

	return nil, fmt.Errorf("bridge: could not take %s after %d attempts: it is being created and "+
		"removed concurrently", path, lockAttempts)
}

// Path is the pid file this lock is held on.
func (l *InstanceLock) Path() string { return l.path }

// Release unlinks the pid file and drops the lock. It is idempotent.
//
// The unlink happens FIRST, on purpose. Unlocking first opens a window in which
// another instance can flock the inode we are about to delete: it would then
// hold a lock on a file that no longer has a name, and a third instance would
// create a fresh pid file and lock that — two bridges, two WebSocket
// connections, the G15 failure this whole file exists to prevent.
func (l *InstanceLock) Release() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.released {
		return nil
	}
	l.released = true

	var errs []error
	if err := os.Remove(l.path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		errs = append(errs, fmt.Errorf("bridge: remove %s: %w", l.path, err))
	}
	if err := syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN); err != nil {
		errs = append(errs, fmt.Errorf("bridge: unlock %s: %w", l.path, err))
	}
	if err := l.f.Close(); err != nil {
		errs = append(errs, fmt.Errorf("bridge: close %s: %w", l.path, err))
	}
	return errors.Join(errs...)
}

// openPidFile returns the pid file, creating it if it does not exist yet.
// fresh reports whether this call created it, which is the only way to tell a
// first start from a takeover.
func openPidFile(path string) (f *os.File, fresh bool, err error) {
	f, err = os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err == nil {
		return f, true, nil
	}
	if !errors.Is(err, fs.ErrExist) {
		return nil, false, fmt.Errorf("bridge: create %s: %w", path, err)
	}
	f, err = os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		// fs.ErrNotExist is a race, not a failure; the caller retries.
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, err
		}
		return nil, false, fmt.Errorf("bridge: open %s: %w", path, err)
	}
	return f, false, nil
}

// flockNB takes an exclusive advisory lock without blocking.
//
// flock locks live on the open file description, so a second Acquire in this
// same process — two herdr-agent goroutines, or a test — is refused exactly as
// a second process would be.
func flockNB(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}

// stillAtPath reports whether f is the file currently named by path.
func stillAtPath(f *os.File, path string) (bool, error) {
	mine, err := f.Stat()
	if err != nil {
		return false, err
	}
	theirs, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	return os.SameFile(mine, theirs), nil
}

func writePid(f *os.File, pid int) error {
	if err := f.Truncate(0); err != nil {
		return fmt.Errorf("bridge: truncate %s: %w", f.Name(), err)
	}
	if _, err := f.Seek(0, 0); err != nil {
		return fmt.Errorf("bridge: rewind %s: %w", f.Name(), err)
	}
	if _, err := fmt.Fprintf(f, "%d\n", pid); err != nil {
		return fmt.Errorf("bridge: write %s: %w", f.Name(), err)
	}
	// The pid file is what a human reads after a crash to find out what was
	// running; an unflushed one reads as empty.
	if err := f.Sync(); err != nil {
		return fmt.Errorf("bridge: sync %s: %w", f.Name(), err)
	}
	return nil
}

// readPid parses the recorded pid. It never fails the acquisition: a pid file
// truncated by a crash mid-write is still a lock we may take over.
func readPid(f *os.File) (int, bool) {
	if _, err := f.Seek(0, 0); err != nil {
		return 0, false
	}
	buf := make([]byte, 32)
	n, err := f.Read(buf)
	if n <= 0 || (err != nil && n == 0) {
		return 0, false
	}
	pid, convErr := strconv.Atoi(strings.TrimSpace(string(buf[:n])))
	if convErr != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

func pidText(pid int) string {
	if pid <= 0 {
		return "unknown"
	}
	return strconv.Itoa(pid)
}

// processAlive reports whether pid names a live process. Signal 0 performs the
// permission and existence checks without delivering anything; EPERM means the
// process exists but belongs to somebody else.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = p.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}
