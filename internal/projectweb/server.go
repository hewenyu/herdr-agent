// Package projectweb serves the local project configuration page and its API.
package projectweb

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/projects"
)

//go:embed assets/*
var assets embed.FS

type server struct {
	catalog             *projects.Catalog
	authorizationStatus func() AuthorizationStatus
	token               string
	page                []byte
	css                 []byte
	js                  []byte
}

type projectView struct {
	Name        string   `json:"name"`
	Directories []string `json:"directories"`
	Agent       string   `json:"agent"`
}

type settingsView struct {
	Root           string        `json:"root"`
	Bypass         bool          `json:"bypass"`
	DefaultProject string        `json:"default_project"`
	Projects       []projectView `json:"projects"`
}

type saveRequest struct {
	Directories []string `json:"directories"`
	Agent       string   `json:"agent"`
	MakeDefault bool     `json:"make_default"`
}

type createRequest struct {
	Name        string `json:"name"`
	Agent       string `json:"agent"`
	MakeDefault bool   `json:"make_default"`
}

// New returns a handler guarded against non-loopback and cross-origin requests.
// Serve should normally be used so the handler is also tied to the bound port.
func New(catalog *projects.Catalog, opts ...Option) (http.Handler, error) {
	if catalog == nil {
		return nil, errors.New("projectweb: project catalog is required")
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, fmt.Errorf("projectweb: generate CSRF token: %w", err)
	}
	page, err := assets.ReadFile("assets/index.html")
	if err != nil {
		return nil, err
	}
	css, err := assets.ReadFile("assets/style.css")
	if err != nil {
		return nil, err
	}
	js, err := assets.ReadFile("assets/app.js")
	if err != nil {
		return nil, err
	}
	token := hex.EncodeToString(secret[:])
	s := &server{catalog: catalog, token: token, page: bytes.ReplaceAll(page, []byte("__CSRF_TOKEN__"), []byte(token)), css: css, js: js}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.index)
	mux.HandleFunc("GET /assets/style.css", s.style)
	mux.HandleFunc("GET /assets/app.js", s.script)
	mux.HandleFunc("GET /api/projects", s.list)
	mux.HandleFunc("GET /api/feishu/authorization", s.authorization)
	mux.HandleFunc("PUT /api/settings", s.settings)
	mux.HandleFunc("POST /api/projects", s.create)
	mux.HandleFunc("PUT /api/projects/{name}", s.save)
	mux.HandleFunc("DELETE /api/projects/{name}", s.delete)
	return s.guard(mux), nil
}

// Serve binds only a literal loopback address and shuts down when ctx ends.
// onReady receives the actual local URL, including an allocated port for :0.
func Serve(ctx context.Context, addr string, catalog *projects.Catalog, onReady func(string), opts ...Option) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil || !isLoopback(host) || !validPort(port, true) {
		return fmt.Errorf("projectweb: address must be a loopback IP and port, for example 127.0.0.1:18790")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	handler, err := New(catalog, opts...)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("projectweb: listen: %w", err)
	}
	defer listener.Close()
	boundHost := listener.Addr().String()
	httpServer := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Host != boundHost {
				writeError(w, http.StatusForbidden, "只允许通过当前本地地址访问")
				return
			}
			handler.ServeHTTP(w, r)
		}),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := httpServer.Shutdown(shutdownCtx); err != nil {
				_ = httpServer.Close()
			}
		case <-finished:
		}
	}()
	if onReady != nil {
		onReady("http://" + boundHost)
	}
	if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func isLoopback(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func validPort(port string, allowZero bool) bool {
	n, err := strconv.Atoi(port)
	return err == nil && n <= 65535 && (n > 0 || allowZero && n == 0)
}

func (s *server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		host, port, err := net.SplitHostPort(r.Host)
		remote, _, remoteErr := net.SplitHostPort(r.RemoteAddr)
		if err != nil || !isLoopback(host) || !validPort(port, false) || remoteErr != nil || !isLoopback(remote) {
			writeError(w, http.StatusForbidden, "仅允许本机访问")
			return
		}
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		origin := r.Header.Get("Origin")
		if origin != "" && origin != scheme+"://"+r.Host {
			writeError(w, http.StatusForbidden, "不允许跨站访问")
			return
		}
		if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
			writeError(w, http.StatusForbidden, "不允许跨站访问")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if origin == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(s.token)) != 1 {
				writeError(w, http.StatusForbidden, "页面验证已失效，请刷新后重试")
				return
			}
			mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			if err != nil || mediaType != "application/json" {
				writeError(w, http.StatusUnsupportedMediaType, "请求必须使用 JSON")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) index(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(s.page)
}

func (s *server) style(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	_, _ = w.Write(s.css)
}

func (s *server) script(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	_, _ = w.Write(s.js)
}

func (s *server) snapshot() settingsView {
	tasks := s.catalog.Snapshot()
	view := settingsView{Root: s.catalog.Root(), Bypass: tasks.Bypass, DefaultProject: tasks.DefaultProject, Projects: make([]projectView, 0, len(tasks.Projects))}
	for name, project := range tasks.Projects {
		dirs := project.Directories
		if len(dirs) == 0 && project.Path != "" {
			dirs = []string{project.Path}
		}
		view.Projects = append(view.Projects, projectView{Name: name, Directories: dirs, Agent: project.Agent})
	}
	sort.Slice(view.Projects, func(i, j int) bool { return view.Projects[i].Name < view.Projects[j].Name })
	return view
}

func (s *server) list(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.snapshot())
}

func (s *server) settings(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Bypass *bool `json:"bypass"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	if input.Bypass == nil {
		writeError(w, http.StatusBadRequest, "请指定 Bypass 模式是否启用")
		return
	}
	if err := s.catalog.SetBypass(*input.Bypass); err != nil {
		catalogError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.snapshot())
}

func (s *server) save(w http.ResponseWriter, r *http.Request) {
	var input saveRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := s.catalog.Put(r.PathValue("name"), config.Project{Directories: input.Directories, Agent: input.Agent}, input.MakeDefault); err != nil {
		catalogError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.snapshot())
}

func (s *server) create(w http.ResponseWriter, r *http.Request) {
	var input createRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	if _, err := s.catalog.Create(r.Context(), input.Name, input.Agent, input.MakeDefault); err != nil {
		catalogError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, s.snapshot())
}

func (s *server) delete(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if !decodeJSON(w, r, &input) {
		return
	}
	if err := s.catalog.Delete(r.PathValue("name")); err != nil {
		catalogError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.snapshot())
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		writeError(w, http.StatusBadRequest, "JSON 格式无效或请求过大")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeError(w, http.StatusBadRequest, "请求只能包含一个 JSON 对象")
		return false
	}
	return true
}

func catalogError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, config.ErrTaskProjectName), errors.Is(err, config.ErrTaskProjectPath), errors.Is(err, config.ErrTaskProjectAgent):
		status = http.StatusBadRequest
	case errors.Is(err, projects.ErrExists):
		status = http.StatusConflict
	case errors.Is(err, projects.ErrNotFound):
		status = http.StatusNotFound
	}
	writeError(w, status, strings.TrimSpace(err.Error()))
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
