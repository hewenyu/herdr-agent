package bridge

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/lark"
	sdk "github.com/larksuite/oapi-sdk-go/v3"
	"github.com/larksuite/oapi-sdk-go/v3/channel"
	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
	core "github.com/larksuite/oapi-sdk-go/v3/core"
)

// Exercise the real SDK throttle and HTTP handling. Its timer discards errors
// and clears itself before sending; a later successful Close is not a receipt.
func sdkFailingUpdates(t *testing.T) (*sdk.Client, <-chan struct{}) {
	t.Helper()
	failed := make(chan struct{}, 16)
	var patches atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "tenant_access_token"):
			io.WriteString(w, `{"code":0,"tenant_access_token":"local-test-token","expire":7200}`)
		case r.Method == http.MethodPut && r.URL.Path == "/open-apis/im/v1/messages/om_stream":
			if patches.Add(1) == 1 {
				io.WriteString(w, `{"code":0,"msg":"ok"}`)
			} else {
				io.WriteString(w, `{"code":230099,"msg":"update rejected"}`)
				failed <- struct{}{}
			}
		default:
			t.Errorf("unexpected SDK request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	client := sdk.NewClient("sdk-stream-test", "test-only", sdk.WithOpenBaseUrl(server.URL),
		sdk.WithHttpClient(server.Client()), sdk.WithLogLevel(core.LogLevelError))
	return client, failed
}

func awaitSDKUpdateFailure(t *testing.T, failed <-chan struct{}) {
	t.Helper()
	select {
	case <-failed:
	case <-time.After(5 * time.Second):
		t.Fatal("SDK did not attempt its scheduled background update")
	}
}

func sdkController(client *sdk.Client, initial string) *channel.MarkdownStreamController {
	cfg := types.DefaultChannelConfig()
	cfg.Outbound.StreamThrottleMs = 200 * time.Millisecond
	return channel.NewMarkdownStreamController(client, cfg, "om_stream", initial, "")
}

func TestSDKCloseCanSucceedAfterBackgroundHTTPFailure(t *testing.T) {
	client, failed := sdkFailingUpdates(t)
	stream := sdkController(client, "progress")
	ctx := context.Background()
	if err := stream.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if err := stream.Append(ctx, " final answer"); err != nil {
		t.Fatal(err)
	}
	awaitSDKUpdateFailure(t, failed)
	if err := stream.Close(ctx); err != nil {
		t.Fatalf("SDK behavior changed: Close now reports the background failure: %v", err)
	}
}

type sdkStreamBot struct {
	*fakeBot
	client *sdk.Client
}

func (b *sdkStreamBot) Stream(ctx context.Context, out lark.Out) (lark.Stream, error) {
	stream := sdkController(b.client, out.Markdown+out.Text)
	if err := stream.Flush(ctx); err != nil {
		return nil, err
	}
	return stream, nil
}

func TestCompletionRecoversFromRealSDKBackgroundHTTPFailure(t *testing.T) {
	client, failed := sdkFailingUpdates(t)
	h, a, turn, _ := completionFixture(t)
	h.b.deps.Bot = &sdkStreamBot{fakeBot: h.bot, client: client}
	ctx := context.Background()
	streams := map[string]*mirrorStream{}
	h.b.mirrorTurn(ctx, streams, assistantTurn("正在处理"))
	h.b.mirrorTurn(ctx, streams, turn)
	awaitSDKUpdateFailure(t, failed)
	h.b.closeAllMirrorStreams(ctx, streams)
	if err := h.b.PushDone(ctx, a, scrollback()); err != nil {
		t.Fatal(err)
	}
	sends := h.bot.sends()
	if len(sends) != 1 || sends[0].Err != nil || !strings.Contains(sends[0].Out.Card+sends[0].Out.Markdown+sends[0].Out.Text, turn.Turn.Text) {
		t.Fatalf("undelivered SDK final update did not reach completion recovery: %+v", sends)
	}
}
