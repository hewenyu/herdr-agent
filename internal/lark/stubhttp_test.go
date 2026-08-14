package lark

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
)

// stubHTTP stands in for Feishu's REST API. Every test in this package is
// offline: nothing here opens a socket, and any path the tests did not
// anticipate comes back as an error rather than silently succeeding.
type stubHTTP struct {
	mu    sync.Mutex
	calls []stubCall

	// sendResp overrides the reply to POST /open-apis/im/v1/messages.
	sendResp string
	// patchStatus overrides the Feishu code returned by PATCH.
	patchCode int
}

type stubCall struct {
	Method string
	Path   string
	Query  string
	Body   string
}

const (
	// stubBotOpenID is the id the bridge is CONFIGURED with (WithBotOpenID).
	stubBotOpenID = "ou_bot_self"
	// stubSDKIdentityOpenID is what /open-apis/bot/v3/info answers, and it is
	// deliberately a different value.
	//
	// channelImpl has a self-echo filter of its own, keyed on the identity it
	// fetches from that endpoint. If the stub returned stubBotOpenID, the SDK
	// would drop the bot's own messages before our filter ever ran, and any
	// end-to-end test of self-echo would pass with our filter deleted. The SDK
	// filter is exactly the one we cannot rely on — GetBotIdentity is a REST
	// call that fails silently and then forwards everything — so the tests
	// must exercise ours. Divergent ids make that the only possibility.
	stubSDKIdentityOpenID = "ou_bot_sdk_identity"
	stubSentMsgID         = "om_sent_1"
)

func (s *stubHTTP) Do(r *http.Request) (*http.Response, error) {
	var body []byte
	if r.Body != nil {
		body, _ = io.ReadAll(r.Body)
	}

	s.mu.Lock()
	s.calls = append(s.calls, stubCall{
		Method: r.Method,
		Path:   r.URL.Path,
		Query:  r.URL.RawQuery,
		Body:   string(body),
	})
	sendResp, patchCode := s.sendResp, s.patchCode
	s.mu.Unlock()

	respond := func(payload string) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(payload)),
			Request:    r,
		}, nil
	}

	path := r.URL.Path
	switch {
	case strings.Contains(path, "tenant_access_token"):
		return respond(`{"code":0,"msg":"ok","tenant_access_token":"t-stub","expire":7200}`)

	case path == "/open-apis/bot/v3/info":
		return respond(`{"code":0,"msg":"ok","bot":{"open_id":"` + stubSDKIdentityOpenID +
			`","app_name":"herdr","activate_status":2}}`)

	case r.Method == http.MethodPatch && strings.HasPrefix(path, "/open-apis/im/v1/messages/"):
		if patchCode != 0 {
			b, _ := json.Marshal(map[string]any{"code": patchCode, "msg": "stub patch refused"})
			return respond(string(b))
		}
		return respond(`{"code":0,"msg":"success"}`)

	case r.Method == http.MethodPost && path == "/open-apis/im/v1/messages":
		if sendResp != "" {
			return respond(sendResp)
		}
		return respond(`{"code":0,"msg":"success","data":{"message_id":"` + stubSentMsgID +
			`","chat_id":"oc_test"}}`)
	}

	return respond(`{"code":99999,"msg":"stub: unexpected ` + r.Method + " " + path + `"}`)
}

func (s *stubHTTP) snapshot() []stubCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]stubCall(nil), s.calls...)
}

// find returns the first recorded call whose method and path prefix match.
func (s *stubHTTP) find(method, pathPrefix string) (stubCall, bool) {
	for _, c := range s.snapshot() {
		if c.Method == method && strings.HasPrefix(c.Path, pathPrefix) {
			return c, true
		}
	}
	return stubCall{}, false
}

// bodyField pulls a top-level string field out of a recorded JSON body.
func (c stubCall) bodyField(name string) string {
	var m map[string]json.RawMessage
	if err := json.NewDecoder(bytes.NewReader([]byte(c.Body))).Decode(&m); err != nil {
		return ""
	}
	raw, ok := m[name]
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return string(raw)
	}
	return s
}
