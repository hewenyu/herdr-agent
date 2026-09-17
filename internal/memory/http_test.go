package memory

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestHTTPContractPreservesPrefixScopeAndEntry(t *testing.T) {
	wantScope := Scope{OwnerID: "alice", ChatID: "chat", TaskID: "task"}
	wantEntry := Entry{Summary: "记住用户的否定与待确认问题", Revision: "revision-1"}
	var stored *Entry
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer local-test-key" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("incorrect method or headers")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var req wireRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Scope != wantScope {
			t.Errorf("scope = %+v, err = %v", req.Scope, err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		switch r.URL.Path {
		case "/proxy/memory/store":
			if req.Entry == nil || *req.Entry != wantEntry {
				t.Errorf("store entry = %+v", req.Entry)
			}
			stored = req.Entry
			w.WriteHeader(http.StatusCreated)
		case "/proxy/memory/recall":
			if req.Entry != nil {
				t.Error("recall sent an entry")
			}
			if stored == nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(stored)
		case "/proxy/memory/forget":
			if req.Entry != nil {
				t.Error("forget sent an entry")
			}
			stored = nil
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("prefix lost: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	p, err := NewHTTP(server.URL+"/proxy/memory/", "local-test-key", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if got, err := p.Recall(ctx, wantScope); err != nil || got != (Entry{}) {
		t.Fatalf("missing recall = %+v, %v", got, err)
	}
	if err := p.Store(ctx, wantScope, wantEntry); err != nil {
		t.Fatal(err)
	}
	if got, err := p.Recall(ctx, wantScope); err != nil || got != wantEntry {
		t.Fatalf("stored recall = %+v, %v", got, err)
	}
	if err := p.Forget(ctx, wantScope); err != nil {
		t.Fatal(err)
	}
	if got, err := p.Recall(ctx, wantScope); err != nil || got != (Entry{}) {
		t.Fatalf("forgotten recall = %+v, %v", got, err)
	}
}

func TestHTTPRejectsUnsafeConfiguration(t *testing.T) {
	for _, base := range []string{"", "ftp://example.com", "http://example.com", "https://user:password@example.com", "https://example.com?key=secret", "https://example.com?", "https://example.com#secret", "https:example.com"} {
		if _, err := NewHTTP(base, "key", time.Second); err == nil {
			t.Errorf("accepted unsafe URL %q", base)
		}
	}
	for _, base := range []string{"https://memory.example.com/v1", "http://127.0.0.1:1234", "http://[::1]:1234", "http://localhost:1234"} {
		if _, err := NewHTTP(base, "", time.Second); err != nil {
			t.Errorf("valid URL rejected: %q, %v", base, err)
		}
	}
	if _, err := NewHTTP("https://example.com", "secret\r\nX-Injected: yes", time.Second); err == nil {
		t.Fatal("invalid header key accepted")
	}
	if _, err := NewHTTP("https://example.com", "key", 0); err == nil {
		t.Fatal("zero timeout accepted")
	}
}

func TestHTTPNeverFollowsRedirectsOrLeaksServerErrors(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirected.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	secret := "DO-NOT-EXPOSE-THIS-KEY"
	for _, status := range []int{http.StatusTemporaryRedirect, http.StatusUnauthorized, http.StatusInternalServerError} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", target.URL+"/credential="+secret)
				w.WriteHeader(status)
				_, _ = w.Write([]byte("server echoed credential: " + secret))
			}))
			defer server.Close()
			p, err := NewHTTP(server.URL, secret, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			_, err = p.Recall(context.Background(), Scope{OwnerID: "alice", ChatID: "chat"})
			if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), server.URL) {
				t.Fatalf("unsafe error: %v", err)
			}
		})
	}
	if redirected.Load() != 0 {
		t.Fatal("redirected request reached another endpoint")
	}
}

func TestHTTPBoundsAndValidatesResponses(t *testing.T) {
	for _, body := range []string{"{}", "null", `{"summary":null}`, `{"summary":"ok"} trailing`, strings.Repeat("x", maxResponseBytes+1), `{"summary":"` + strings.Repeat("x", maxSummaryBytes+1) + `"}`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(body))
		}))
		p, err := NewHTTP(server.URL, "", time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := p.Recall(context.Background(), Scope{OwnerID: "alice", ChatID: "chat"}); err == nil {
			t.Error("invalid or oversized response accepted")
		}
		server.Close()
	}
}

func TestHTTPStatusCodeContract(t *testing.T) {
	for _, tc := range []struct {
		operation string
		status    int
		body      string
		wantErr   bool
	}{
		{"recall", http.StatusOK, `{"summary":"","revision":"v1"}`, false},
		{"recall", http.StatusNoContent, "", false},
		{"recall", http.StatusNotFound, "not found", false},
		{"recall", http.StatusCreated, `{"summary":"wrong status"}`, true},
		{"store", http.StatusOK, "", false},
		{"store", http.StatusCreated, "", false},
		{"store", http.StatusNoContent, "", false},
		{"store", http.StatusNotFound, "", true},
		{"forget", http.StatusOK, "", false},
		{"forget", http.StatusNoContent, "", false},
		{"forget", http.StatusNotFound, "", false},
		{"forget", http.StatusAccepted, "", true},
	} {
		t.Run(tc.operation+"/"+http.StatusText(tc.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			p, err := NewHTTP(server.URL, "", time.Second)
			if err != nil {
				t.Fatal(err)
			}
			scope := Scope{OwnerID: "alice", ChatID: "chat"}
			switch tc.operation {
			case "recall":
				_, err = p.Recall(context.Background(), scope)
			case "store":
				err = p.Store(context.Background(), scope, Entry{Summary: "summary"})
			case "forget":
				err = p.Forget(context.Background(), scope)
			}
			if (err != nil) != tc.wantErr {
				t.Fatalf("status %d resulted in %v, want error: %v", tc.status, err, tc.wantErr)
			}
		})
	}
}

func TestHTTPTimeoutAndCancellation(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	p, err := NewHTTP(server.URL, "", 20*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	scope := Scope{OwnerID: "alice", ChatID: "chat"}
	if _, err := p.Recall(context.Background(), scope); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := p.Forget(ctx, scope); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled request = %v", err)
	}
}
