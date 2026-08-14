package bridge

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func readPidFile(t *testing.T, path string) int {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("pid file %s contains %q: %v", path, raw, err)
	}
	return pid
}

// deadPID finds a pid that is certainly not running, without spawning
// anything. Values beyond the platform's pid ceiling can never exist; each
// candidate is verified rather than assumed.
func deadPID(t *testing.T) int {
	t.Helper()
	for _, pid := range []int{4194305, 999983, 888887, 777773} {
		if !processAlive(pid) {
			return pid
		}
	}
	t.Skip("no verifiably dead pid available on this machine")
	return 0
}

func TestAcquireInstanceLockWritesAPrivatePidFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")

	lock, err := AcquireInstanceLock(dir, WithLockLogger(discardLogger()))
	if err != nil {
		t.Fatalf("AcquireInstanceLock: %v", err)
	}
	defer func() { _ = lock.Release() }()

	if got, want := lock.Path(), filepath.Join(dir, PidFileName); got != want {
		t.Errorf("Path() = %q, want %q", got, want)
	}
	if got := readPidFile(t, lock.Path()); got != os.Getpid() {
		t.Errorf("pid file records %d, want this process %d", got, os.Getpid())
	}

	info, err := os.Stat(lock.Path())
	if err != nil {
		t.Fatal(err)
	}
	// Everything in the state directory is 0600 (S2 §3.1): reaching this
	// bridge is equivalent to shell access on the machine (G10).
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("pid file mode = %o, want 600", perm)
	}
}

// TestSecondInstanceIsRefused is the G15 regression guard.
//
// Long-connection delivery is cluster mode — up to 50 connections per app, each
// event dealt to a randomly chosen one — so two bridges on one app_id do not
// fail loudly and do not disconnect each other. They each receive about half the
// events, which the user reports as "Feishu is flaky" and cannot falsify from
// the outside. The second one must therefore die here, before any network I/O,
// because nothing afterwards would reveal it.
func TestSecondInstanceIsRefused(t *testing.T) {
	dir := t.TempDir()

	first, err := AcquireInstanceLock(dir, WithLockLogger(discardLogger()))
	if err != nil {
		t.Fatalf("first AcquireInstanceLock: %v", err)
	}
	defer func() { _ = first.Release() }()

	second, err := AcquireInstanceLock(dir, WithLockLogger(discardLogger()))
	if err == nil {
		_ = second.Release()
		t.Fatal("a second instance acquired the lock; it would join the first one in this app's connection " +
			"pool and quietly take a random half of the events")
	}
	if !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("err = %v, want ErrAlreadyRunning", err)
	}
	// The message has to name the holder: the user's next step is to stop it.
	if !strings.Contains(err.Error(), strconv.Itoa(os.Getpid())) {
		t.Errorf("error does not name the holding pid: %v", err)
	}

	// The first lock is untouched: its pid file still says who owns it.
	if got := readPidFile(t, first.Path()); got != os.Getpid() {
		t.Errorf("pid file was rewritten by the refused instance: %d", got)
	}
}

// TestStaleLockIsTakenOver covers the crash case. flock is released by the
// kernel however the holder died, so a pid file whose process is gone is stale
// by definition — and requiring a manual `rm` after a power cut would be a
// worse failure than the one it guards against.
func TestStaleLockIsTakenOver(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, PidFileName)
	stale := deadPID(t)
	if err := os.WriteFile(path, []byte(strconv.Itoa(stale)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	lock, err := AcquireInstanceLock(dir, WithLockLogger(discardLogger()))
	if err != nil {
		t.Fatalf("stale lock was treated as fatal: %v", err)
	}
	defer func() { _ = lock.Release() }()

	if got := readPidFile(t, path); got != os.Getpid() {
		t.Errorf("pid file still records %d, want the new owner %d", got, os.Getpid())
	}
}

// TestTakeoverIgnoresALivePidWithoutTheLock pins down which of the two signals
// is authoritative. A pid can be reused by an unrelated process; the flock
// cannot be. If the recorded pid won, a recycled number would lock the user out
// of their own bridge with no recovery except deleting the file by hand.
func TestTakeoverIgnoresALivePidWithoutTheLock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, PidFileName)
	// This process is certainly alive, and just as certainly not holding the
	// lock: nothing has taken it in this test.
	if err := os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	lock, err := AcquireInstanceLock(dir, WithLockLogger(discardLogger()))
	if err != nil {
		t.Fatalf("an unlocked pid file blocked startup: %v", err)
	}
	_ = lock.Release()
}

func TestReleaseFreesTheLockAndRemovesThePidFile(t *testing.T) {
	dir := t.TempDir()

	first, err := AcquireInstanceLock(dir, WithLockLogger(discardLogger()))
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if _, err := os.Stat(first.Path()); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("pid file survived Release: %v", err)
	}

	second, err := AcquireInstanceLock(dir, WithLockLogger(discardLogger()))
	if err != nil {
		t.Fatalf("could not re-acquire after Release: %v", err)
	}
	if err := second.Release(); err != nil {
		t.Fatalf("second Release: %v", err)
	}
}

func TestReleaseIsIdempotent(t *testing.T) {
	lock, err := AcquireInstanceLock(t.TempDir(), WithLockLogger(discardLogger()))
	if err != nil {
		t.Fatal(err)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("first Release: %v", err)
	}
	// A second Release happens for real: the signal handler releases, then the
	// deferred cleanup runs. It must not report a spurious failure, and it must
	// not delete a pid file another instance has since created.
	if err := lock.Release(); err != nil {
		t.Fatalf("second Release: %v", err)
	}
}

func TestReleaseDoesNotDeleteAnotherInstancesPidFile(t *testing.T) {
	dir := t.TempDir()

	first, err := AcquireInstanceLock(dir, WithLockLogger(discardLogger()))
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	second, err := AcquireInstanceLock(dir, WithLockLogger(discardLogger()))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = second.Release() }()

	if err := first.Release(); err != nil {
		t.Fatalf("stale Release: %v", err)
	}
	if _, err := os.Stat(second.Path()); err != nil {
		t.Errorf("the second instance's pid file was removed by the first one's Release: %v", err)
	}
}

func TestAcquireInstanceLockRejectsAnEmptyDir(t *testing.T) {
	for _, dir := range []string{"", "   "} {
		if _, err := AcquireInstanceLock(dir); !errors.Is(err, ErrNoStateDir) {
			t.Errorf("AcquireInstanceLock(%q) = %v, want ErrNoStateDir", dir, err)
		}
	}
}

func TestAcquireInstanceLockCreatesTheStateDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "state")

	lock, err := AcquireInstanceLock(dir, WithLockLogger(discardLogger()))
	if err != nil {
		t.Fatalf("AcquireInstanceLock: %v", err)
	}
	defer func() { _ = lock.Release() }()

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o700 {
		t.Errorf("state dir mode = %o, want 700", perm)
	}
}
