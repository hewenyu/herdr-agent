package projectweb

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/projects"
)

type fixture struct {
	Handler http.Handler
	Catalog *projects.Catalog
	State   string
	Token   string
}

const localURL = "http://127.0.0.1:18790"

func setup(t *testing.T, opts ...Option) fixture {
	t.Helper()
	state := t.TempDir()
	catalog, err := projects.Open(state, config.Tasks{Bypass: true})
	if err != nil {
		t.Fatal(err)
	}
	handler, err := New(catalog, opts...)
	if err != nil {
		t.Fatal(err)
	}
	f := fixture{Handler: handler, Catalog: catalog, State: state}
	page := f.request(t, "GET", "/", "", nil)
	if page.Code != http.StatusOK {
		t.Fatalf("page status: %d", page.Code)
	}
	match := regexp.MustCompile(`name="csrf-token" content="([a-f0-9]{64})"`).FindStringSubmatch(page.Body.String())
	if len(match) != 2 {
		t.Fatal("page does not contain a CSRF token")
	}
	f.Token = match[1]
	return f
}

func (f fixture) request(t *testing.T, method, path, body string, modify func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, localURL+path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:42000"
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	if method != "GET" {
		r.Header.Set("Origin", localURL)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF-Token", f.Token)
	}
	if modify != nil {
		modify(r)
	}
	w := httptest.NewRecorder()
	f.Handler.ServeHTTP(w, r)
	return w
}

func bodyJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func viewFrom(t *testing.T, w *httptest.ResponseRecorder) settingsView {
	t.Helper()
	var result settingsView
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestProjectAPIPersistsOrderedDirectoriesAndDefault(t *testing.T) {
	f := setup(t)
	dir1, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	dir2, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	save := f.request(t, "PUT", "/api/projects/product", bodyJSON(t, saveRequest{Directories: []string{dir1, dir2}, Agent: "claude", MakeDefault: true}), nil)
	if save.Code != http.StatusOK {
		t.Fatalf("save: %d %s", save.Code, save.Body.String())
	}
	view := viewFrom(t, save)
	if view.DefaultProject != "product" || len(view.Projects) != 1 || view.Projects[0].Agent != "claude" || !reflect.DeepEqual(view.Projects[0].Directories, []string{dir1, dir2}) {
		t.Fatalf("unexpected project view: %+v", view)
	}
	// Reordering changes the primary directory and survives a fresh catalog load.
	reorder := f.request(t, "PUT", "/api/projects/product", bodyJSON(t, saveRequest{Directories: []string{dir2, dir1}, Agent: "codex"}), nil)
	if reorder.Code != http.StatusOK {
		t.Fatalf("reorder: %d %s", reorder.Code, reorder.Body.String())
	}
	reopened, err := projects.Open(f.State, config.Tasks{})
	if err != nil {
		t.Fatal(err)
	}
	saved := reopened.Snapshot().Projects["product"]
	if saved.Path != dir2 || saved.Agent != "codex" || !reflect.DeepEqual(saved.Directories, []string{dir2, dir1}) {
		t.Fatalf("reopened project: %+v", saved)
	}
	remove := f.request(t, "DELETE", "/api/projects/product", "{}", nil)
	if remove.Code != http.StatusOK || len(viewFrom(t, remove).Projects) != 0 {
		t.Fatalf("delete: %d %s", remove.Code, remove.Body.String())
	}
	for _, path := range []string{dir1, dir2} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("deleting configuration affected directory: %v", err)
		}
	}
	reopened, err = projects.Open(f.State, config.Tasks{})
	if err != nil || len(reopened.Snapshot().Projects) != 0 {
		t.Fatalf("deleted project returned on reload: %v", err)
	}
}

func TestInvalidProjectSaveNeverCreatesDirectories(t *testing.T) {
	f := setup(t)
	missing := filepath.Join(t.TempDir(), "must-not-be-created")
	w := f.request(t, "PUT", "/api/projects/missing", bodyJSON(t, saveRequest{Directories: []string{missing}, Agent: "codex"}), nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing directory: %d %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("ordinary save must not create a folder: %v", err)
	}
	if len(f.Catalog.Snapshot().Projects) != 0 {
		t.Fatal("invalid project persisted")
	}
}

func TestGlobalBypassPersistsAndRequiresExplicitBoolean(t *testing.T) {
	f := setup(t)
	initial := f.request(t, "GET", "/api/projects", "", nil)
	if !viewFrom(t, initial).Bypass {
		t.Fatal("initial bypass should come from catalog")
	}
	for _, bad := range []string{`{}`, `{"bypass":null}`, `{"bypass":"false"}`} {
		w := f.request(t, "PUT", "/api/settings", bad, nil)
		if w.Code != http.StatusBadRequest || !f.Catalog.Snapshot().Bypass {
			t.Fatalf("invalid bypass request changed setting: %d %s", w.Code, w.Body.String())
		}
	}
	w := f.request(t, "PUT", "/api/settings", `{"bypass":false}`, nil)
	if w.Code != http.StatusOK || viewFrom(t, w).Bypass {
		t.Fatalf("disable bypass: %d %s", w.Code, w.Body.String())
	}
	reopened, err := projects.Open(f.State, config.Tasks{Bypass: true})
	if err != nil || reopened.Snapshot().Bypass {
		t.Fatalf("bypass false did not persist: %v", err)
	}
}

