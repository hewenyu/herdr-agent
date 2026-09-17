package memory

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type httpProvider struct {
	baseURL string
	apiKey  string
	client  *http.Client
}

type wireRequest struct {
	Scope Scope  `json:"scope"`
	Entry *Entry `json:"entry,omitempty"`
}

// NewHTTP uses a small exact-scope REST contract, not a vendor-specific memory
// API: POST <baseURL>/recall, /store, or /forget with {"scope": Scope} and, for
// store, "entry": Entry. Recall accepts an Entry JSON body on 200, or 204/404
// for no memory. Store accepts 200/201/204; forget accepts 200/204/404.
// The URL's path prefix is preserved. All redirects are rejected. A nonempty
// key is sent as Authorization: Bearer <key>; anonymous local services work too.
func NewHTTP(baseURL, key string, timeout time.Duration) (Provider, error) {
	u, err := url.Parse(baseURL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		(u.Scheme != "https" && u.Scheme != "http") || timeout <= 0 || strings.ContainsAny(key, "\r\n") {
		return nil, errConfiguration
	}
	if u.Scheme == "http" {
		ip := net.ParseIP(u.Hostname())
		if !strings.EqualFold(u.Hostname(), "localhost") && (ip == nil || !ip.IsLoopback()) {
			return nil, errConfiguration
		}
	}
	return &httpProvider{
		baseURL: strings.TrimRight(u.String(), "/"),
		apiKey:  key,
		client: &http.Client{
			Timeout: timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func (p *httpProvider) Recall(ctx context.Context, scope Scope) (Entry, error) {
	data, status, err := p.request(ctx, "recall", scope, nil)
	if err != nil {
		return Entry{}, err
	}
	switch status {
	case http.StatusNoContent, http.StatusNotFound:
		return Entry{}, nil
	case http.StatusOK:
		// A successful empty object is not a valid Entry. Missing memory uses
		// 204/404; a stored empty summary must still contain "summary".
		var wire struct {
			Summary  *string `json:"summary"`
			Revision string  `json:"revision,omitempty"`
		}
		if err := json.Unmarshal(data, &wire); err != nil || wire.Summary == nil {
			return Entry{}, errResponse
		}
		entry := Entry{Summary: *wire.Summary, Revision: wire.Revision}
		if !validEntry(entry) {
			return Entry{}, errResponse
		}
		return entry, nil
	default:
		return Entry{}, errRequest
	}
}

func (p *httpProvider) Store(ctx context.Context, scope Scope, entry Entry) error {
	if !validEntry(entry) {
		return errEntry
	}
	_, status, err := p.request(ctx, "store", scope, &entry)
	if err != nil {
		return err
	}
	if status != http.StatusOK && status != http.StatusCreated && status != http.StatusNoContent {
		return errRequest
	}
	return nil
}

func (p *httpProvider) Forget(ctx context.Context, scope Scope) error {
	_, status, err := p.request(ctx, "forget", scope, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK && status != http.StatusNoContent && status != http.StatusNotFound {
		return errRequest
	}
	return nil
}

func (p *httpProvider) request(ctx context.Context, operation string, scope Scope, entry *Entry) ([]byte, int, error) {
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	if !validScope(scope) {
		return nil, 0, errScope
	}
	data, err := json.Marshal(wireRequest{Scope: scope, Entry: entry})
	if err != nil || len(data) > maxResponseBytes {
		return nil, 0, errRequest
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/"+operation, bytes.NewReader(data))
	if err != nil {
		return nil, 0, errRequest
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if p.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.apiKey)
	}
	response, err := p.client.Do(req)
	if err != nil {
		return nil, 0, safeRequestError(ctx, err)
	}
	defer response.Body.Close()
	data, err = io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, 0, safeRequestError(ctx, err)
	}
	if len(data) > maxResponseBytes {
		return nil, 0, errResponse
	}
	return data, response.StatusCode, nil
}

func safeRequestError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	return errRequest
}