func TestLocalSecurityGuardRejectsCrossSiteAndRebinding(t *testing.T) {
	f := setup(t)
	for _, test := range []struct {
		name   string
		method string
		modify func(*http.Request)
	}{
		{"dns rebinding host", "GET", func(r *http.Request) { r.Host = "evil.example:18790" }},
		{"non-loopback peer", "GET", func(r *http.Request) { r.RemoteAddr = "10.0.0.2:46000" }},
		{"cross-origin read", "GET", func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }},
		{"cross-site navigation", "GET", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }},
		{"same-site different port", "PUT", func(r *http.Request) { r.Header.Set("Origin", "http://127.0.0.1:1234") }},
		{"no origin", "PUT", func(r *http.Request) { r.Header.Del("Origin") }},
		{"null origin", "PUT", func(r *http.Request) { r.Header.Set("Origin", "null") }},
		{"no csrf", "PUT", func(r *http.Request) { r.Header.Del("X-CSRF-Token") }},
		{"wrong csrf", "PUT", func(r *http.Request) { r.Header.Set("X-CSRF-Token", strings.Repeat("a", 64)) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := "/api/projects"
			if test.method == "PUT" {
				path = "/api/settings"
			}
			w := f.request(t, test.method, path, `{"bypass":false}`, test.modify)
			if w.Code != http.StatusForbidden {
				t.Fatalf("security guard accepted request: %d %s", w.Code, w.Body.String())
			}
			if w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatal("must not grant cross-origin access")
			}
			if !f.Catalog.Snapshot().Bypass {
				t.Fatal("blocked request changed configuration")
			}
		})
	}
	// Cross-site requests cannot obtain the token from the HTML page either.
	w := f.request(t, "GET", "/", "", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") })
	if w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), f.Token) {
		t.Fatal("page exposed its token to cross-site navigation")
	}
}

func TestMutationRejectsNonJSONAndMalformedBodies(t *testing.T) {
	f := setup(t)
	for _, test := range []struct {
		name string
		body string
		mime string
		code int
	}{
		{"form", "bypass=false", "application/x-www-form-urlencoded", http.StatusUnsupportedMediaType},
		{"text", `{"bypass":false}`, "text/plain", http.StatusUnsupportedMediaType},
		{"unknown field", `{"bypass":false,"shell":"anything"}`, "application/json", http.StatusBadRequest},
		{"trailing document", `{"bypass":false}{}`, "application/json", http.StatusBadRequest},
		{"oversize", `{"bypass":false,"value":"` + strings.Repeat("a", 65<<10) + `"}`, "application/json", http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := f.request(t, "PUT", "/api/settings", test.body, func(r *http.Request) { r.Header.Set("Content-Type", test.mime) })
			if w.Code != test.code || !f.Catalog.Snapshot().Bypass {
				t.Fatalf("invalid request: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestCreateEndpointRejectsDuplicateAndTraversal(t *testing.T) {
	f := setup(t)
	if err := f.Catalog.Put("existing", config.Project{Path: t.TempDir(), Agent: "codex"}, true); err != nil {
		t.Fatal(err)
	}
	w := f.request(t, "POST", "/api/projects", `{"name":"existing","agent":"codex"}`, nil)
	if w.Code != http.StatusConflict {
		t.Fatalf("duplicate project: %d %s", w.Code, w.Body.String())
	}
	w = f.request(t, "POST", "/api/projects", `{"name":"../outside","agent":"codex"}`, nil)
	if w.Code != http.StatusBadRequest || len(f.Catalog.Snapshot().Projects) != 1 {
		t.Fatalf("path traversal project: %d %s", w.Code, w.Body.String())
	}
	w = f.request(t, "DELETE", "/api/projects/not-here", `{}`, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing delete: %d %s", w.Code, w.Body.String())
	}
}

func TestEmbeddedAssetsAndPerHandlerToken(t *testing.T) {
	f := setup(t)
	other := setup(t)
	if f.Token == other.Token {
		t.Fatal("CSRF tokens must not be shared across server instances")
	}
	for _, path := range []string{"/", "/assets/style.css", "/assets/app.js"} {
		w := f.request(t, "GET", path, "", nil)
		if w.Code != http.StatusOK || w.Body.Len() == 0 || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatalf("asset %s: status %d headers %v", path, w.Code, w.Header())
		}
	}
	if _, err := New(nil); err == nil {
		t.Fatal("nil catalog accepted")
	}
}

func TestServeBindsLoopbackChecksPortAndStops(t *testing.T) {
	f := setup(t)
	for _, addr := range []string{":18790", "0.0.0.0:18790", "[::]:18790", "192.168.1.1:18790", "localhost:18790", "127.0.0.1:-1", "127.0.0.1:65536"} {
		if err := Serve(context.Background(), addr, f.Catalog, nil); err == nil {
			t.Fatalf("accepted unsafe or invalid address %q", addr)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, "127.0.0.1:0", f.Catalog, func(url string) { ready <- url }, WithAuthorizationStatus(func() AuthorizationStatus {
			return AuthorizationStatus{State: "ready", Message: "权限检查通过"}
		}))
	}()
	var base string
	select {
	case base = <-ready:
	case err := <-done:
		t.Fatalf("server did not start: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("server start timed out")
	}
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Get(base + "/api/projects")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("local GET: %d", response.StatusCode)
	}
	response, err = client.Get(base + "/api/feishu/authorization")
	if err != nil {
		t.Fatal(err)
	}
	var authorization AuthorizationStatus
	err = json.NewDecoder(response.Body).Decode(&authorization)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || authorization.State != "ready" {
		t.Fatalf("Serve did not apply authorization option: status=%d value=%+v err=%v", response.StatusCode, authorization, err)
	}
	request, err := http.NewRequest("GET", base+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Host = "127.0.0.1:1"
	response, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("server accepted a different Host port: %d", response.StatusCode)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(fmt.Errorf("server shutdown: %w", err))
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server did not stop on cancellation")
	}
}
